/*
 * Player-facing commands: help, stats, rename, AFK handling and leaving.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createPlayerCommands({
    room,
    state,
    Team,
    State,
    Role,
    HaxStatistics,
    authArray,
    db,
    AFKSet,
    AFKMinSet,
    AFKCooldownSet,
    minAFKDuration,
    maxAFKDuration,
    maxAFKDurationVip,
    maxAFKCount,
    AFKCooldown,
    silencedAuths,
    hiddenVipSet,
    announcementColor,
    errorColor,
    infoColor,
    successColor,
    achievementColor,
    warningColor,
    vipChatColor,
    adminChatColor,
    masterChatColor,
    HaxNotification,
    getCommand,
    getRole,
    handlePlayersJoin,
    handlePlayersLeave,
    printPlayerStats,
    getTimeStats,
    printRankings,
    printAllRankings,
    printClubRankings,
    updateTeams,
    getCommands,
    formatCoins,
    gifClip,
    discordBot,
    formatBanRemaining,
    renderProgressBar,
    upCooldownMs = 60 * 60 * 1000,
    upDailyMaxUses = 3,
    upDailyWindowMs = 24 * 60 * 60 * 1000,
    tipDailyMaxUses = 5,
    tipDailyMaxUsesVip = 10,
    tipDailyWindowMs = 24 * 60 * 60 * 1000,
}) {
    // One-time reward for linking a Discord account — only paid out on a
    // genuine first link (see db.linkDiscordId's isNewLink), so relinking
    // to fix a typo doesn't farm coins.
    const DISCORD_LINK_BONUS_COINS = 100;

    // !report — per-player cooldown so one player can't spam-ping admins.
    // A plain Set is safe to hold via closure here (unlike `state`'s
    // bindings): it's created once and only ever mutated, never reassigned.
    const REPORT_COOLDOWN_MS = 60 * 1000;
    const reportCooldownSet = new Set();

    // !up — per-auth cooldown (1 use/hour) PLUS a rolling-24h cap (3
    // uses/day, requested 2026-08-15 — was cooldown-only before) so the
    // same VIP can't camp the front of the captain queue every round OR
    // every hour, all day. The "only one live claim at a time" part is
    // separately enforced via state.priorityCaptainId itself (a single
    // slot — see team/choosing.js's resolveNextCaptainId).
    //
    // Both maps are keyed by AUTH, not player.id — player.id resets on
    // every reconnect, which would make the daily cap trivially bypassable
    // by just leaving and rejoining (a real gap in the original id-keyed
    // cooldown, fixed here while reworking this anyway, since a
    // reconnect-bypassable "3 times a day" isn't actually a limit at all).
    //
    // upCooldownMap: auth -> expiry ISO timestamp, same formatBanRemaining
    // "Xmin." shape !banauth/!authbans/!mute already use for a rejection.
    // upDailyUsage: auth -> array of use timestamps (ms), pruned to the
    // rolling upDailyWindowMs window on every check — a plain sliding
    // window rather than a calendar-day reset, so there's no timezone/
    // midnight semantics to explain to players at all. Cooldown/cap/window
    // are injected (defaults above) rather than hardcoded purely so tests
    // can shrink them instead of waiting out real hours — same reasoning
    // as matchFlow.js's own injected reassembleDelayMs.
    const upCooldownMap = new Map();
    const upDailyUsage = new Map();

    function pruneUpDailyUsage(auth) {
        const now = Date.now();
        const timestamps = (upDailyUsage.get(auth) ?? []).filter((t) => now - t < upDailyWindowMs);
        upDailyUsage.set(auth, timestamps);
        return timestamps;
    }

    // !tip #<id> (requested 2026-08-17) — a Dota-style "gg" tip: publicly
    // thanks another player, no economy effect. Two independent limits:
    // a rolling-24h daily cap (5 regular / 10 VIP, same reasoning/shape as
    // !up's own dailyUsage above — keyed by auth, not player.id, so it
    // survives a reconnect), AND a once-PER-MATCH allowance regardless of
    // the daily total remaining (state.tipUsedThisMatch, a plain Set of
    // auths reset every onGameStart — same convention as !votepause's own
    // state.pauseVoteUsed, see gameManagement.js).
    const tipDailyUsage = new Map();

    function pruneTipDailyUsage(auth) {
        const now = Date.now();
        const timestamps = (tipDailyUsage.get(auth) ?? []).filter((t) => now - t < tipDailyWindowMs);
        tipDailyUsage.set(auth, timestamps);
        return timestamps;
    }
    function leaveCommand(player, message) {
        room.kickPlayer(player.id, 'Пока !', false);
    }

    // !help category headers (requested 2026-08-16) — grouping is purely
    // cosmetic on top of the existing per-role command list: role gating
    // itself is untouched, this only reorganizes each role tier's own flat
    // comma dump into labeled sub-groups. A command with no `category` in
    // commands.js falls back to 'misc' rather than being dropped.
    const HELP_CATEGORY_LABELS = {
        stats: '📊 Статистика',
        shop: '🛒 Магазин',
        club: '🏛 Клуб',
        chat: '💬 Чат',
        minigames: '🎮 Мини-игры',
        votes: '🗳 Голосования',
        vip: '⭐ VIP',
        moderation: '🛡 Модерация',
        arena: '🏟 Арена',
        misc: '🛠 Прочее',
    };
    const HELP_CATEGORY_ORDER = ['stats', 'shop', 'club', 'chat', 'minigames', 'votes', 'vip', 'moderation', 'arena', 'misc'];

    function buildHelpCategoryBlock(role) {
        const byCategory = new Map();
        for (const [key, value] of Object.entries(getCommands())) {
            if (!value.desc || value.roles != role) continue;
            const category = value.category ?? 'misc';
            if (!byCategory.has(category)) byCategory.set(category, []);
            byCategory.get(category).push(`!${key}`);
        }
        return HELP_CATEGORY_ORDER
            .filter((category) => byCategory.has(category))
            .map((category) => `${HELP_CATEGORY_LABELS[category]}: ${byCategory.get(category).join(', ')}`)
            .join('\n');
    }

    function helpCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length == 0) {
            // One announcement per role tier now, each in THAT role's own
            // established chat color (requested 2026-08-18 — reusing
            // vipChatColor/adminChatColor/masterChatColor rather than
            // inventing a new palette, same colors those roles' own chat
            // messages already use elsewhere) — a player instantly sees
            // where their own commands end and a higher tier's begin,
            // instead of one long undifferentiated bold dump.
            room.sendAnnouncement(
                `Доступные команды игрока :\n${buildHelpCategoryBlock(Role.PLAYER)}`,
                player.id,
                infoColor,
                'bold',
                HaxNotification.CHAT
            );
            if (getRole(player) >= Role.VIP) {
                room.sendAnnouncement(
                    `⭐ Доступные команды VIP :\n${buildHelpCategoryBlock(Role.VIP) || 'None'}`,
                    player.id,
                    vipChatColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            if (getRole(player) >= Role.ADMIN_TEMP) {
                room.sendAnnouncement(
                    `🛡 Доступные команды администратора :\n${buildHelpCategoryBlock(Role.ADMIN_TEMP) || 'None'}`,
                    player.id,
                    adminChatColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            if (getRole(player) >= Role.MASTER) {
                room.sendAnnouncement(
                    `👑 Доступные команды владельца :\n${buildHelpCategoryBlock(Role.MASTER) || 'None'}`,
                    player.id,
                    masterChatColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            // Unified index pointer (requested 2026-08-15): !club and !vip*
            // are each their OWN multi-command group with a separate help
            // entry point (!club help / !viphelp) that nothing in this list
            // otherwise hints at — spelled out here explicitly so the two-hop
            // "!help club" -> "see !club help" path isn't the only way to
            // discover it. Small-italic + warningColor (requested
            // 2026-08-18) gives it the same "psst, more detail" tone as
            // !tops' own trailing hint line.
            room.sendAnnouncement(
                "Для получения информации о конкретной команде, введите '!help <имя команды>'.\n" +
                "Дополнительно: '!club help' — все команды клуба, '!viphelp' — все команды VIP.",
                player.id,
                warningColor,
                'small-italic',
                HaxNotification.CHAT
            );
        } else if (msgArray.length >= 1) {
            const commandName = getCommand(msgArray[0].toLowerCase());
            if (commandName != false && getCommands()[commandName].desc != false)
                room.sendAnnouncement(
                    `\'${commandName}\' команда :\n${getCommands()[commandName].desc}`,
                    player.id,
                    infoColor,
                    'bold',
                    HaxNotification.CHAT
                );
            else
                room.sendAnnouncement(
                    `Команда, которую вы пытались получить информацию, не существует. Чтобы проверить все доступные команды, введите '!help'`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
        }
    }

    async function globalStatsCommand(player, message) {
        const stats = (await db.getPlayerStats(authArray[player.id][0])) ?? new HaxStatistics(player.name);
        // ⭐ badge (requested 2026-08-16) — !tops already marks VIP entries
        // this way, !me previously didn't show VIP status at all.
        stats.isVip = getRole(player) >= Role.VIP;
        // Opt-in field (same ad-hoc pattern as BFF's ratingOrdinal) — only
        // the main room ever sets this, so printPlayerStats' ELO bracket
        // stays hidden for BFF (see print.js's own comment for why it can't
        // just check stats.elo directly).
        stats.eloDisplay = stats.elo;
        // core/stats/analytics/'s per-match 0-10 rating (requested
        // 2026-08-17), shown in parentheses right after ELO — null (not 0)
        // when they've never had a match analyzed yet, same "distinguish
        // never-played from a real zero" reasoning as getRecentRatingDelta.
        const lastMatchReport = await db.getLatestMatchAnalyticsReport(authArray[player.id][0]);
        stats.lastMatchRating = lastMatchReport?.rating ?? null;
        const statsString = await printPlayerStats(stats);
        // Split into styled announcements (requested 2026-08-18 — real
        // visual hierarchy, not just content: HaxBall can't style a single
        // message per-line, only per-call, same pattern roomStats.js's
        // sendRankingBlock now uses for !tops). printPlayerStats' own line
        // order is fixed (name, then win%/games, then the category
        // breakdown, then an optional ELO+rating line) — that shape is
        // documented on printPlayerStats itself, so indexing into it here is
        // safe as long as that order doesn't change.
        const [nameLine, summaryLine, categoriesLine, ...rest] = statsString.split('\n');
        room.sendAnnouncement(nameLine, player.id, stats.isVip ? achievementColor : announcementColor, 'bold', HaxNotification.CHAT);
        room.sendAnnouncement(summaryLine, player.id, infoColor, 'small-bold', HaxNotification.CHAT);
        room.sendAnnouncement(categoriesLine, player.id, infoColor, 'small', HaxNotification.CHAT);
        if (rest.length > 0) {
            room.sendAnnouncement(rest.join('\n'), player.id, successColor, 'small-bold', HaxNotification.CHAT);
        }
    }

    // !vs #<id> (requested 2026-08-17, item #2) — head-to-head comparison,
    // never built before now: !me/!sf show one player's own numbers,
    // !tops ranks everyone against everyone, but nothing compared two
    // SPECIFIC people side by side. The personal head-to-head line reads
    // db.getHeadToHead (see head_to_head's own doc comment in db/sqlite.js)
    // — auth pairs recorded whenever a match ends (entry.js's endGame),
    // for opposing-team pairings only, so this stays empty for two people
    // who've only ever been teammates.
    // Coarse day-bucket only (today/yesterday/N дней назад) — good enough
    // for "is this rivalry still active", not meant as a precise clock.
    function daysAgoText(isoString) {
        const days = Math.floor((Date.now() - new Date(isoString).getTime()) / 86400000);
        if (days <= 0) return 'сегодня';
        if (days === 1) return 'вчера';
        return `${days} дн. назад`;
    }

    async function vsCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length == 0 || msgArray[0][0] != '#' || room.getPlayer(parseInt(msgArray[0].substring(1))) == null) {
            room.sendAnnouncement(
                `Использование: !vs #<id>. Пример: !vs #3 сравнит вашу статистику со статистикой игрока с id 3.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const target = room.getPlayer(parseInt(msgArray[0].substring(1)));
        if (target.id == player.id) {
            room.sendAnnouncement(`Нельзя сравнить себя с самим собой !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const authSelf = authArray[player.id][0];
        const authTarget = authArray[target.id][0];
        const [statsSelf, statsTarget, reportSelf, reportTarget] = await Promise.all([
            db.getPlayerStats(authSelf),
            db.getPlayerStats(authTarget),
            db.getLatestMatchAnalyticsReport(authSelf),
            db.getLatestMatchAnalyticsReport(authTarget),
        ]);
        const a = statsSelf ?? new HaxStatistics(player.name);
        const b = statsTarget ?? new HaxStatistics(target.name);
        const h2h = await db.getHeadToHead(authSelf, authTarget);

        // 4-part styled breakdown (requested 2026-08-18 — "добавь больше
        // информации"): header, then career totals, then recent form (last
        // analyzed match's 0-10 rating each — "who's hot right now", same
        // source !rating uses), then the head-to-head line highlighted by
        // outcome — same header/body/highlight shape !me/!rating/!tops
        // already use, so a denser comparison still reads in layers instead
        // of one more wall of text.
        room.sendAnnouncement(`⚔️ ${a.playerName} vs ${b.playerName}`, player.id, achievementColor, 'bold', HaxNotification.CHAT);
        room.sendAnnouncement(
            `🏆 Победы: ${a.wins} — ${b.wins} (${a.winrate} — ${b.winrate})\n` +
            `🕹️ Игры: ${a.games} — ${b.games} · ⏱️ Время: ${getTimeStats(a.playtime)} — ${getTimeStats(b.playtime)}\n` +
            `🎯 ELO: ${a.elo} — ${b.elo}\n` +
            `⚽ Голы: ${a.goals} — ${b.goals} · 🅰️ Ассисты: ${a.assists} — ${b.assists} · 🧤 Сухие: ${a.CS} — ${b.CS}`,
            player.id,
            infoColor,
            'small',
            HaxNotification.CHAT
        );
        if (reportSelf != null || reportTarget != null) {
            const formSelf = reportSelf != null ? reportSelf.rating.toFixed(1) : '—';
            const formTarget = reportTarget != null ? reportTarget.rating.toFixed(1) : '—';
            room.sendAnnouncement(`📈 Форма (посл. матч): ${formSelf} — ${formTarget}`, player.id, achievementColor, 'small-bold', HaxNotification.CHAT);
        }
        if (h2h) {
            const draws = h2h.games - h2h.winsFor - h2h.winsAgainst;
            const outcome = h2h.winsFor > h2h.winsAgainst ? 'в твою пользу' : h2h.winsFor < h2h.winsAgainst ? 'не в твою пользу' : 'ничья';
            const outcomeColor = h2h.winsFor > h2h.winsAgainst ? successColor : h2h.winsFor < h2h.winsAgainst ? warningColor : infoColor;
            room.sendAnnouncement(
                `Личные встречи: ${h2h.winsFor}-${h2h.winsAgainst}${draws > 0 ? `-${draws}н` : ''} (${outcome}) · последняя ${daysAgoText(h2h.lastPlayedAt)}`,
                player.id,
                outcomeColor,
                'small-bold',
                HaxNotification.CHAT
            );
        } else {
            room.sendAnnouncement(`Личных встреч друг против друга ещё не было.`, player.id, infoColor, 'small-italic', HaxNotification.CHAT);
        }
    }

    async function tipCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length == 0 || msgArray[0][0] != '#' || room.getPlayer(parseInt(msgArray[0].substring(1))) == null) {
            room.sendAnnouncement(
                `Использование: !tip #<id>. Пример: !tip #3 благодарит игрока с id 3 за игру.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const target = room.getPlayer(parseInt(msgArray[0].substring(1)));
        if (target.id == player.id) {
            room.sendAnnouncement(`Нельзя типнуть самого себя !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const auth = authArray[player.id][0];
        // Master is exempt from both limits below (requested 2026-08-17 —
        // "мастер всегда один, и даже если бы было несколько, им бы тоже
        // имело смысл бегать без лимита"). No usage bookkeeping for them
        // either (tipUsedThisMatch/tipDailyUsage stay untouched) — there's
        // no cap to track against, so recording it would be pointless.
        const isUnlimited = getRole(player) >= Role.MASTER;

        if (!isUnlimited && state.tipUsedThisMatch.has(auth)) {
            room.sendAnnouncement(
                `!tip можно использовать только один раз за матч !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        const dailyMax = getRole(player) >= Role.VIP ? tipDailyMaxUsesVip : tipDailyMaxUses;
        const dailyUses = pruneTipDailyUsage(auth);
        if (!isUnlimited && dailyUses.length >= dailyMax) {
            const nextFreeAt = new Date(dailyUses[0] + tipDailyWindowMs).toISOString();
            room.sendAnnouncement(
                `!tip можно использовать не больше ${dailyMax} раз в день — использовано ${dailyUses.length}/${dailyMax}, следующая попытка через ${formatBanRemaining(nextFreeAt)} !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        if (!isUnlimited) {
            state.tipUsedThisMatch.add(auth);
            dailyUses.push(Date.now());
            tipDailyUsage.set(auth, dailyUses);
        }

        room.sendAnnouncement(
            `👏 ${player.name} благодарит ${target.name}. Хорошо сыграно!`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        if (!isUnlimited) {
            room.sendAnnouncement(
                `Использований !tip сегодня: ${renderProgressBar(dailyUses.length, dailyMax)}`,
                player.id,
                infoColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // !gif — queues a ~10s clip around the moment this was typed (VIP+,
    // max GIF_MAX_PER_MATCH per player per match). Doesn't render anything
    // itself: just records the request (see state.gifRequests, reset each
    // match in gameManagement.js's onGameStart) for onGameStop to hand off
    // to gifClip.js in one batch once the match's own recording is
    // actually available (room.stopRecording() hasn't run yet while a
    // match is still live).
    const GIF_MAX_PER_MATCH = 2;

    function gifCommand(player) {
        if (!gifClip.enabled) {
            room.sendAnnouncement(`Команда !gif сейчас недоступна.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        if (state.gameState != State.PLAY) {
            room.sendAnnouncement(`!gif можно использовать только во время матча !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const auth = authArray[player.id][0];
        const usedThisMatch = state.gifRequests.filter((r) => r.auth == auth).length;
        if (usedThisMatch >= GIF_MAX_PER_MATCH) {
            room.sendAnnouncement(`!gif можно использовать не больше ${GIF_MAX_PER_MATCH} раз за матч !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        state.gifRequests.push({ auth, playerId: player.id, playerName: player.name, time: room.getScores().time });
        room.sendAnnouncement(
            `🎬 Гифка запрошена — появится в discord-канале после матча (${usedThisMatch + 1}/${GIF_MAX_PER_MATCH} за игру) !`,
            player.id,
            successColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    // !rating — the 28-metric advanced analytics report (see
    // core/stats/analytics/), main room only. Looks up the CALLER's own most
    // recent match (db.getLatestMatchAnalyticsReport) — there's no
    // cross-match aggregation yet (see analytics/index.js's own doc comment:
    // one row per match, ELO integration is a deliberate follow-up, not
    // built here), so this only ever shows "how did I do last game."
    //
    // The single X.X/10 up top is MatchRatingDetector's re-centered
    // composite (requested after seeing a replay-analyzer screenshot with
    // per-player match ratings) — relative to the OTHER 7 players in that
    // SAME match, not an absolute/historical scale. The 27 raw metrics below
    // it are what it's built from, for anyone who wants the detail.
    function ratingEmoji(rating) {
        if (rating >= 8.5) return '🌟';
        if (rating >= 7) return '✅';
        if (rating >= 5.5) return '➖';
        return '🔻';
    }

    // Same 4 tiers as ratingEmoji, mapped onto colors this codebase already
    // uses for exactly these meanings elsewhere (achievementColor for a
    // standout/milestone-tier result, successColor for a solidly good one,
    // warningColor/errorColor for below-average) — reused for consistency,
    // not a new palette.
    function ratingColor(rating) {
        if (rating >= 8.5) return achievementColor;
        if (rating >= 7) return successColor;
        if (rating >= 5.5) return warningColor;
        return errorColor;
    }

    async function ratingCommand(player, message) {
        const auth = authArray[player.id][0];
        const report = await db.getLatestMatchAnalyticsReport(auth);
        if (report == null) {
            room.sendAnnouncement(
                `Пока нет данных о последнем матче — сыграйте хотя бы один полный матч.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        // 3-part styled breakdown (requested 2026-08-18 — real visual
        // hierarchy, not one dense bold block): headline rating tier-colored
        // and prominent, the goal-contribution numbers right below it as a
        // secondary highlight, and the full 24-metric breakdown de-emphasized
        // as small print underneath — same "header/highlight/detail" shape
        // globalStatsCommand and roomStats.js's sendRankingBlock now use, for
        // a consistent feel across !me/!rating/!tops.
        room.sendAnnouncement(
            `${ratingEmoji(report.rating)} Оценка за последний матч — ${report.playerName}: ${report.rating.toFixed(1)}/10`,
            player.id,
            ratingColor(report.rating),
            'bold',
            HaxNotification.CHAT
        );
        room.sendAnnouncement(
            `⚽ Голы ${report.goals} | Передачи ${report.assists} | Удары ${report.shotsTaken} (xG ${report.xgCreated})`,
            player.id,
            achievementColor,
            'small-bold',
            HaxNotification.CHAT
        );
        const detailText =
            `🎯 Владение: касания ${report.posTouches} | голевые ${report.scoringPct}% | скорость решений ${report.decisionSpeed}\n` +
            `⏩ Прогресс: прог. передачи ${report.progPasses} (${report.progDistance}px) | выход в финальную треть ${report.final3rdEntries} | ключевые передачи ${report.keyPasses}\n` +
            `🅰️ Цепочка: 2-й ассист ${report.secondAssists} | 3-й ассист ${report.thirdAssists} | добивания ${report.rebounds} (забрал ${report.reboundsRecovered}) | контратаки ${report.counters}\n` +
            `🛡️ Оборона: потери ${report.turnoverTouches} (опасных ${report.dangerousTurnovers}) | отборы ${report.forcedTakeaways} | перехваты ${report.intercDuels} | подборы ${report.recoveries} (в атаке ${report.f3Recoveries}) | выносы ${report.clearances} (сохранено ${report.clearancesRecovered})\n` +
            `🤺 Дуэли: ${report.duels} (${report.duelsWon}П / ${report.duelsLost}П) | без давления ${report.pressRelief}%\n` +
            `🧤 Вратарь: xG соперника ${report.xgFaced} | предотвращено ${report.xgPrevented} | подчистки ${report.sweeperActions}`;
        room.sendAnnouncement(detailText, player.id, infoColor, 'small', HaxNotification.CHAT);
    }

    async function renameCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = authArray[player.id][0];
        const stats = await db.getPlayerStats(auth);
        if (stats) {
            stats.playerName = msgArray.length == 0 ? player.name : msgArray.join(' ');
            await db.savePlayerStats(auth, stats);
            room.sendAnnouncement(
                `Вы успешно переименовали себя на ${stats.playerName} !`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        } else {
            room.sendAnnouncement(
                `Вы еще не играли в этой комнате !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // Toggles whether THIS player sees other club members' custom chat
    // colors (see commands/club.js's !club color) — the club prefix TEXT
    // still shows either way, only the color falls back to default for
    // whoever has opted out. Purely a viewer-side preference: it has no
    // effect on what anyone else sees, including the toggling player's own
    // messages as seen by others.
    async function customColorsCommand(player, message) {
        const auth = authArray[player.id][0];
        const hidden = state.hiddenCustomColorsSet.has(auth);
        if (hidden) {
            state.hiddenCustomColorsSet.delete(auth);
            await db.setHideCustomColors(auth, false);
            room.sendAnnouncement(
                `✔️ Кастомные цвета клубов снова отображаются для вас в чате !`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        } else {
            state.hiddenCustomColorsSet.add(auth);
            await db.setHideCustomColors(auth, true);
            room.sendAnnouncement(
                `✔️ Кастомные цвета клубов больше не отображаются для вас в чате !`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // Role-gated to Role.VIP in commands.js — trusts the dispatcher, same as
    // every other role-gated command here, so this never re-checks the role
    // itself. Overrides the shared vipChatColor (see constants.js) with a
    // color this VIP picked for themselves; no argument clears it back to
    // the shared default. Unlike !customcolors, this isn't a per-viewer
    // preference — everyone sees the same color for this VIP's messages.
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

    // Role-gated to Role.VIP in commands.js, same trust-the-dispatcher
    // convention as vipColorCommand above. Same shape as commands/admin.js's
    // hideCommand (suppresses just the chat prefix without touching
    // role/permissions), but simpler — VIP has no native room badge the way
    // admin does, so there's no room.setPlayerAdmin/onPlayerAdminChange
    // interaction to worry about, just the one Set events/activity.js's
    // chat-prefix logic already checks.
    // Persisted (requested 2026-08-16: survive a restart) and keyed by auth,
    // not player.id — see hiddenVipSet's own declaration in entry.js.
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

    function vipHelpCommand(player, message) {
        const text = [
            '⭐ Команды VIP:',
            '!vipcolor <hex> — изменить цвет вашего VIP-префикса в чате, или без аргумента чтобы сбросить на стандартный. Пример: !vipcolor ff8800.',
            '!viphide — скрыть (или снова показать) ваш VIP-префикс в чате. Права доступа не меняются, только видимость.',
            '!viphelp — эта команда.',
            '',
            '⭐ Также, пока у вас есть VIP: анимации "Дым", "Фейерверк" и "Черная дыра" после гола доступны бесплатно — просто наденьте их через "!equip smoke-<цвет>", "!equip fireworks" или "!equip blackhole", без покупки.',
        ].join('\n');
        // 'italic' (requested 2026-08-16) — reference text, not an event or
        // a warning, same reasoning as !club help / bff's own !rules.
        room.sendAnnouncement(text, player.id, announcementColor, 'italic', HaxNotification.CHAT);
    }

    async function linkDiscordCommand(player, message) {
        const discordId = message.split(/ +/)[1];
        if (!discordId || !/^\d{15,20}$/.test(discordId)) {
            room.sendAnnouncement(
                `Неверный ID Discord. Введите "!help discord" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const auth = authArray[player.id][0];
        const isNewLink = await db.linkDiscordId(auth, discordId);
        room.sendAnnouncement(
            `Ваш аккаунт Discord был связан ! Теперь вы можете использовать "!stats" в Discord, не вводя свое имя.`,
            player.id,
            successColor,
            'bold',
            HaxNotification.CHAT
        );
        // Catches a VIP role already sitting on this Discord account from
        // BEFORE it was ever linked (a giveaway, a boost, a manual grant —
        // whatever) — the live guildMemberUpdate edge that would normally
        // catch a role grant already fired and was silently dropped at that
        // point, since there was no linked auth yet to grant it to (see
        // discord.js's handleGuildMemberUpdate/checkVipRoleOnLink). Safe to
        // call every link, not just a first-time one — grantVipByAuth is
        // already a no-op for someone who's not VIP-eligible or already VIP.
        discordBot.checkVipRoleOnLink(discordId, auth, player.name);
        if (isNewLink) {
            await db.addCoins(auth, player.name, DISCORD_LINK_BONUS_COINS);
            const newBalance = await db.getBalance(auth);
            room.sendAnnouncement(
                `💰 Бонус за привязку Discord: +${formatCoins(DISCORD_LINK_BONUS_COINS)} ! Баланс: ${formatCoins(newBalance)}`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // !tops [stat] — every leaderboard (!goals/!wins/etc.) used to be its
    // own top-level command; now they're all just arguments to this one.
    // No argument shows every category in one message (see
    // stats/roomStats.js's printAllRankings), skipping any that don't have
    // the 5-player quorum yet rather than erroring.
    const TOPS_STAT_KEYS = ['games', 'wins', 'goals', 'assists', 'cs', 'playtime', 'pt', 'clubs', 'elo'];
    async function topsCommand(player, message) {
        const key = message.split(/ +/)[1]?.toLowerCase();
        if (!key) {
            await printAllRankings(player.id);
            return;
        }
        if (!TOPS_STAT_KEYS.includes(key)) {
            room.sendAnnouncement(
                `Использование: !tops [games|wins|goals|assists|cs|playtime|clubs|elo]. Без аргумента показывает все таблицы лидеров сразу.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (key === 'clubs') {
            await printClubRankings(player.id);
            return;
        }
        await printRankings(key == 'pt' ? 'playtime' : key, player.id);
    }

    // Shared by afkCommand's own toggle-off branch below and the bare "jj"
    // chat shortcut (see jjCommand) — the exact same "leave AFK" logic
    // either way, just reached from two different trigger points. Not
    // gated behind afkCommand's own team/betweenRandomRounds check —
    // leaving AFK should never be MORE restricted than entering it already
    // was, and anyone actually in AFKSet only got there through that gate
    // in the first place. Returns true if it actually did something (was
    // AFK, whether they successfully left or are still locked by the
    // min-duration timer) so jjCommand can tell whether to swallow the
    // message or let it fall through as ordinary chat.
    function exitAfk(player) {
        if (!AFKSet.has(player.id)) return false;
        if (AFKMinSet.has(player.id)) {
            room.sendAnnouncement(
                `Минимальное время AFK: ${minAFKDuration} минут. Не злоупотребляйте командой !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return true;
        }
        AFKSet.delete(player.id);
        room.sendAnnouncement(
            `🌅 ${player.name} больше не AFK !`,
            null,
            announcementColor,
            'bold',
            null
        );
        updateTeams();
        handlePlayersJoin();
        return true;
    }

    // "jj" (no ! prefix, checked in events/activity.js's onPlayerChat same
    // as "t"/"@@") — a quick, one-directional shortcut: only ever EXITS
    // AFK, never enters it (see exitAfk above). A player who isn't AFK
    // typing "jj" — a common gaming interjection on its own — falls
    // through to ordinary chat instead of being silently eaten.
    function jjCommand(player, message) {
        return exitAfk(player);
    }

    function afkCommand(player, message) {
        // Also allowed for a player still nominally on RED/BLUE from the
        // just-finished match during the between-rounds pause (State.STOP)
        // before the next random reshuffle — lets them bench themselves for
        // the upcoming round instead of getting swept back onto a team.
        // Excludes an active captain draft (state.chooseMode): dodging into
        // AFK mid-pick would leave a captain's selection in a half-built
        // state.
        const betweenRandomRounds = state.gameState == State.STOP && !state.chooseMode;
        if (player.team == Team.SPECTATORS || state.players.length == 1 || betweenRandomRounds) {
            // Room-capacity cap, not an abuse timer, unlike min/max-duration/
            // cooldown below — but not uniform anymore either: admins are
            // exempt outright (null = no cap), and a VIP gets one extra slot
            // (the room's 5th AFK) on top of the regular cap, since neither
            // is the "too many occupied-but-idle slots" problem this exists
            // to prevent in the same way an ordinary player camping AFK is.
            const afkCapForPlayer = getRole(player) >= Role.ADMIN_TEMP
                ? null
                : getRole(player) >= Role.VIP
                    ? maxAFKCount + 1
                    : maxAFKCount;
            if (AFKSet.has(player.id)) {
                exitAfk(player);
            } else if (afkCapForPlayer != null && AFKSet.size >= afkCapForPlayer) {
                room.sendAnnouncement(
                    `Одновременно AFK может быть не больше ${afkCapForPlayer} игроков. Попробуйте позже.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            } else {
                if (AFKCooldownSet.has(player.id)) {
                    room.sendAnnouncement(
                        `Вы можете становиться AFK только каждые ${AFKCooldown} минут. Не злоупотребляйте командой !`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else {
                    AFKSet.set(player.id, Date.now());
                    // Admins are fully exempt from all three timers on
                    // purpose — including the max-duration auto-return: an
                    // admin AFK is meant to be indefinite, not just exempt
                    // from the min/cooldown abuse limits.
                    if (!player.admin) {
                        // Captured once, right when THIS session starts —
                        // AFKSet's own value already IS this session's start
                        // timestamp, so it doubles as a session token for
                        // the three timers below with nothing extra to
                        // track.
                        //
                        // Bug (reported live): exiting AFK and going AFK
                        // again within the same minAFKDuration/AFKCooldown/
                        // max-duration window left all three of session #1's
                        // timers still pending — their handles were never
                        // stored anywhere, so nothing ever cancelled them.
                        // One firing mid-way through session #2 (a
                        // DIFFERENT AFKSet timestamp by then) would act on
                        // session #2 using session #1's now-irrelevant
                        // schedule — reported as "kicked out of AFK after
                        // only 3 minutes" despite the max duration being 15.
                        // Each callback below now skips itself whenever a
                        // DIFFERENT session is the one currently active; if
                        // there's no active session at all (a normal exit
                        // already happened), the min/cooldown cleanups still
                        // run as before — only the max-duration kick is ALSO
                        // guarded by "is there an active session at all".
                        const afkSessionStartedAt = AFKSet.get(player.id);
                        AFKMinSet.add(player.id);
                        AFKCooldownSet.add(player.id);
                        setTimeout(
                            (id) => {
                                if (AFKSet.has(id) && AFKSet.get(id) !== afkSessionStartedAt) return;
                                AFKMinSet.delete(id);
                            },
                            minAFKDuration * 60 * 1000,
                            player.id
                        );
                        // A current VIP+ gets the longer duration — re-read
                        // live at the moment they go AFK (not re-checked
                        // when this timer actually fires), same "captured
                        // at the start, not re-evaluated mid-flight" shape
                        // as this file's other per-action role checks.
                        const effectiveMaxAFKDuration = getRole(player) >= Role.VIP ? maxAFKDurationVip : maxAFKDuration;
                        setTimeout(
                            (id) => {
                                // Guards against double-handling: the player
                                // may have already toggled AFK off themselves
                                // (!afk) before this fires — that path has
                                // already announced/rebalanced, nothing to
                                // redo here. Also skips if a NEWER session is
                                // the one currently active (see above).
                                if (!AFKSet.has(id) || AFKSet.get(id) !== afkSessionStartedAt) return;
                                AFKSet.delete(id);
                                const p = room.getPlayer(id);
                                if (p != null) {
                                    room.sendAnnouncement(
                                        `😴 ${p.name} вышел из AFK !`,
                                        null,
                                        announcementColor,
                                        'bold',
                                        null
                                    );
                                    room.sendAnnouncement(
                                        `Вы слишком долго находились в AFK.`,
                                        id,
                                        errorColor,
                                        'bold',
                                        HaxNotification.CHAT
                                    );
                                }
                                updateTeams();
                                handlePlayersJoin();
                            },
                            effectiveMaxAFKDuration * 60 * 1000,
                            player.id
                        );
                        setTimeout(
                            (id) => {
                                if (AFKSet.has(id) && AFKSet.get(id) !== afkSessionStartedAt) return;
                                AFKCooldownSet.delete(id);
                            },
                            AFKCooldown * 60 * 1000,
                            player.id
                        );
                    }
                    // Only a REAL move (the state.players.length==1 edge case
                    // above, someone going AFK straight off a team) — the
                    // far more common path (player.team already SPECTATORS)
                    // would make this a no-op reassignment, but
                    // room.setPlayerTeam still fires room.onPlayerTeamChange
                    // regardless of whether the team actually changed. If
                    // chooseMode happened to be active (building the next
                    // match's roster right after this one ended), that
                    // spurious event cascaded into handlePlayersTeamChange
                    // and could trigger an UNRELATED auto-pick of its own —
                    // stacking with the explicit handlePlayersLeave() call
                    // just below (which reacts to this same AFK event
                    // properly) to double-process a single AFK toggle as two
                    // separate roster changes. Symptoms: an extra spectator
                    // silently pulled onto a side mid-pick ("2 captains"
                    // landing on blue when only one pick happened), or a
                    // pick sequence left in a state where blue stayed empty.
                    if (player.team != Team.SPECTATORS) {
                        room.setPlayerTeam(player.id, Team.SPECTATORS);
                    }
                    room.sendAnnouncement(
                        `😴 ${player.name} теперь AFK !`,
                        null,
                        announcementColor,
                        'bold',
                        null
                    );
                    updateTeams();
                    handlePlayersLeave();
                }
            }
        } else {
            room.sendAnnouncement(
                `Вы не можете стать AFK, пока находитесь в команде !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    function afkListCommand(player, message) {
        if (AFKSet.size == 0) {
            room.sendAnnouncement(
                "😴 В списке AFK никого нет.",
                player.id,
                announcementColor,
                'bold',
                null
            );
            return;
        }
        let cstm = '😴 AFK лист : ';
        AFKSet.forEach((afkSince, id) => {
            const p = room.getPlayer(id);
            if (p != null) {
                const minutesAfk = Math.floor((Date.now() - afkSince) / 60000);
                cstm += `${p.name} (${minutesAfk} мин.), `;
            }
        });
        cstm = cstm.substring(0, cstm.length - 2) + '.';
        room.sendAnnouncement(cstm, player.id, announcementColor, 'bold', null);
    }

    // Toggles, for the CALLER only, whether they see chat messages from the
    // target — see events/activity.js's onPlayerChat, which skips delivery
    // to any viewer whose silencedAuths set contains the speaker's auth.
    // Nobody else's view changes, unlike !mute (commands/admin.js), which
    // blocks the message for everyone. Admins/moderators are exempt so a
    // player can't silence their way out of a moderation call made in chat.
    // Persisted (requested 2026-08-16: survive a restart) via db.addSilence/
    // removeSilence, alongside the in-memory Map (still the hot path
    // onPlayerChat checks on every message).
    async function silenceCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length == 0 || msgArray[0][0] != '#' || room.getPlayer(parseInt(msgArray[0].substring(1))) == null) {
            room.sendAnnouncement(
                `Использование: !silence #<id>. Введите "!help silence" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const target = room.getPlayer(parseInt(msgArray[0].substring(1)));
        if (target.id == player.id) {
            room.sendAnnouncement(
                `Вы не можете заглушить самого себя !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (getRole(target) >= Role.ADMIN_TEMP) {
            room.sendAnnouncement(
                `Вы не можете заглушить администратора или модератора !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const viewerAuth = authArray[player.id][0];
        const targetAuth = authArray[target.id][0];
        let silenced = silencedAuths.get(viewerAuth);
        if (silenced && silenced.has(targetAuth)) {
            silenced.delete(targetAuth);
            await db.removeSilence(viewerAuth, targetAuth);
            room.sendAnnouncement(
                `✔️ ${target.name} больше не заглушен для вас !`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        } else {
            if (!silenced) {
                silenced = new Set();
                silencedAuths.set(viewerAuth, silenced);
            }
            silenced.add(targetAuth);
            await db.addSilence(viewerAuth, targetAuth);
            room.sendAnnouncement(
                `🔇 ${target.name} теперь заглушен только для вас ! Введите "!silence #${target.id}" еще раз, чтобы отменить.`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // Calls admins into the room — announces to everyone (HaxNotification.
    // MENTION, same attention-grabbing level !votepause/!voteban use) and
    // pings @here in a dedicated Discord channel via discordBot.sendAdminCall.
    async function reportCommand(player, message) {
        const restriction = await db.getCommandRestriction(authArray[player.id][0], 'report');
        if (restriction) {
            room.sendAnnouncement(
                `Вам запрещено использовать !report (осталось: ${formatBanRemaining(restriction.expiresAt)})${restriction.reason ? ' : ' + restriction.reason : ''}.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (reportCooldownSet.has(player.id)) {
            room.sendAnnouncement(
                `Команду !report можно использовать раз в минуту. Подождите немного.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        reportCooldownSet.add(player.id);
        setTimeout(() => reportCooldownSet.delete(player.id), REPORT_COOLDOWN_MS);
        room.sendAnnouncement(
            `🚨 ${player.name} позвал(а) администрацию !`,
            null,
            errorColor,
            'bold',
            HaxNotification.MENTION
        );
        discordBot.sendAdminCall(player.name);
    }

    // !up (Role.VIP) — claims priority to become the NEXT captain chosen,
    // jumping ahead of whoever's simply first in the spectator queue (see
    // team/choosing.js's resolveNextCaptainId, which both choosePlayer()
    // and team/balance.js's handlePlayersLeave() call whenever an empty
    // side needs a captain). Not available while captains are actively
    // mid-pick (state.chooseMode) — by the time this fires, both captain
    // slots are already filled, there's nothing left to jump ahead of.
    function upCommand(player, message) {
        if (state.chooseMode) {
            room.sendAnnouncement(
                `Нельзя использовать !up, пока капитаны выбирают игроков !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (player.team !== Team.SPECTATORS) {
            room.sendAnnouncement(
                `!up доступен только зрителям !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        // A stale claim (the holder left the spectator pool since claiming
        // — disconnected, or otherwise ended up on a team some other way)
        // frees the slot instead of blocking every other VIP forever.
        if (state.priorityCaptainId != null && !state.teamSpec.some((p) => p.id === state.priorityCaptainId)) {
            state.priorityCaptainId = null;
        }
        if (state.priorityCaptainId != null) {
            // Distinguished from the generic "someone else already claimed
            // it" rejection below (requested 2026-08-15: the two used to
            // share one message, which read to the CALLER like their own
            // already-live claim had just been stolen by someone else —
            // confusing/alarming even though nothing was actually
            // overridden; state.priorityCaptainId is a single slot and
            // every other path here already refuses to replace a live
            // claim with a different one).
            room.sendAnnouncement(
                state.priorityCaptainId === player.id
                    ? `Вы уже в очереди на капитанство — дождитесь следующей итерации !`
                    : `Уже есть VIP в очереди на капитанство — дождитесь следующей итерации !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const auth = authArray[player.id][0];
        // Master is exempt from both rate limits below (requested
        // 2026-08-17 — same reasoning/exemption as !tip's own). The
        // single-slot claim itself (state.priorityCaptainId) is untouched
        // — that's the actual mechanic, not a personal rate limit, so even
        // the master can only hold it once at a time like anyone else.
        const isUnlimited = getRole(player) >= Role.MASTER;
        const dailyUses = pruneUpDailyUsage(auth);
        if (!isUnlimited && dailyUses.length >= upDailyMaxUses) {
            const nextFreeAt = new Date(dailyUses[0] + upDailyWindowMs).toISOString();
            room.sendAnnouncement(
                `!up можно использовать не больше ${upDailyMaxUses} раз в день — использовано ${dailyUses.length}/${upDailyMaxUses}, следующая попытка через ${formatBanRemaining(nextFreeAt)} !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (!isUnlimited && upCooldownMap.has(auth)) {
            room.sendAnnouncement(
                `Команду !up можно использовать раз в час — осталось ${formatBanRemaining(upCooldownMap.get(auth))} !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        state.priorityCaptainId = player.id;
        if (!isUnlimited) {
            const upExpiresAt = new Date(Date.now() + upCooldownMs).toISOString();
            upCooldownMap.set(auth, upExpiresAt);
            setTimeout(() => upCooldownMap.delete(auth), upCooldownMs);
            dailyUses.push(Date.now());
            upDailyUsage.set(auth, dailyUses);
        }
        // Requested 2026-08-15: claiming priority captaincy while AFK is
        // pointless (they'd get picked as captain still tagged AFK) — pull
        // them out automatically, same exitAfk() jjCommand/afkCommand's own
        // toggle-off already use. Called AFTER state.priorityCaptainId is
        // set (not before): exitAfk() -> handlePlayersJoin() can itself
        // trigger an immediate captain-need if the room happens to require
        // one right now, and that re-evaluation must see this claim already
        // in place to actually honor it. A no-op (returns false) if they
        // weren't AFK to begin with.
        exitAfk(player);
        room.sendAnnouncement(
            `⭐ ${player.name} станет капитаном при следующем формировании команд !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        // Same "tell them the actual state, don't make them guess" UX as
        // !mute's own remaining-time line (see events/activity.js's
        // announceMuted) — a private follow-up so the claimant knows
        // exactly how many uses they have left today, not just that this
        // one worked. Rendered as a small block-bar (requested 2026-08-16)
        // rather than a bare "N/3" fraction.
        if (!isUnlimited) {
            room.sendAnnouncement(
                `Использований !up сегодня: ${renderProgressBar(dailyUses.length, upDailyMaxUses)}`,
                player.id,
                infoColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    return {
        leaveCommand,
        helpCommand,
        globalStatsCommand,
        vsCommand,
        tipCommand,
        gifCommand,
        ratingCommand,
        renameCommand,
        customColorsCommand,
        vipColorCommand,
        vipHideCommand,
        vipHelpCommand,
        linkDiscordCommand,
        topsCommand,
        afkCommand,
        jjCommand,
        afkListCommand,
        silenceCommand,
        reportCommand,
        upCommand,
    };
};
