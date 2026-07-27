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
            if (state.teamRed.length == state.teamBlue.length) {
                // Only fill an EVEN pair when starting from parity. An odd
                // one left over (state.teamSpec.length == 1 here) has nobody
                // to pair with yet and must stay benched — callers that loop
                // this a fixed number of times (once per waiting spectator)
                // rely on this being a no-op past the last real pair, since
                // they don't recompute after each call. Without this guard,
                // that extra call fell through to the plain `else` below and
                // forced the lone leftover onto blue regardless, quietly
                // turning an already-fair NxN split into an unwanted (N+1)xN
                // (e.g. a fair 1v1 plus one unrelated onlooker settling on
                // 1v2 once the loop ran one call too many).
                if (state.teamSpec.length > 1) {
                    // Index 0 both times, not 0 then 1 — room.setPlayerTeam fires
                    // room.onPlayerTeamChange, which calls updateTeams() and
                    // replaces state.teamSpec with a fresh array, so index 1
                    // would skip over whoever's actually next in line.
                    // A real tick apart (setTimeout, not back-to-back in the
                    // same call), not just index [0] both times: two
                    // room.setPlayerTeam calls fired back-to-back with zero
                    // gap wasn't reliably enough for state.teamSpec to have
                    // actually shrunk by the second call in production — the
                    // second call could still see the SAME just-moved player
                    // at index 0 and yank them from RED onto BLUE instead of
                    // picking the next spectator, leaving red short one and
                    // the real next-in-line stuck spectating (a 3v3 growing
                    // to 3v4 instead of 4v4, one waiting spectator ignored).
                    room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
                    setTimeout(() => {
                        // Something else (another topButton()/randomButton()
                        // call, a balanceTeams() run triggered by a join
                        // landing in this same 5ms gap, etc.) can drain the
                        // last waiting spectator before this fires — without
                        // this guard, state.teamSpec[0] is undefined and
                        // .id throws, aborting whatever the rest of this
                        // rebuild sequence still had queued and leaving the
                        // teams wherever they happened to land mid-refill.
                        if (state.teamSpec.length > 0) {
                            room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
                        }
                    }, 5);
                }
            } else if (state.teamRed.length < state.teamBlue.length)
                room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
            else room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
        }
    }

    function randomButton() {
        if (state.teamSpec.length > 0) {
            if (state.teamRed.length == state.teamBlue.length) {
                // Same "only fill an even pair" guard as topButton() above —
                // see its comment for why a lone leftover spectator must stay
                // benched instead of being forced onto blue.
                if (state.teamSpec.length > 1) {
                    // room.setPlayerTeam fires room.onPlayerTeamChange, which calls
                    // updateTeams() and replaces state.teamSpec with a fresh array —
                    // re-reading state.teamSpec.length fresh for the second pick
                    // (instead of a stale pre-move index `r`) is both simpler and
                    // correct on its own. But see topButton()'s identical comment:
                    // a real tick (setTimeout) between the two calls, not just
                    // back-to-back in the same call, since state.teamSpec wasn't
                    // reliably guaranteed to have shrunk yet by the time the second
                    // call ran in production — it could still draw from the SAME
                    // (already-moved) player, or otherwise misjudge who's left.
                    room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.RED);
                    setTimeout(() => {
                        // See topButton()'s identical guard: something else
                        // can drain the last waiting spectator during this
                        // 5ms gap, and indexing into an empty teamSpec would
                        // throw and abort the rest of this rebuild sequence.
                        if (state.teamSpec.length > 0) {
                            room.setPlayerTeam(state.teamSpec[getRandomInt(state.teamSpec.length)].id, Team.BLUE);
                        }
                    }, 5);
                }
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

    // Both teams must be snapshotted before EITHER loop runs: moving the
    // blue players to red first reassigns state.teamRed to include them, so
    // a second loop reading state.teamRed live would pick up the players
    // just moved by the first loop (and bounce them straight back to blue)
    // instead of the original red team.
    function swapButton() {
        clearTimeout(state.removingTimeout);
        state.removingPlayers = true;
        state.removingTimeout = setTimeout(() => {
            state.removingPlayers = false;
        }, 100);
        const wasBlue = [...state.teamBlue];
        const wasRed = [...state.teamRed];
        for (let player of wasBlue) {
            room.setPlayerTeam(player.id, Team.RED);
        }
        for (let player of wasRed) {
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
