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
    // with zero players, or if a match is already live (BFF never fully
    // REASSEMBLES/restarts a running match — same "don't cut off a live
    // game" principle as the main room — though a live match's roster CAN
    // still get an exact-parity gap filled from spectators, see below). A
    // lone player has no one to balance against, so they go straight to
    // the training map instead of through rating logic — same bootstrap
    // case the main room handles.
    async function assembleMatch() {
        // state.reassembling guards the reassembleDelayMs pause below:
        // without it, any join/leave landing inside that window calls this
        // via handlePlayersJoin/handlePlayersLeave and — since gameState is
        // already STOP by then — would start the next match immediately,
        // cutting the pause short for whoever's still reading the result.
        if (state.reassembling) return;
        // Real bug fixed here (reported live 2026-08-14: "1 in the room, a
        // 2nd joins, 1v1 doesn't start"): a solo player's training session
        // is NOT a real match — same bootstrap case the main room's own
        // team/balance.js special-cases with an instant training->classic
        // restart the moment a 2nd player shows up. Without this, the
        // blanket "don't interrupt a live match" guard below treated it
        // exactly like a genuine match in progress, so the 2nd joiner just
        // sat in state.teamSpec forever, never promoted into a real game.
        //
        // Deliberately NOT reassigning teams directly in this same call:
        // room.stopGame() re-enters this whole flow synchronously via
        // HaxBall's native onGameStop -> core/bff/events.js's own onGameStop
        // -> handlePlayersStop(null, null) (state.endGameVariable is false
        // here — no real result was ever set — so it takes the "not a
        // natural end" branch, not the rating path). Trying to also
        // reassign teams here, in THIS call, would race that cascade:
        // depending on exactly when HaxBall fires the native event relative
        // to this function's own continuation, handlePlayersStop's own
        // unconditional bench-everyone step could run either before OR
        // after a fresh team assignment made here, either doing nothing
        // useful or immediately un-assigning a match that was just started.
        // Letting handlePlayersStop's own already-correct, already-tested
        // bench+reassemble machinery own the whole transition avoids that
        // race entirely — the one accepted trade-off is the standard
        // reassembleDelayMs pause before the new match actually starts,
        // same as any other match end, rather than an instant restart.
        if (state.gameState !== State.STOP && state.currentStadium === 'training' && state.teamSpec.length > 0) {
            room.stopGame();
            return;
        }
        // Real bugs fixed here (both reported live 2026-08-14), covering a
        // live match's roster WITHOUT restarting/reassembling it — HaxBall
        // allows roster changes mid-match, so neither step below touches
        // ratings, the stadium, or score/time limits, just adds players:
        //
        // 1. "if someone leaves a 1v1 with 1 spectator waiting, it just
        //    continues 1v0 forever, in any team size" — a departure
        //    leaving a side short was never backfilled at all, even when
        //    the gap exactly equals who's waiting. Same policy as the main
        //    room's own team/balance.js balanceTeams(): restore exact
        //    parity only when the gap and the waiting pool match exactly;
        //    a bigger gap is left "just keep playing uneven" rather than
        //    benching someone on the fuller side to force it.
        // 2. "1v1 on the field with 2 spectators doesn't grow to 2v2" —
        //    once already balanced (or just rebalanced by step 1), extra
        //    waiting spectators were never pulled in either, even when the
        //    CURRENT map already supports a bigger even split (classic
        //    supports up to 2v2, big up to teamSize-v-teamSize) — this is
        //    NOT the "auto-upgrade to a bigger arena" the main room
        //    deliberately removed (see haxchill-fixed-match-size memory):
        //    no stadium change happens here, only filling the SAME map up
        //    to what it was already sized for.
        if (state.gameState !== State.STOP) {
            const cap = state.currentStadium === 'classic' ? 2 : teamSize;
            const fillQueue = [...state.teamSpec].sort((a, b) => (state.specQueueSince.get(a.id) ?? 0) - (state.specQueueSince.get(b.id) ?? 0));
            let redCount = state.teamRed.length;
            let blueCount = state.teamBlue.length;

            const diff = redCount - blueCount;
            if (diff !== 0 && Math.abs(diff) === fillQueue.length) {
                const shortSide = diff > 0 ? Team.BLUE : Team.RED;
                fillQueue.forEach((p) => room.setPlayerTeam(p.id, shortSide));
                redCount = blueCount = Math.max(redCount, blueCount);
                fillQueue.length = 0;
            }

            if (redCount === blueCount) {
                while (fillQueue.length >= 2 && redCount < cap) {
                    room.setPlayerTeam(fillQueue.shift().id, Team.RED);
                    room.setPlayerTeam(fillQueue.shift().id, Team.BLUE);
                    redCount++;
                    blueCount++;
                }
            }
            return;
        }

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
        let available = queue.slice(0, 2 * teamSize);
        if (available.length === 0) return;

        if (available.length === 1) {
            applyTrainingMap();
            room.setPlayerTeam(available[0].id, Team.RED);
            setTimeout(() => {
                room.startGame();
            }, 50);
            return;
        }

        // Real bug fixed here (reported live 2026-08-14: going AFK during
        // the post-match pause left a match starting as e.g. 2v1) —
        // confirmed by the room owner as a genuine rule, not a one-off:
        // an uneven match must never START at all, only ever grow/shrink
        // into unevenness later via a mid-match departure that couldn't be
        // exactly restored (see the live-match branch above, an
        // intentionally separate, unrelated policy). An odd headcount here
        // drops the SINGLE most-recently-arrived candidate (the tail of
        // the fairness queue sorted above) rather than starting lopsided —
        // they're simply left untouched in state.teamSpec with their
        // existing timestamp, so they're first in line, not last, the
        // next time assembleMatch() runs.
        if (available.length % 2 !== 0) {
            available = available.slice(0, -1);
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
