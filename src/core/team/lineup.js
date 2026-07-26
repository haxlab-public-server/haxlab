/*
 * Tracks each player composition's time in/out of the lineup as teams change.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createLineupHelpers({
    state,
    Team,
    State,
    Situation,
    PlayerComposition,
    authArray,
}) {
    function getStartingLineups() {
        const compositions = [[], []];
        for (let player of state.teamRed) {
            compositions[0].push(
                new PlayerComposition(player, authArray[player.id][0], [0], [])
            );
        }
        for (let player of state.teamBlue) {
            compositions[1].push(
                new PlayerComposition(player, authArray[player.id][0], [0], [])
            );
        }
        return compositions;
    }

    function handleLineupChangeTeamChange(changedPlayer) {
        if (state.gameState != State.STOP) {
            let playerLineup;
            if (changedPlayer.team == Team.RED) {
                // player gets in red team
                const redLineupAuth = state.game.playerComp[0].map((p) => p.auth);
                const ind = redLineupAuth.findIndex((auth) => auth == authArray[changedPlayer.id][0]);
                if (ind != -1) {
                    // Player goes back in
                    playerLineup = state.game.playerComp[0][ind];
                    if (playerLineup.timeExit.includes(state.game.scores.time)) {
                        // gets subbed off then in at the exact same time -> no sub
                        playerLineup.timeExit = playerLineup.timeExit.filter((t) => t != state.game.scores.time);
                    } else {
                        playerLineup.timeEntry.push(state.game.scores.time);
                    }
                } else {
                    playerLineup = new PlayerComposition(
                        changedPlayer,
                        authArray[changedPlayer.id][0],
                        [state.game.scores.time],
                        []
                    );
                    state.game.playerComp[0].push(playerLineup);
                }
            } else if (changedPlayer.team == Team.BLUE) {
                // player gets in blue team
                const blueLineupAuth = state.game.playerComp[1].map((p) => p.auth);
                const ind = blueLineupAuth.findIndex((auth) => auth == authArray[changedPlayer.id][0]);
                if (ind != -1) {
                    // Player goes back in
                    playerLineup = state.game.playerComp[1][ind];
                    if (playerLineup.timeExit.includes(state.game.scores.time)) {
                        // gets subbed off then in at the exact same time -> no sub
                        playerLineup.timeExit = playerLineup.timeExit.filter((t) => t != state.game.scores.time);
                    } else {
                        playerLineup.timeEntry.push(state.game.scores.time);
                    }
                } else {
                    playerLineup = new PlayerComposition(
                        changedPlayer,
                        authArray[changedPlayer.id][0],
                        [state.game.scores.time],
                        []
                    );
                    state.game.playerComp[1].push(playerLineup);
                }
            }
            if (state.teamRed.some((r) => r.id == changedPlayer.id)) {
                // player leaves red team
                const redLineupAuth = state.game.playerComp[0].map((p) => p.auth);
                const ind = redLineupAuth.findIndex((auth) => auth == authArray[changedPlayer.id][0]);
                playerLineup = state.game.playerComp[0][ind];
                if (playerLineup.timeEntry.includes(state.game.scores.time)) {
                    // gets subbed off then in at the exact same time -> no sub
                    if (state.game.scores.time == 0) {
                        state.game.playerComp[0].splice(ind, 1);
                    } else {
                        playerLineup.timeEntry = playerLineup.timeEntry.filter((t) => t != state.game.scores.time);
                    }
                } else {
                    playerLineup.timeExit.push(state.game.scores.time);
                }
            } else if (state.teamBlue.some((r) => r.id == changedPlayer.id)) {
                // player leaves blue team
                const blueLineupAuth = state.game.playerComp[1].map((p) => p.auth);
                const ind = blueLineupAuth.findIndex((auth) => auth == authArray[changedPlayer.id][0]);
                playerLineup = state.game.playerComp[1][ind];
                if (playerLineup.timeEntry.includes(state.game.scores.time)) {
                    // gets subbed off then in at the exact same time -> no sub
                    if (state.game.scores.time == 0) {
                        state.game.playerComp[1].splice(ind, 1);
                    } else {
                        playerLineup.timeEntry = playerLineup.timeEntry.filter((t) => t != state.game.scores.time);
                    }
                } else {
                    playerLineup.timeExit.push(state.game.scores.time);
                }
            }
        }
    }

    function handleLineupChangeLeave(player) {
        if (state.playSituation != Situation.STOP) {
            if (player.team == Team.RED) {
                // player gets in red team
                const redLineupAuth = state.game.playerComp[0].map((p) => p.auth);
                const ind = redLineupAuth.findIndex((auth) => auth == authArray[player.id][0]);
                const playerLineup = state.game.playerComp[0][ind];
                if (playerLineup.timeEntry.includes(state.game.scores.time)) {
                    // gets subbed off then in at the exact same time -> no sub
                    if (state.game.scores.time == 0) {
                        state.game.playerComp[0].splice(ind, 1);
                    } else {
                        playerLineup.timeEntry = playerLineup.timeEntry.filter((t) => t != state.game.scores.time);
                    }
                } else {
                    playerLineup.timeExit.push(state.game.scores.time);
                }
            } else if (player.team == Team.BLUE) {
                // player gets in blue team
                const blueLineupAuth = state.game.playerComp[1].map((p) => p.auth);
                const ind = blueLineupAuth.findIndex((auth) => auth == authArray[player.id][0]);
                const playerLineup = state.game.playerComp[1][ind];
                if (playerLineup.timeEntry.includes(state.game.scores.time)) {
                    // gets subbed off then in at the exact same time -> no sub
                    if (state.game.scores.time == 0) {
                        state.game.playerComp[1].splice(ind, 1);
                    } else {
                        playerLineup.timeEntry = playerLineup.timeEntry.filter((t) => t != state.game.scores.time);
                    }
                } else {
                    playerLineup.timeExit.push(state.game.scores.time);
                }
            }
        }
    }

    return {
        getStartingLineups,
        handleLineupChangeTeamChange,
        handleLineupChangeLeave,
    };
};
