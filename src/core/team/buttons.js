/*
 * UI buttons shown to players: random/top/swap picks and moving a team to spectators.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createButtonHelpers({
    room,
    state,
    Team,
    getRandomInt,
}) {
    function topButton() {
        if (state.teamSpec.length > 0) {
            if (state.teamRed.length == state.teamBlue.length && state.teamSpec.length > 1) {
                room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
                room.setPlayerTeam(state.teamSpec[1].id, Team.BLUE);
            } else if (state.teamRed.length < state.teamBlue.length)
                room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
            else room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
        }
    }

    function randomButton() {
        if (state.teamSpec.length > 0) {
            if (state.teamRed.length == state.teamBlue.length && state.teamSpec.length > 1) {
                const r = getRandomInt(state.teamSpec.length);
                room.setPlayerTeam(state.teamSpec[r].id, Team.RED);
                state.teamSpec = state.teamSpec.filter((spec) => spec.id != state.teamSpec[r].id);
                room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.BLUE);
            } else if (state.teamRed.length < state.teamBlue.length)
                room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.RED);
            else
                room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.BLUE);
        }
    }

    function blueToSpecButton() {
        clearTimeout(state.removingTimeout);
        state.removingPlayers = true;
        state.removingTimeout = setTimeout(() => {
            state.removingPlayers = false;
        }, 100);
        for (let i = 0; i < state.teamBlue.length; i++) {
            room.setPlayerTeam(state.teamBlue[state.teamBlue.length - 1 - i].id, Team.SPECTATORS);
        }
    }

    function redToSpecButton() {
        clearTimeout(state.removingTimeout);
        state.removingPlayers = true;
        state.removingTimeout = setTimeout(() => {
            state.removingPlayers = false;
        }, 100);
        for (let i = 0; i < state.teamRed.length; i++) {
            room.setPlayerTeam(state.teamRed[state.teamRed.length - 1 - i].id, Team.SPECTATORS);
        }
    }

    function resetButton() {
        clearTimeout(state.removingTimeout);
        state.removingPlayers = true;
        state.removingTimeout = setTimeout(() => {
            state.removingPlayers = false;
        }, 100);
        for (let i = 0; i < Math.max(state.teamRed.length, state.teamBlue.length); i++) {
            if (Math.max(state.teamRed.length, state.teamBlue.length) - state.teamRed.length - i > 0)
                room.setPlayerTeam(state.teamBlue[state.teamBlue.length - 1 - i].id, Team.SPECTATORS);
            else if (Math.max(state.teamRed.length, state.teamBlue.length) - state.teamBlue.length - i > 0)
                room.setPlayerTeam(state.teamRed[state.teamRed.length - 1 - i].id, Team.SPECTATORS);
            else break;
        }
        for (let i = 0; i < Math.min(state.teamRed.length, state.teamBlue.length); i++) {
            room.setPlayerTeam(
                state.teamBlue[Math.min(state.teamRed.length, state.teamBlue.length) - 1 - i].id,
                Team.SPECTATORS
            );
            room.setPlayerTeam(
                state.teamRed[Math.min(state.teamRed.length, state.teamBlue.length) - 1 - i].id,
                Team.SPECTATORS
            );
        }
    }

    function swapButton() {
        clearTimeout(state.removingTimeout);
        state.removingPlayers = true;
        state.removingTimeout = setTimeout(() => {
            state.removingPlayers = false;
        }, 100);
        for (let player of state.teamBlue) {
            room.setPlayerTeam(player.id, Team.RED);
        }
        for (let player of state.teamRed) {
            room.setPlayerTeam(player.id, Team.BLUE);
        }
    }

    return {
        topButton,
        randomButton,
        blueToSpecButton,
        redToSpecButton,
        resetButton,
        swapButton,
    };
};
