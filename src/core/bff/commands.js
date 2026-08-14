/*
 * BFF's own !me/!tops/!help — deliberately NOT commands/player.js's
 * globalStatsCommand/topsCommand/helpCommand: those are wired for the main
 * room's full feature set (clubs, trophies, VIP colors, economy help
 * sections). This is the "no economy/mini-games, just moderation + stats +
 * rating" surface actually confirmed for BFF.
 */
const createPrintStats = require('../stats/print');

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
}) {
    const { printPlayerStats } = createPrintStats({ getTimeStats, db });

    // !me — same stat block the main room shows, plus a rating line (see
    // stats/print.js's printPlayerStats: only appears when ratingOrdinal is
    // actually set on the stats object, which only ever happens here).
    async function meCommand(player) {
        const auth = authArray[player.id][0];
        const stats = (await db.getPlayerStats(auth)) ?? new HaxStatistics(player.name);
        const rating = await db.getRating(auth);
        if (rating) stats.ratingOrdinal = computeOrdinal(rating);
        const statsString = await printPlayerStats(stats);
        room.sendAnnouncement(statsString, player.id, infoColor, 'bold', HaxNotification.CHAT);
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

    // !viphide — same shape as the main room's commands/admin.js hideCommand
    // (and its own core/bff/chatGuard.js !hide for BFF admins), but
    // VIP-specific and simpler: VIP has no native room badge to also
    // toggle, just the one Set bffEntry.js's own onPlayerChat prefix logic
    // already checks (see its own comment there).
    function vipHideCommand(player) {
        if (hiddenVipSet.has(player.id)) {
            hiddenVipSet.delete(player.id);
            room.sendAnnouncement(`👁️ Скрытность отключена — VIP-префикс снова виден.`, player.id, successColor, 'bold', HaxNotification.CHAT);
        } else {
            hiddenVipSet.add(player.id);
            room.sendAnnouncement(`🕶️ Скрытность включена — VIP-префикс скрыт.`, player.id, successColor, 'bold', HaxNotification.CHAT);
        }
    }

    // Moderation (bans/admins/VIPs/password) is Role.MASTER-gated, mute/
    // unmute/mutes/hide are Role.ADMIN_TEMP-gated — same split as the main
    // room's own commands.js (regular admins get the native HaxBall admin
    // badge/powers PLUS mute/hide, but not the owner-only bot commands).
    function helpCommand(player) {
        let text = `Доступные команды:\n` +
            `!me - ваша статистика и рейтинг\n` +
            `!tops [games|wins|goals|assists|cs|playtime|rating] - таблица лидеров\n` +
            `!rename [имя] - переименовать себя для таблицы лидеров\n` +
            `!voteban #<id> - начать голосование за временный бан игрока\n` +
            `!report - позвать администрацию\n` +
            `!afk, !afks - AFK-режим и список AFK ("jj" в чате тоже выводит из AFK)\n` +
            `!bb - мгновенно выйти из комнаты`;
        if (getRole(player) >= Role.VIP) {
            text += `\n\nVIP:\n` +
                `!viphide - скрыть/показать VIP-префикс в чате`;
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
        topsCommand,
        renameCommand,
        helpCommand,
        leaveCommand,
        vipHideCommand,
    };
};
