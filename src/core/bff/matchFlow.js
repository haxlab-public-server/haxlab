/*
 * BFF room match flow. Deliberately NOT team/balance.js: this room has no
 * captain-pick ritual, no swap window, no choose-mode, no random
 * assignment — every match, at every size (not just a full 4v4 house), is
 * assembled by rating (see core/bff/rating.js) the instant enough players
 * are available, and stays fixed until that match ends.
 *
 * Every public function here is async: in the real bridged runtime (see
 * dbBridgeClient.js), `getRating`/`saveRating` cross a Puppeteer
 * page.exposeFunction boundary and are genuinely asynchronous, unlike the
 * direct node:sqlite calls this project's other DB access sometimes gets
 * away with treating loosely — awaiting them here is not optional.
 *
 * `applyLimitsForSize(maxSide)`/`applyTrainingMap()` are injected rather
 * than hardcoded here — the actual map JSON and naming (see
 * core/bff/roomSetup.js) is a wiring-layer decision this module doesn't
 * need to know about.
 */
const { assignBalancedTeams, updateRatingsAfterMatch, defaultRating } = require('./rating');

module.exports = function createBffMatchFlow({
    room,
    state,
    Team,
    State,
    getAuth,
    getRating,
    saveRating,
    applyLimitsForSize,
    applyTrainingMap,
    teamSize,
    reassembleDelayMs,
}) {
    async function ratingFor(auth) {
        return (await getRating(auth)) ?? defaultRating();
    }

    // Builds the best available match from up to 2*teamSize of the
    // LONGEST-WAITING currently-spectating players (any extra beyond that
    // wait, same per-side cap the main room enforces) — see the queue sort
    // below for why "longest-waiting" and not "array order". Does nothing
    // with zero players, or if a match is already live (BFF never
    // interrupts a running match to reassemble — same "don't cut off a
    // live game" principle as the main room). A lone player has no one to
    // balance against, so they go straight to the training map instead of
    // through rating logic — same bootstrap case the main room handles.
    async function assembleMatch() {
        // state.reassembling guards the reassembleDelayMs pause below:
        // without it, any join/leave landing inside that window calls this
        // via handlePlayersJoin/handlePlayersLeave and — since gameState is
        // already STOP by then — would start the next match immediately,
        // cutting the pause short for whoever's still reading the result.
        if (state.gameState !== State.STOP || state.reassembling) return;
        // Sorted by state.specQueueSince (oldest-waiting first), NOT plain
        // array order — real bug fixed here: state.teamSpec's order tracks
        // room.getPlayerList(), effectively room-join order, which has
        // nothing to do with who's actually been waiting to play. Without
        // this, a player benched back to spectators after a match sat at
        // the SAME (low) position they always had, so whenever the room
        // held more waiters than 2*teamSize, the same early joiners kept
        // getting picked every single round and anyone who joined later
        // could wait forever, never once getting pulled in. Missing/never-
        // set entries sort first (?? 0) — a genuine "waiting since before
        // this feature ever ran" case, safest to prioritize rather than
        // starve. See events.js's onPlayerJoin (stamps a fresh join) and
        // this function's own handlePlayersStop below (re-stamps anyone
        // just benched, sending them to the BACK of the queue).
        const queue = [...state.teamSpec].sort((a, b) => (state.specQueueSince.get(a.id) ?? 0) - (state.specQueueSince.get(b.id) ?? 0));
        const available = queue.slice(0, 2 * teamSize);
        if (available.length === 0) return;

        if (available.length === 1) {
            applyTrainingMap();
            room.setPlayerTeam(available[0].id, Team.RED);
            setTimeout(() => {
                room.startGame();
            }, 50);
            return;
        }

        const withRatings = await Promise.all(available.map(async (player) => ({
            player,
            rating: await ratingFor(getAuth(player)),
        })));
        const { teamA, teamB } = assignBalancedTeams(withRatings);

        applyLimitsForSize(Math.max(teamA.length, teamB.length));

        teamA.forEach((entry) => room.setPlayerTeam(entry.player.id, Team.RED));
        teamB.forEach((entry) => room.setPlayerTeam(entry.player.id, Team.BLUE));

        setTimeout(() => {
            room.startGame();
        }, 50);
    }

    async function handlePlayersJoin() {
        await assembleMatch();
    }

    async function handlePlayersLeave() {
        await assembleMatch();
    }

    // Called on EVERY game stop, natural or forced. `outcome` is 'red' |
    // 'blue' | 'draw' for a natural end (byPlayer == null), decided by the
    // caller from the room's actual final score; null for a forced stop.
    // Ratings are updated ONLY for a genuine natural full ranked 4v4
    // (exactly teamSize per side, byPlayer == null) — smaller games are
    // casual and never touch rating, and a forced stop is never a real
    // result either way, per the room's confirmed rule.
    //
    // Real bug fixed here: this used to return immediately whenever
    // byPlayer != null (an admin/native stop, not a real result) — same
    // "not a real result" reasoning as skipping the rating update, but
    // applied to the WRONG scope: it skipped resetting teams and
    // reassembling too. Reported live in the main room once already, in
    // the exact same shape (see team/balance.js's own handlePlayersStop
    // comment) — a forced stop left the roster completely unmanaged, stuck
    // on RED/BLUE forever with nothing left to ever restart the room. Now
    // matches the main room's actual policy: the room keeps working on its
    // own regardless of WHY a match stopped. The one real difference kept:
    // a natural end still waits reassembleDelayMs so players can see the
    // result; a forced stop has no result to show, so it self-heals
    // immediately instead of making everyone sit through a pointless pause.
    async function handlePlayersStop(byPlayer, outcome) {
        if (byPlayer == null && state.teamRed.length === teamSize && state.teamBlue.length === teamSize) {
            const redRatings = await Promise.all(state.teamRed.map((p) => ratingFor(getAuth(p))));
            const blueRatings = await Promise.all(state.teamBlue.map((p) => ratingFor(getAuth(p))));
            const openskillOutcome = outcome === 'red' ? 'teamA' : outcome === 'blue' ? 'teamB' : 'draw';
            const { teamA: updatedRed, teamB: updatedBlue } = updateRatingsAfterMatch(redRatings, blueRatings, openskillOutcome);
            await Promise.all(state.teamRed.map((p, i) => saveRating(getAuth(p), p.name, updatedRed[i].mu, updatedRed[i].sigma)));
            await Promise.all(state.teamBlue.map((p, i) => saveRating(getAuth(p), p.name, updatedBlue[i].mu, updatedBlue[i].sigma)));
        }

        // room.stopGame() does NOT move anyone back to spectators (native
        // HaxBall behavior — team assignment is fully independent of match
        // state) — without this, the just-finished match's players stayed
        // frozen on RED/BLUE forever. Snapshotted into a plain array first:
        // each setPlayerTeam call fires onPlayerTeamChange synchronously,
        // which calls updateTeams() and replaces state.teamRed/teamBlue out
        // from under a live iteration over those same bindings.
        const justPlayed = [...state.teamRed, ...state.teamBlue];
        for (const p of justPlayed) {
            room.setPlayerTeam(p.id, Team.SPECTATORS);
            // Fresh queue timestamp — sends them to the BACK of the
            // fairness queue above, behind anyone who was already waiting.
            state.specQueueSince.set(p.id, Date.now());
        }

        room.stopGame();

        if (byPlayer == null) {
            state.reassembling = true;
            setTimeout(() => {
                state.reassembling = false;
                assembleMatch().catch((err) => console.error('[bff/matchFlow] assembleMatch failed:', err));
            }, reassembleDelayMs);
        } else {
            await assembleMatch();
        }
    }

    return {
        handlePlayersJoin,
        handlePlayersLeave,
        handlePlayersStop,
        assembleMatch,
    };
};
