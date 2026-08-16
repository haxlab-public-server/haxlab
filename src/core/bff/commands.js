/*
 * BFF's own !me/!tops/!help — deliberately NOT commands/player.js's
 * globalStatsCommand/topsCommand/helpCommand: those are wired for the main
 * room's full feature set (clubs, trophies, economy help sections). This is
 * the "no economy/mini-games, just moderation + stats + rating" surface
 * actually confirmed for BFF. !vipcolor (added 2026-08-16) IS forked in
 * here though, verbatim from commands/player.js's own — a real parity gap
 * (BFF VIPs had !viphide but no way to actually pick a color) rather than a
 * scope mismatch like the economy/club stuff above.
 */
const createPrintStats = require('../stats/print');
const { formatRatingDisplay } = require('../utils');

// Ranked-match window for !sf's "за последние N игр" rating trend.
const RATING_TREND_MATCHES = 5;

module.exports = function createBffCommands({
    room,
    state,
    authArray,
    db,
    HaxStatistics,
    HaxNotification,
    Role,
    infoColor,
    errorColor,
    successColor,
    getTimeStats,
    getRole,
    computeOrdinal,
    bffRoomStats,
    hiddenVipSet,
    teamSize,
    matchFlow,
    formatBanRemaining,
    upCooldownMs = 60 * 60 * 1000,
    upDailyMaxUses = 3,
    upDailyWindowMs = 24 * 60 * 60 * 1000,
}) {
    const { printPlayerStats } = createPrintStats({ getTimeStats, db });

    // !me — compact one-liner (requested 2026-08-16: bare !me should be the
    // quick glance — name, rating, win rate — not the full stat dump this
    // used to always show). The full per-stat-rank block (with a rating
    // trend on top) moved to !sf/!ыа below.
    async function meCommand(player) {
        const auth = authArray[player.id][0];
        const stats = (await db.getPlayerStats(auth)) ?? new HaxStatistics(player.name);
        const rating = await db.getRating(auth);
        const ratingText = rating ? `⚔️ ${formatRatingDisplay(computeOrdinal(rating))}` : '⚔️ ещё не оценён';
        // ⭐ badge (requested 2026-08-16) — !tops already marks VIP entries
        // this way, !me previously didn't show VIP status at all.
        const vipBadge = getRole(player) >= Role.VIP ? '⭐ ' : '';
        room.sendAnnouncement(
            `${vipBadge}${stats.playerName} | ${ratingText} | 🏆 ${stats.winrate} (${stats.wins}/${stats.games})`,
            player.id, infoColor, 'bold', HaxNotification.CHAT
        );
    }

    // !sf (!ыа — "sf" typed on a Russian keyboard layout, same "wrong
    // layout" alias convention already used for !afk's "фал") — the full
    // detailed block !me used to always show (stats/print.js's
    // printPlayerStats: per-stat ranks, plus the rating line only appearing
    // when ratingOrdinal is set, which only ever happens here), now with a
    // rating trend line added on top.
    async function statsFullCommand(player) {
        const auth = authArray[player.id][0];
        const stats = (await db.getPlayerStats(auth)) ?? new HaxStatistics(player.name);
        const rating = await db.getRating(auth);
        if (rating) stats.ratingOrdinal = computeOrdinal(rating);
        stats.isVip = getRole(player) >= Role.VIP;
        const statsString = await printPlayerStats(stats);
        // null (not 0) from getRecentRatingDelta means "no ranked match
        // history at all yet" — omit the line entirely rather than show a
        // misleading "+0" for someone who's never actually played one.
        const recentDelta = await db.getRecentRatingDelta(auth, RATING_TREND_MATCHES);
        const trendLine = recentDelta != null
            ? `\nЗа последние ${RATING_TREND_MATCHES} игр: ${recentDelta > 0 ? '+' : ''}${recentDelta}`
            : '';
        room.sendAnnouncement(statsString + trendLine, player.id, infoColor, 'bold', HaxNotification.CHAT);
    }

    // !rename [имя] — forked verbatim from commands/player.js's
    // renameCommand (fully generic, no economy/club coupling). No argument
    // resets it back to the player's current in-room name.
    async function renameCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = authArray[player.id][0];
        const stats = await db.getPlayerStats(auth);
        if (stats) {
            stats.playerName = msgArray.length == 0 ? player.name : msgArray.join(' ');
            await db.savePlayerStats(auth, stats);
            room.sendAnnouncement(`Вы успешно переименовали себя на ${stats.playerName} !`, player.id, successColor, 'bold', HaxNotification.CHAT);
        } else {
            room.sendAnnouncement(`Вы еще не играли в этой комнате !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
        }
    }

    // !bb (bye/gn/cya/ии) — same instant self-kick as the main room's own
    // commands/player.js leaveCommand, same message.
    function leaveCommand(player) {
        room.kickPlayer(player.id, 'Пока !', false);
    }

    const TOPS_STAT_KEYS = ['games', 'wins', 'goals', 'assists', 'cs', 'playtime', 'rating'];

    // !tops [category] — no 'clubs' option at all (BFF has none), 'rating'
    // added as its own category alongside the ordinary stat ones.
    async function topsCommand(player, message) {
        const key = message.split(/ +/)[1]?.toLowerCase();
        if (!key) {
            await bffRoomStats.printAllRankings(player.id);
            return;
        }
        if (!TOPS_STAT_KEYS.includes(key)) {
            room.sendAnnouncement(
                `Использование: !tops [games|wins|goals|assists|cs|playtime|rating]. Без аргумента показывает все таблицы лидеров сразу.`,
                player.id, errorColor, 'bold', HaxNotification.CHAT
            );
            return;
        }
        await bffRoomStats.printRankings(key === 'cs' ? 'CS' : key === 'pt' ? 'playtime' : key, player.id);
    }

    // !vipcolor — forked verbatim from commands/player.js's own (requested
    // 2026-08-16: BFF VIPs could !viphide but never actually picked a
    // color in the first place, unlike the main room). Own file, own
    // independent color map — see state.vipColors' own declaration in
    // bffEntry.js.
    async function vipColorCommand(player, message) {
        const auth = authArray[player.id][0];
        const hex = message.split(/ +/)[1];
        if (!hex) {
            await db.setVipColor(auth, null);
            delete state.vipColors[auth];
            room.sendAnnouncement(`✔️ Ваш VIP-цвет сброшен на стандартный !`, player.id, successColor, 'bold', HaxNotification.CHAT);
            return;
        }
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {
            room.sendAnnouncement(
                `Использование: !vipcolor <hex>. Введите "!vipcolor" без аргумента, чтобы сбросить цвет. Пример: !vipcolor ff8800.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const color = parseInt(hex, 16);
        await db.setVipColor(auth, color);
        state.vipColors[auth] = color;
        room.sendAnnouncement(`✔️ Ваш VIP-цвет обновлен !`, player.id, successColor, 'bold', HaxNotification.CHAT);
    }

    // !viphide — same shape as the main room's commands/admin.js hideCommand
    // (and its own core/bff/chatGuard.js !hide for BFF admins), but
    // VIP-specific and simpler: VIP has no native room badge to also
    // toggle, just the one Set bffEntry.js's own onPlayerChat prefix logic
    // already checks (see its own comment there).
    // Persisted (requested 2026-08-16: survive a restart) and keyed by auth,
    // not player.id — see hiddenVipSet's own declaration in bffEntry.js.
    async function vipHideCommand(player) {
        const auth = authArray[player.id][0];
        if (hiddenVipSet.has(auth)) {
            hiddenVipSet.delete(auth);
            await db.setHiddenVip(auth, false);
            room.sendAnnouncement(`👁️ Скрытность отключена — VIP-префикс снова виден.`, player.id, successColor, 'bold', HaxNotification.CHAT);
        } else {
            hiddenVipSet.add(auth);
            await db.setHiddenVip(auth, true);
            room.sendAnnouncement(`🕶️ Скрытность включена — VIP-префикс скрыт.`, player.id, successColor, 'bold', HaxNotification.CHAT);
        }
    }

    // !queue (!q) — shows a spectating player their own position in the
    // fairness queue (see matchFlow.js's specQueueSince sort), so waiting
    // isn't a black box. 2*teamSize as the "next match" cutoff matches
    // exactly what assembleMatch's own STOP-state branch slices off the
    // front of the same sorted queue.
    function queueCommand(player) {
        if (state.teamSpec.every((p) => p.id !== player.id)) {
            room.sendAnnouncement(`Вы сейчас не в очереди — вы либо уже играете, либо не в комнате.`, player.id, infoColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const queue = [...state.teamSpec].sort((a, b) => (state.specQueueSince.get(a.id) ?? 0) - (state.specQueueSince.get(b.id) ?? 0));
        const position = queue.findIndex((p) => p.id === player.id) + 1;
        const nextMatchSize = 2 * teamSize;
        if (position <= nextMatchSize) {
            room.sendAnnouncement(`⏳ Вы ${position}-й в очереди — попадёте в следующий же матч.`, player.id, infoColor, 'bold', HaxNotification.CHAT);
        } else {
            const matchesToWait = Math.ceil((position - nextMatchSize) / nextMatchSize);
            room.sendAnnouncement(`⏳ Вы ${position}-й в очереди из ${queue.length} — подождите ещё ${matchesToWait} матч(а/ей).`, player.id, infoColor, 'bold', HaxNotification.CHAT);
        }
    }

    // !up (Role.VIP, requested 2026-08-16) — BFF's equivalent of the main
    // room's own !up: jumps the caller to the FRONT of the fairness queue
    // (see matchFlow.js's specQueueSince sort) instead of claiming a
    // captain slot (BFF has no captain-pick ritual at all, see matchFlow.js's
    // own header comment — teams are assembled by rating). Implemented by
    // giving the caller a timestamp earlier than everyone currently
    // waiting, rather than touching the sort/consume logic itself — the
    // existing "oldest-waiting-first" sort in matchFlow.js just naturally
    // puts them first, no separate priority concept needed.
    // Same 1h cooldown + 3-uses/rolling-24h cap as the main room's own !up
    // (see commands/player.js — ported verbatim for the same reason: no
    // daily cap would let one VIP camp the front of the queue all day).
    const upCooldownMap = new Map();
    const upDailyUsage = new Map();
    function pruneUpDailyUsage(auth) {
        const now = Date.now();
        const timestamps = (upDailyUsage.get(auth) ?? []).filter((t) => now - t < upDailyWindowMs);
        upDailyUsage.set(auth, timestamps);
        return timestamps;
    }
    async function upCommand(player) {
        if (state.teamSpec.every((p) => p.id !== player.id)) {
            room.sendAnnouncement(`!up доступен только зрителям !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const auth = authArray[player.id][0];
        const dailyUses = pruneUpDailyUsage(auth);
        if (dailyUses.length >= upDailyMaxUses) {
            const nextFreeAt = new Date(dailyUses[0] + upDailyWindowMs).toISOString();
            room.sendAnnouncement(
                `!up можно использовать не больше ${upDailyMaxUses} раз в день — использовано ${dailyUses.length}/${upDailyMaxUses}, следующая попытка через ${formatBanRemaining(nextFreeAt)} !`,
                player.id, errorColor, 'bold', HaxNotification.CHAT
            );
            return;
        }
        if (upCooldownMap.has(auth)) {
            room.sendAnnouncement(`Команду !up можно использовать раз в час — осталось ${formatBanRemaining(upCooldownMap.get(auth))} !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const waitingTimestamps = [...state.specQueueSince.values()];
        const earliest = waitingTimestamps.length > 0 ? Math.min(...waitingTimestamps) : Date.now();
        state.specQueueSince.set(player.id, earliest - 1);
        const upExpiresAt = new Date(Date.now() + upCooldownMs).toISOString();
        upCooldownMap.set(auth, upExpiresAt);
        setTimeout(() => upCooldownMap.delete(auth), upCooldownMs);
        dailyUses.push(Date.now());
        upDailyUsage.set(auth, dailyUses);
        room.sendAnnouncement(`⏫ Вы в начале очереди — попадёте в следующий же матч !`, player.id, successColor, 'bold', HaxNotification.CHAT);
        // Immediate effect if a slot is already available right now (e.g. a
        // live match mid-fill/growth — see assembleMatch's own STOP-vs-live
        // branches), not just "first in line whenever the next join/leave
        // happens to trigger assembly".
        await matchFlow.assembleMatch();
    }

    // !rules (!info) — BFF has no captain-pick ritual and no fixed arena
    // size (see matchFlow.js's own doc comment), which isn't obvious to a
    // new player just watching teams appear on their own.
    // 'italic' (requested 2026-08-16, not 'bold' like the rest of this
    // file) — this is pure reference text, never an event or a warning, so
    // it reads visually distinct from the announcements around it.
    function rulesCommand(player) {
        const text = `ℹ️ Правила BFF:\n` +
            `Команды собираются автоматически по рейтингу (⚔️) — без выбора капитанов.\n` +
            `Размер матча — от 1x1 до ${teamSize}x${teamSize}, зависит от того, сколько человек ждёт.\n` +
            `Рейтинг меняется только за полный ${teamSize}x${teamSize} — в неполных составах он не считается.\n` +
            `Идущий матч не прерывается: недостающих подберёт из очереди, а новое распределение — только после конца игры.\n` +
            `!queue - узнать свою позицию в очереди.`;
        room.sendAnnouncement(text, player.id, infoColor, 'italic', HaxNotification.CHAT);
    }

    // Moderation (bans/admins/VIPs/password) is Role.MASTER-gated, mute/
    // unmute/mutes/hide are Role.ADMIN_TEMP-gated — same split as the main
    // room's own commands.js (regular admins get the native HaxBall admin
    // badge/powers PLUS mute/hide, but not the owner-only bot commands).
    function helpCommand(player) {
        let text = `Доступные команды:\n` +
            `!me - краткая статистика (рейтинг, % побед)\n` +
            `!sf - подробная статистика (ранги, тренд рейтинга)\n` +
            `!tops [games|wins|goals|assists|cs|playtime|rating] - таблица лидеров\n` +
            `!rename [имя] - переименовать себя для таблицы лидеров\n` +
            `!queue - ваша позиция в очереди на игру\n` +
            `!rules - как собираются команды в этой комнате\n` +
            `!voteban #<id> - начать голосование за временный бан игрока\n` +
            `!report - позвать администрацию\n` +
            `!afk, !afks - AFK-режим и список AFK ("jj" в чате тоже выводит из AFK)\n` +
            `!bb - мгновенно выйти из комнаты`;
        if (getRole(player) >= Role.VIP) {
            text += `\n\nVIP:\n` +
                `!viphide - скрыть/показать VIP-префикс в чате\n` +
                `!vipcolor <hex> - изменить цвет VIP-префикса, без аргумента сбросить на стандартный\n` +
                `!up - прыгнуть в начало очереди на игру (раз в час, не больше 3 раз в день)`;
        }
        if (getRole(player) >= Role.ADMIN_TEMP) {
            text += `\n\nАдмин:\n` +
                `!mute #<id> [минуты], !unmute #<id>, !mutes - муты\n` +
                `!hide - скрыть/показать бейдж и префикс админа`;
        }
        if (getRole(player) >= Role.MASTER) {
            text += `\n\nВладелец:\n` +
                `!banauth <auth> <минуты> [причина], !unbanauth <auth>, !authbans - баны\n` +
                `!setadmin #<id>, !removeadmin <auth> - админы\n` +
                `!setvip #<id> [дни], !removevip <auth>, !vips - VIP\n` +
                `!players - список игроков с их auth\n` +
                `!password [пароль] - пароль комнаты`;
        }
        room.sendAnnouncement(text, player.id, infoColor, 'bold', HaxNotification.CHAT);
    }

    return {
        meCommand,
        statsFullCommand,
        topsCommand,
        renameCommand,
        helpCommand,
        leaveCommand,
        vipColorCommand,
        vipHideCommand,
        queueCommand,
        upCommand,
        rulesCommand,
    };
};
