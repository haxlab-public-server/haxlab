/*
 * Per-player stat readouts (gametime, goals, assists, CS, GK time) for one game.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createPlayerStats({
    state,
    Team,
    authArray,
    HaxStatistics,
    getGK,
    getPlayerComp,
}) {
    function getGamePlayerStats(player) {
        const stats = new HaxStatistics(player.name);
        const pComp = getPlayerComp(player);
        stats.goals += getGoalsPlayer(pComp);
        stats.assists += getAssistsPlayer(pComp);
        stats.ownGoals += getOwnGoalsPlayer(pComp);
        stats.playtime += getGametimePlayer(pComp);
        stats.CS += getCSPlayer(pComp);
        return stats;
    }

    function getGametimePlayer(pComp) {
        if (pComp == null) return 0;
        let timePlayer = 0;
        for (let j = 0; j < pComp.timeEntry.length; j++) {
            if (pComp.timeExit.length < j + 1) {
                timePlayer += state.game.scores.time - pComp.timeEntry[j];
            } else {
                timePlayer += pComp.timeExit[j] - pComp.timeEntry[j];
            }
        }
        return Math.floor(timePlayer);
    }

    function getGoalsPlayer(pComp) {
        if (pComp == null) return 0;
        let goalPlayer = 0;
        for (let goal of state.game.goals) {
            if (goal.striker != null && goal.team === pComp.player.team) {
                if (authArray[goal.striker.id][0] == pComp.auth) {
                    goalPlayer++;
                }
            }
        }
        return goalPlayer;
    }

    function getOwnGoalsPlayer(pComp) {
        if (pComp == null) return 0;
        let goalPlayer = 0;
        for (let goal of state.game.goals) {
            if (goal.striker != null && goal.team !== pComp.player.team) {
                if (authArray[goal.striker.id][0] == pComp.auth) {
                    goalPlayer++;
                }
            }
        }
        return goalPlayer;
    }

    function getAssistsPlayer(pComp) {
        if (pComp == null) return 0;
        let assistPlayer = 0;
        for (let goal of state.game.goals) {
            if (goal.assist != null) {
                if (authArray[goal.assist.id][0] == pComp.auth) {
                    assistPlayer++;
                }
            }
        }
        return assistPlayer;
    }

    function getGKPlayer(pComp) {
        if (pComp == null) return 0;
        let GKRed = getGK(Team.RED);
        if (pComp.auth == GKRed?.auth) {
            return Team.RED;
        }
        let GKBlue = getGK(Team.BLUE);
        if (pComp.auth == GKBlue?.auth) {
            return Team.BLUE;
        }
        return Team.SPECTATORS;
    }

    function getCSPlayer(pComp) {
        if (pComp == null || state.game.scores == null) return 0;
        if (getGKPlayer(pComp) == Team.RED && state.game.scores.blue == 0) {
            return 1;
        } else if (getGKPlayer(pComp) == Team.BLUE && state.game.scores.red == 0) {
            return 1;
        }
        return 0;
    }

    function actionReportCountTeam(goals, team) {
        let playerActionSummaryTeam = [];
        let indexTeam = team == Team.RED ? 0 : 1;
        let indexOtherTeam = team == Team.RED ? 1 : 0;
        for (let goal of goals[indexTeam]) {
            if (goal[0] != null) {
                if (playerActionSummaryTeam.find(a => a[0].id == goal[0].id)) {
                    let index = playerActionSummaryTeam.findIndex(a => a[0].id == goal[0].id);
                    playerActionSummaryTeam[index][1]++;
                } else {
                    playerActionSummaryTeam.push([goal[0], 1, 0, 0]);
                }
                if (goal[1] != null) {
                    if (playerActionSummaryTeam.find(a => a[0].id == goal[1].id)) {
                        let index = playerActionSummaryTeam.findIndex(a => a[0].id == goal[1].id);
                        playerActionSummaryTeam[index][2]++;
                    } else {
                        playerActionSummaryTeam.push([goal[1], 0, 1, 0]);
                    }
                }
            }
        }
        if (goals[indexOtherTeam].length == 0) {
            let playerCS = getGK(team)?.player;
            if (playerCS != null) {
                if (playerActionSummaryTeam.find(a => a[0].id == playerCS.id)) {
                    let index = playerActionSummaryTeam.findIndex(a => a[0].id == playerCS.id);
                    playerActionSummaryTeam[index][3]++;
                } else {
                    playerActionSummaryTeam.push([playerCS, 0, 0, 1]);
                }
            }
        }

        playerActionSummaryTeam.sort((a, b) => (a[1] + a[2] + a[3]) - (b[1] + b[2] + b[3]));
        return playerActionSummaryTeam;
    }

    return {
        getGamePlayerStats,
        getGametimePlayer,
        getGoalsPlayer,
        getOwnGoalsPlayer,
        getAssistsPlayer,
        getGKPlayer,
        getCSPlayer,
        actionReportCountTeam,
    };
};
