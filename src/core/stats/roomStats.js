/*
 * Persists per-player stats to the database after a game and prints leaderboards.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
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
    teamSize,
    getAssistsPlayer,
    getCSPlayer,
    getGametimePlayer,
    getGoalsPlayer,
    getOwnGoalsPlayer,
    getPlayerComp,
    getTimeStats,
}) {
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
        }
    }

    const STAT_LABELS = {
        games: 'Игры',
        wins: 'Победы',
        goals: 'Голы',
        assists: 'Ассисты',
        CS: 'Сухие матчи',
        playtime: 'Время игры',
    };

    async function printRankings(statKey, id = 0) {
        statKey = statKey == "cs" ? "CS" : statKey;
        const leaderboard = await db.getLeaderboard(statKey, 5);
        if (leaderboard.length < 5) {
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
        let rankingString = `${STAT_LABELS[statKey] ?? statKey}> `;
        for (let i = 0; i < 5; i++) {
            let playerName = leaderboard[i].playerName;
            let playerStat = leaderboard[i].value;
            if (statKey == 'playtime') playerStat = getTimeStats(playerStat);
            rankingString += `#${i + 1} ${playerName} : ${playerStat}, `;
        }
        rankingString = rankingString.substring(0, rankingString.length - 2);
        room.sendAnnouncement(
            rankingString,
            id,
            infoColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    return {
        updatePlayerStats,
        updateStats,
        printRankings,
    };
};
