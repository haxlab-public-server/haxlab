/*
 * Persists per-player stats to the database after a game and prints leaderboards.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
const { buildRankingString, buildAllRankingsText, buildClubRankingString } = require('./print');

module.exports = function createRoomStats({
    room,
    state,
    Team,
    authArray,
    db,
    HaxStatistics,
    HaxNotification,
    errorColor,
    infoColor,
    announcementColor,
    teamSize,
    getAssistsPlayer,
    getCSPlayer,
    getGametimePlayer,
    getGoalsPlayer,
    getOwnGoalsPlayer,
    getPlayerComp,
    getTimeStats,
    applyVipGrant,
    random,
}) {
    const GAMES_MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000];

    // Each player on the WINNING side of a genuine full 4v4 quals match
    // (same gate updateStats() already requires below) gets an independent
    // 0.5% roll at a week of VIP — a fun rare bonus, not a grind reward like
    // the coin economy. Draws never roll at all (nobody "won"). A player
    // who's already VIP just quietly doesn't win again (see rollVipLottery)
    // rather than stacking or extending — same "already VIP" no-op every
    // other grant path (commands/master.js's setVipCommand/grantVipByAuth)
    // already treats as a dead end, not an error.
    //
    // `random` is injected (entry.js passes Math.random) rather than called
    // directly, specifically so tests can substitute a deterministic
    // function instead of monkey-patching the actual global Math.random —
    // this file's own tests run as interleaved, unawaited async blocks (see
    // tools/smoke-test.js), so temporarily replacing a REAL global here
    // would risk leaking into some other, unrelated test's randomness
    // mid-await.
    const VIP_LOTTERY_CHANCE = 0.005;
    const VIP_LOTTERY_DAYS = 3;

    // Russian day-count pluralization (день/дня/дней) — was hardcoded
    // "дней" before, which only ever happened to be correct because 7
    // (the old VIP_LOTTERY_DAYS) needs "дней" too; 3 needs "дня" instead,
    // so this stopped being a coincidence-proof shortcut the moment the
    // duration changed. Same mod10/mod100 shape as utils.js's own
    // formatCoins pluralization.
    function pluralizeDays(n) {
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11) return 'день';
        if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'дня';
        return 'дней';
    }

    async function rollVipLottery(player) {
        if (random() >= VIP_LOTTERY_CHANCE) return;
        const auth = authArray[player.id][0];
        if (state.vipList.some((v) => v[0] === auth)) return;
        const expiresAt = new Date(Date.now() + VIP_LOTTERY_DAYS * 24 * 60 * 60000).toISOString();
        await applyVipGrant(auth, player.name, expiresAt);
        room.sendAnnouncement(
            `🎰 ${player.name} выиграл(а) VIP на ${VIP_LOTTERY_DAYS} ${pluralizeDays(VIP_LOTTERY_DAYS)} по счастливому билету за победу в матче 4х4 !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }
    async function updatePlayerStats(player, teamStats) {
        const auth = authArray[player.id][0];
        const pComp = getPlayerComp(player);
        const stats = (await db.getPlayerStats(auth)) ?? new HaxStatistics(player.name);
        stats.games++;
        if (state.lastWinner == teamStats) stats.wins++;
        stats.winrate = ((100 * stats.wins) / (stats.games || 1)).toFixed(1) + `%`;
        const goals = getGoalsPlayer(pComp);
        const assists = getAssistsPlayer(pComp);
        const CS = getCSPlayer(pComp);
        stats.goals += goals;
        stats.assists += assists;
        stats.ownGoals += getOwnGoalsPlayer(pComp);
        stats.CS += CS;
        stats.playtime += getGametimePlayer(pComp);
        await db.savePlayerStats(auth, stats);

        // Round-number games-played milestone (item #24) — deliberately
        // narrow scope (see haxchill-ux-reliability-backlog project memory:
        // flagged as the lower-confidence item of the batch, "more feature
        // than fix"): just a one-line public congratulation on a fixed set
        // of round numbers, nothing stateful beyond the games count
        // player_stats already tracks — no new table, no streak/achievement
        // system. stats.games is POST-increment here, so this fires exactly
        // once, on the exact match that crosses the milestone.
        if (GAMES_MILESTONES.includes(stats.games)) {
            room.sendAnnouncement(
                `🎉 ${stats.playerName} сыграл(а) ${stats.games}-й матч в этой комнате !`,
                null, announcementColor, 'bold', HaxNotification.CHAT
            );
        }

        // !tops clubs (see db.addClubStats) — credited at this same
        // per-match granularity, keyed off CURRENT club membership
        // (state.clubMembers) right now: a player who has since left their
        // club stops contributing to it going forward, but whatever they
        // already earned while a member stays on the club's record — there's
        // no retroactive removal, only no further additions.
        const membership = state.clubMembers.find((m) => m.auth === auth);
        if (membership && (goals > 0 || assists > 0 || CS > 0)) {
            await db.addClubStats(membership.clubId, { goals, assists, cleanSheets: CS });
        }
    }

    async function updateStats() {
        if (
            state.players.length >= 2 * teamSize &&
            (
                state.game.scores.time >= (5 / 6) * state.game.scores.timeLimit ||
                state.game.scores.red == state.game.scores.scoreLimit ||
                state.game.scores.blue == state.game.scores.scoreLimit
            ) &&
            state.teamRedStats.length >= teamSize && state.teamBlueStats.length >= teamSize
        ) {
            for (let player of state.teamRedStats) {
                await updatePlayerStats(player, Team.RED);
            }
            for (let player of state.teamBlueStats) {
                await updatePlayerStats(player, Team.BLUE);
            }
            // Refreshes the "who currently holds #1" snapshot trophies
            // (commands/trophies.js) and the chat prefix read off of —
            // once per completed match, since that's the only time these
            // stats actually change, not per chat message.
            state.topPlayers = await db.getTopPlayers();

            // VIP lottery (see rollVipLottery above) — only the WINNING
            // side rolls, and only on a genuine decisive result;
            // state.lastWinner sits outside Team.RED/Team.BLUE on a draw
            // (see economy.js's awardMatchCoins), so a draw never rolls.
            if (state.lastWinner === Team.RED || state.lastWinner === Team.BLUE) {
                const winners = state.lastWinner === Team.RED ? state.teamRedStats : state.teamBlueStats;
                for (const player of winners) {
                    await rollVipLottery(player);
                }
            }
        }
    }

    async function printRankings(statKey, id = 0) {
        const rankingString = await buildRankingString(db, getTimeStats, statKey);
        if (rankingString == null) {
            if (id != 0) {
                room.sendAnnouncement(
                    'Недостаточно игр сыграно !',
                    id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            return;
        }
        room.sendAnnouncement(
            rankingString,
            id,
            null,
            'bold',
            HaxNotification.CHAT
        );
    }

    // !tops with no argument — every category in one message, skipping any
    // that don't have the 5-player quorum yet rather than erroring.
    async function printAllRankings(id = 0) {
        const text = await buildAllRankingsText(db, getTimeStats);
        if (text == null) {
            room.sendAnnouncement(
                'Недостаточно игр сыграно !',
                id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        room.sendAnnouncement(
            text,
            id,
            null,
            'bold',
            HaxNotification.CHAT
        );
    }

    // !tops clubs — separate from printRankings since clubs rank by a
    // combined goals+assists+clean_sheets score (see db.getTopClubs), not a
    // single player_stats column, and have no 5-quorum gate (see
    // buildClubRankingString).
    async function printClubRankings(id = 0) {
        const rankingString = await buildClubRankingString(db);
        if (rankingString == null) {
            if (id != 0) {
                room.sendAnnouncement(
                    'Ни один клуб еще не заработал очков !',
                    id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            return;
        }
        room.sendAnnouncement(
            rankingString,
            id,
            null,
            'bold',
            HaxNotification.CHAT
        );
    }

    return {
        updatePlayerStats,
        updateStats,
        printRankings,
        printAllRankings,
        printClubRankings,
    };
};
