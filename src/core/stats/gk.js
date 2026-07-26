/*
 * Identifies each team's goalkeeper and tracks clean sheets.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createGkHelpers({
    state,
    Team,
    getPlayerComp,
}) {
    function handleGKTeam(team) {
        if (team == Team.SPECTATORS) {
            return null;
        }
        let teamArray = team == Team.RED ? state.teamRed : state.teamBlue;
        let playerGK = teamArray.reduce((prev, current) => {
            if (team == Team.RED) {
                return (prev?.position.x < current.position.x) ? prev : current
            } else {
                return (prev?.position.x > current.position.x) ? prev : current
            }
        }, null);
        let playerCompGK = getPlayerComp(playerGK);
        return playerCompGK;
    }

    function handleGK() {
        let redGK = handleGKTeam(Team.RED);
        if (redGK != null) {
            redGK.GKTicks++;
        }
        let blueGK = handleGKTeam(Team.BLUE);
        if (blueGK != null) {
            blueGK.GKTicks++;
        }
    }

    function getGK(team) {
        if (team == Team.SPECTATORS) {
            return null;
        }
        let teamArray = team == Team.RED ? state.game.playerComp[0] : state.game.playerComp[1];
        let playerGK = teamArray.reduce((prev, current) => {
            return (prev?.GKTicks > current.GKTicks) ? prev : current
        }, null);
        return playerGK;
    }

    function getCS(scores) {
        let playersNameCS = [];
        let redGK = getGK(Team.RED);
        let blueGK = getGK(Team.BLUE);
        if (redGK != null && scores.blue == 0) {
            playersNameCS.push(redGK.player.name);
        }
        if (blueGK != null && scores.red == 0) {
            playersNameCS.push(blueGK.player.name);
        }
        return playersNameCS;
    }

    function getCSString(scores) {
        let playersCS = getCS(scores);
        if (playersCS.length == 0) {
            return "🥅 Нет сухарей";
        } else if (playersCS.length == 1) {
            return `🥅 ${playersCS[0]} получил сухарь.`;
        } else {
            return `🥅 ${playersCS[0]} и ${playersCS[1]} получили сухари.`;
        }
    }

    return {
        handleGKTeam,
        handleGK,
        getGK,
        getCS,
        getCSString,
    };
};
