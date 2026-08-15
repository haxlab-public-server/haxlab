/*
 * Persists per-player stats to BFF's own database file and prints
 * leaderboards. Deliberately based on stats/roomStats.js but trimmed: no
 * club stat crediting, no VIP lottery — BFF has neither. Reuses the SAME
 * generic touch/goal-attribution primitives as the main room
 * (stats/global.js, stats/goalAttribution.js, stats/gk.js,
 * stats/playerStats.js) since those have no economy/club coupling at all —
 * confirmed by reading their factory signatures before deciding to share
 * them rather than fork them too.
 */
const { buildRankingString, buildRatingRankingString, buildTopLeaderLine, buildRatingLeaderLine, RANKING_STAT_KEYS } = require('../stats/print');

module.exports = function createBffRoomStats({
    room,
    state,
    Team,
    authArray,
    db,
    HaxStatistics,
    HaxNotification,
    errorColor,
    announcementColor,
    teamSize,
    getAssistsPlayer,
    getCSPlayer,
    getGametimePlayer,
    getGoalsPlayer,
    getOwnGoalsPlayer,
    getPlayerComp,
    getTimeStats,
}) {
    const GAMES_MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000];

    async function updatePlayerStats(player, teamStats) {
        const auth = authArray[player.id][0];
        const pComp = getPlayerComp(player);
        const stats = (await db.getPlayerStats(auth)) ?? new HaxStatistics(player.name);
        stats.games++;
        if (state.lastWinner == teamStats) stats.wins++;
        stats.winrate = ((100 * stats.wins) / (stats.games || 1)).toFixed(1) + `%`;
        stats.goals += getGoalsPlayer(pComp);
        stats.assists += getAssistsPlayer(pComp);
        stats.ownGoals += getOwnGoalsPlayer(pComp);
        stats.CS += getCSPlayer(pComp);
        stats.playtime += getGametimePlayer(pComp);
        await db.savePlayerStats(auth, stats);

        // Round-number games-played milestone (item #24) — same narrow
        // scope as the main room's own (see roomStats.js), just mirrored
        // for BFF's own separate games counter.
        if (GAMES_MILESTONES.includes(stats.games)) {
            room.sendAnnouncement(
                `🎉 ${stats.playerName} сыграл(а) ${stats.games}-й матч в этой комнате !`,
                null, announcementColor, 'bold', HaxNotification.CHAT
            );
        }
    }

    // Same qualifying-match gate as the main room's updateStats() — a full
    // 4v4 that actually reached a real conclusion (time/score limit hit).
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
        }
    }

    async function printRankings(statKey, id = 0) {
        const rankingString = statKey === 'rating'
            ? await buildRatingRankingString(db)
            : await buildRankingString(db, getTimeStats, statKey);
        if (rankingString == null) {
            if (id != 0) {
                room.sendAnnouncement('Недостаточно игр сыграно !', id, errorColor, 'bold', HaxNotification.CHAT);
            }
            return;
        }
        room.sendAnnouncement(rankingString, id, null, 'bold', HaxNotification.CHAT);
    }

    // !tops with no argument — every category in one message (including
    // rating, NOT clubs — BFF has none), skipping any that don't have the
    // 5-player quorum yet rather than erroring. Leader-only per category
    // (real bug fixed 2026-08-15, same wall-of-text problem the main room's
    // own buildAllRankingsText had — see its own comment) — full top-5 for
    // any one category is still exactly `!tops <category>` away.
    async function printAllRankings(id = 0) {
        const playerLines = await Promise.all(RANKING_STAT_KEYS.map((key) => buildTopLeaderLine(db, getTimeStats, key)));
        const ratingLine = await buildRatingLeaderLine(db);
        const lines = [...playerLines, ratingLine].filter((line) => line != null);
        if (lines.length === 0) {
            room.sendAnnouncement('Недостаточно игр сыграно !', id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const categories = [...RANKING_STAT_KEYS.map((k) => k.toLowerCase()), 'rating'].join('|');
        room.sendAnnouncement(`${lines.join('\n')}\nПолная таблица по категории: !tops <${categories}>`, id, null, 'bold', HaxNotification.CHAT);
    }

    return {
        updatePlayerStats,
        updateStats,
        printRankings,
        printAllRankings,
    };
};
