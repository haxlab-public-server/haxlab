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
                // Index 0 both times, not 0 then 1 — room.setPlayerTeam fires
                // room.onPlayerTeamChange synchronously (updateTeams() replaces
                // state.teamSpec with a fresh array), so by the second call the
                // just-moved player is already gone and "index 1" would skip
                // over whoever's actually next in line, not crash but quietly
                // picking the wrong (later) spectator every time.
                room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
                room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
            } else if (state.teamRed.length < state.teamBlue.length)
                room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
            else room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
        }
    }

    function randomButton() {
        if (state.teamSpec.length > 0) {
            if (state.teamRed.length == state.teamBlue.length && state.teamSpec.length > 1) {
                // room.setPlayerTeam fires room.onPlayerTeamChange synchronously,
                // which calls updateTeams() and replaces state.teamSpec with a
                // fresh array — the moved player is already gone from it by the
                // time the next line runs, so just re-reading state.teamSpec
                // here (instead of manually filtering a stale snapshot by a
                // now-stale index) is both simpler and correct. The old manual
                // filter indexed into the ALREADY-updated state.teamSpec using
                // the pre-move index `r`, which could reference a completely
                // different (never-moved) spectator or run past the end of the
                // array — silently dropping someone from the room's pairing for
                // good (this specific button only ever gets a fixed number of
                // calls), which is what caused a 4-player room to sometimes
                // settle on 2v1 instead of 2v2.
                room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.RED);
                room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.BLUE);
            } else if (state.teamRed.length < state.teamBlue.length)
                room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.RED);
            else
                room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.BLUE);
        }
    }

    // These three all move every member of a team (or both) to spectators.
    // Each used to loop with `i < state.teamX.length`/index into
    // state.teamX[...] re-read fresh every iteration — but room.setPlayerTeam
    // synchronously fires room.onPlayerTeamChange, which replaces
    // state.teamRed/teamBlue with brand new (shorter) arrays as a side
    // effect. Since the loop bound and the indexed access were both re-read
    // live against that shrinking array instead of a fixed snapshot, the
    // loop would exit early (the bound shrinks along with the array) and
    // leave the last one or two players stranded on their team instead of
    // benched — e.g. resetButton() on a 2v2 could leave one player on each
    // side instead of clearing both to spectators, which then fed a wrong
    // starting point into whatever ran next (randomButton()'s pairing logic,
    // topButton()'s single pick, etc.) and could settle on an uneven split
    // like 2v1 instead of the intended 2v2. Snapshotting the roster with a
    // spread *before* the loop starts sidesteps this entirely — the moves
    // don't depend on state.teamRed/teamBlue's live value at all anymore.
    function blueToSpecButton() {
        clearTimeout(state.removingTimeout);
        state.removingPlayers = true;
        state.removingTimeout = setTimeout(() => {
            state.removingPlayers = false;
        }, 100);
        for (const player of [...state.teamBlue]) {
            room.setPlayerTeam(player.id, Team.SPECTATORS);
        }
    }

    function redToSpecButton() {
        clearTimeout(state.removingTimeout);
        state.removingPlayers = true;
        state.removingTimeout = setTimeout(() => {
            state.removingPlayers = false;
        }, 100);
        for (const player of [...state.teamRed]) {
            room.setPlayerTeam(player.id, Team.SPECTATORS);
        }
    }

    // Always ends with both teams fully empty — every prior branch this fed
    // into (a draw, or the 4-player "start a fresh 2v2" case) only ever
    // wanted a clean 0v0 to build back up from, so there was never a reason
    // for the old max/min juggling in the first place.
    function resetButton() {
        clearTimeout(state.removingTimeout);
        state.removingPlayers = true;
        state.removingTimeout = setTimeout(() => {
            state.removingPlayers = false;
        }, 100);
        for (const player of [...state.teamRed, ...state.teamBlue]) {
            room.setPlayerTeam(player.id, Team.SPECTATORS);
        }
    }

    // Unlike the three functions above, these for...of loops are already
    // safe: `for...of arr` grabs arr's iterator once, up front — reassigning
    // state.teamBlue/state.teamRed to a new array partway through (as
    // updateTeams() does) doesn't affect an iterator already bound to the
    // old array object. No snapshot needed here.
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
