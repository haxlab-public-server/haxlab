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
const { assignBalancedTeams, updateRatingsAfterMatch, computeOrdinal, defaultRating } = require('./rating');
const { formatRatingDisplay } = require('../utils');

module.exports = function createBffMatchFlow({
    room,
    state,
    Team,
    State,
    getAuth,
    getRating,
    saveRating,
    saveRatingHistory,
    applyLimitsForSize,
    applyTrainingMap,
    teamSize,
    reassembleDelayMs,
    HaxNotification,
    announcementColor,
    infoColor,
    actionReportCountTeam,
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
        //    leaving a side short was never backfilled at all. Same policy
        //    as the main room's own team/balance.js balanceTeams(): only
        //    restore exact parity, never force a fill by benching someone
        //    on the fuller side. Real bug fixed here too (reported live
        //    2026-08-14 in 4v4 specifically): the original check required
        //    the waiting pool to be EXACTLY the gap size
        //    (`Math.abs(diff) === fillQueue.length`) — with more people
        //    waiting than the gap (routine at 4v4, since the room holds up
        //    to 14 while a match only uses 8), that equality never held, so
        //    a departure was never backfilled at all despite plenty waiting.
        //    Fixed to require only ENOUGH waiting (`>=`), taking just the
        //    needed number (oldest-first) and leaving any surplus in the
        //    queue for the growth step below.
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
            if (diff !== 0 && fillQueue.length >= Math.abs(diff)) {
                const shortSide = diff > 0 ? Team.BLUE : Team.RED;
                const needed = Math.abs(diff);
                for (let i = 0; i < needed; i++) {
                    room.setPlayerTeam(fillQueue.shift().id, shortSide);
                }
                redCount = blueCount = Math.max(redCount, blueCount);
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

            // Personal contribution (requested 2026-08-16: "объедини вклады
            // и послематчевую статистику") — same [player, goals, assists,
            // CS] tuples events.js's own recap/MVP are built from, keyed by
            // player.id for an O(1) per-player lookup below rather than
            // re-scanning state.game.goals once per player.
            const goalsByTeam = [[], []];
            for (const g of state.game.goals) goalsByTeam[g.team - 1].push([g.striker, g.assist]);
            const personalActions = new Map();
            for (const team of [Team.RED, Team.BLUE]) {
                for (const act of actionReportCountTeam(goalsByTeam, team)) {
                    personalActions.set(act[0].id, { goals: act[1], assists: act[2], CS: act[3] });
                }
            }
            const formatContribution = (playerId) => {
                const action = personalActions.get(playerId);
                const parts = [];
                if (action?.goals > 0) parts.push(`${action.goals}⚽`);
                if (action?.assists > 0) parts.push(`${action.assists}🅰️`);
                if (action?.CS > 0) parts.push(`${action.CS}🧤`);
                return parts.length > 0 ? parts.join(', ') : 'без результативных действий';
            };

            // Rating delta feedback, merged with the personal-contribution
            // line above into ONE message — a ranked result silently
            // changing a number nobody sees change is invisible progress.
            // Uses the same formatRatingDisplay rescale !me/!tops rating
            // display (see stats/print.js), so this line and !me's own
            // number always agree — a linear rescale, so subtracting two
            // already-rescaled values is exactly as correct as subtracting
            // the raw ordinals. Also persisted to rating_history (already
            // in display units) for !sf's "за последние N игр" trend line.
            const reportDelta = (players, before, after) => players.forEach((p, i) => {
                const afterDisplay = formatRatingDisplay(computeOrdinal(after[i]));
                const beforeDisplay = formatRatingDisplay(computeOrdinal(before[i]));
                const delta = afterDisplay - beforeDisplay;
                const sign = delta > 0 ? '+' : '';
                saveRatingHistory(getAuth(p), delta).catch((err) => console.error('[bff/matchFlow] saveRatingHistory failed:', err));
                room.sendAnnouncement(
                    `Твой вклад: ${formatContribution(p.id)} | 📊 Рейтинг: ${afterDisplay} (${sign}${delta})`,
                    p.id, infoColor, 'bold', HaxNotification.CHAT
                );
            });
            reportDelta(state.teamRed, redRatings, updatedRed);
            reportDelta(state.teamBlue, blueRatings, updatedBlue);
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
            room.sendAnnouncement(`⏱️ Следующий матч через ${Math.round(reassembleDelayMs / 1000)} сек...`, null, announcementColor, 'bold', HaxNotification.CHAT);
            setTimeout(() => {
                state.reassembling = false;
                assembleMatch().catch((err) => console.error('[bff/matchFlow] assembleMatch failed:', err));
            }, reassembleDelayMs);
        } else {
            // Real bug fixed here (reported live 2026-08-14: "если админ
            // стопает игру... 8 человек в зрителях, а иногда собиралось
            // 2х2" — should be the max the headcount supports, e.g. 4v4).
            // This used to call assembleMatch() synchronously, immediately
            // after the bench loop above — but that loop just fired up to
            // 2*teamSize back-to-back room.setPlayerTeam() calls, and
            // assembleMatch() reads state.teamSpec, which is only updated
            // by each call's own onPlayerTeamChange echo landing. The main
            // room's team/balance.js has extensive documented history of
            // this EXACT race (see its own handlePlayersStop comments on
            // "the just-benched losers weren't reliably counted in
            // state.teamSpec yet, undercounting how many were actually
            // available") — a tight loop of setPlayerTeam calls is not
            // reliably fully echoed before the very next line runs in real
            // production. Assembling too early saw only a partial bench
            // (e.g. 4 of 8 already landed), forming a smaller match (2v2)
            // than the full house actually available (4v4). Fixed with the
            // same short defer balance.js already relies on for this exact
            // purpose, so every bench call's echo has landed first.
            setTimeout(() => {
                assembleMatch().catch((err) => console.error('[bff/matchFlow] assembleMatch failed:', err));
            }, 10);
        }
    }

    return {
        handlePlayersJoin,
        handlePlayersLeave,
        handlePlayersStop,
        assembleMatch,
    };
};
