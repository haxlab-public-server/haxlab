/*
 * Keeps red/blue balanced as players join, leave, switch teams or go AFK.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createTeamBalance({
    room,
    state,
    Team,
    State,
    HaxNotification,
    emptyPlayer,
    infoColor,
    scoreLimit,
    teamSize,
    timeLimit,
    activateChooseMode,
    blueToSpecButton,
    choosePlayer,
    deactivateChooseMode,
    endGame,
    getRandomInt,
    getSpecList,
    instantRestart,
    randomButton,
    redToSpecButton,
    resetButton,
    resumeGame,
    stadiumCommand,
    swapButton,
    topButton,
}) {
    // Single source of truth for "what map should this room be on right
    // now" — driven by whichever side is currently BIGGER, not raw total
    // player count. Total count alone can't tell apart shapes that need
    // different maps: a 4-total room could be a clean 2v2 (fits classic)
    // or an uneven 3v1 the room kept playing per its own "don't bench"
    // policy (needs big, since one side still has 3). Never returns
    // 'training' — that's the one-player bootstrapping stadium, decided
    // separately by whoever's about to instantRestart() into it.
    //
    // Only ever called from genuine "safe to restart" moments (between
    // rounds, in handlePlayersStop/handlePlayersTeamChange's completion
    // branches) — never from balanceTeams() itself while a match may still
    // be live, since switching stadiums reloads the map and would cut off
    // an in-progress game the room's policy deliberately lets keep playing
    // uneven/shrunk instead of interrupting.
    function desiredStadiumFor(maxSide) {
        return maxSide <= 2 ? 'classic' : 'big';
    }
    function reassertStadium() {
        const desired = desiredStadiumFor(Math.max(state.teamRed.length, state.teamBlue.length));
        if (state.currentStadium != desired) {
            stadiumCommand(emptyPlayer, `!${desired}`);
        }
    }

    // Safety net around room.startGame(): whatever sequence of
    // benches/pulls/pairs led here, if there are up to a full house's worth
    // of players (<=2*teamSize) and the field is uneven, top it back up to
    // parity (pullSpectatorsToParity() — pull from spectators, cross-move
    // if genuinely none are available) instead of kicking off with a
    // player parked who should be on the field, or sitting lopsided
    // forever. Uses that narrow primitive rather than the general
    // balanceTeams() specifically because pullSpectatorsToParity() never
    // touches state.chooseMode — this function's own onSettled() is what
    // schedules room.startGame() moments later, so it must never fire
    // while a genuine interactive choose-mode session is active.
    //
    // Bug (reported live): that session doesn't have to come from THIS
    // function's own pull to be a problem — this runs 2000ms after a match
    // ends (see handlePlayersStop's scheduleRestart), and an ordinary join
    // or leave landing anywhere in that window can independently activate
    // real choosing via balanceTeams()'s own "abs(diff)<specLen, full
    // house" branch (pausing the game, prompting a captain). Without
    // checking state.chooseMode here, this would still call onSettled()
    // regardless once its own pull settles, forcing room.startGame() out
    // from under that in-progress pick (reported live as "капитана всё
    // равно нет, игра стартует 4x0"). Checked both up front (in case it
    // was already true before this function even started) and again after
    // the pull settles (in case an event landed during it) — if it's
    // active either time, this bails out entirely and leaves starting the
    // game to that session's own completion path
    // (handlePlayersTeamChange's resumeGame()/room.startGame(), once
    // picking is genuinely done) instead of racing it.
    function ensureFullFieldBeforeStart(onSettled) {
        if (state.chooseMode) {
            return;
        }
        if (state.players.length > 2 * teamSize) {
            if (onSettled) onSettled();
            return;
        }
        pullSpectatorsToParity(() => {
            if (state.chooseMode) {
                return;
            }
            reassertStadium();
            if (onSettled) onSettled();
        });
    }

    // Every staggered spectator-pull below schedules its moves as a fixed
    // count of setTimeout calls computed once up front from teamSpec's
    // length at that moment — but a concurrent leave/join (or another
    // balanceTeams() run) landing in one of those gaps can drain teamSpec
    // before a later call in the batch fires. Indexing into it empty would
    // throw and abort whatever's still queued behind it, so every one of
    // these deferred moves goes through this guard instead of indexing
    // state.teamSpec directly.
    function safeMoveNextSpec(team) {
        if (state.teamSpec.length > 0) {
            room.setPlayerTeam(state.teamSpec[0].id, team);
        }
    }

    // How many waiting spectators to pull in after a bench, capped by both
    // how many actually fit (2*teamSize total) and how many are waiting.
    // Bug: this used to just be that raw cap — filling the smaller side up
    // to it regardless of whether the LAST pull landed on an even split.
    // safeMoveNextSpec always fills whichever side is smaller (ties go
    // red), so once parity was reached mid-drain, the next pull immediately
    // re-broke it (e.g. a 1v1 with one waiting spectator restored the 1v1
    // correctly on the first pull, then the loop kept going and dragged
    // that same spectator in anyway, landing on 2v1). Fill up to parity
    // with the bigger side, then only continue in genuine PAIRS beyond
    // that — same principle as topButton()/randomButton()'s own "a lone
    // leftover stays benched" guard.
    function computeSpectatorsToInsert() {
        const diff = Math.abs(state.teamRed.length - state.teamBlue.length);
        const spaceLeft = 2 * teamSize - state.teamRed.length - state.teamBlue.length;
        const available = Math.min(state.teamSpec.length, spaceLeft);
        const towardParity = Math.min(available, diff);
        const remainingPairs = Math.floor((available - towardParity) / 2);
        return towardParity + remainingPairs * 2;
    }

    // The core "close the numeric gap using whoever's actually available"
    // mechanic — used to be reimplemented slightly differently in three
    // places (balanceTeams()'s own "abs(diff)>specLen" branch,
    // handlePlayersStop's WinStay bench+refill branches, and
    // ensureFullFieldBeforeStart), each patched separately over several
    // reported bugs this session. Unified here: pull from state.teamSpec to
    // parity-then-pairs first (computeSpectatorsToInsert() — already
    // correct, untouched), then, once that settles, if the gap is STILL
    // >=2 with spectators genuinely exhausted, cross-move the excess from
    // the bigger side (rule 3: nxn-2 with zero spectators moves the last
    // player across instead of sitting uneven). Deliberately never touches
    // state.chooseMode / activateChooseMode() — this is the "always safe,
    // never triggers interactive picking" primitive, unlike balanceTeams()
    // itself (whose own "abs(diff)<specLen, full house" branch DOES
    // activate real choosing — calling balanceTeams() from
    // ensureFullFieldBeforeStart used to risk hitting that branch right
    // before a forced room.startGame(), yanking the game out from under an
    // in-progress pick; using this narrower primitive there instead fixes
    // that). When there's nothing at all to pull (n===0), the cross-move
    // check — and its first move, if needed — runs synchronously, matching
    // every direct balanceTeams() caller's expectation of seeing an
    // immediate effect; any further moves, or the whole sequence when
    // there WAS something to pull first, stay staggered.
    function pullSpectatorsToParity(callback) {
        const n = computeSpectatorsToInsert();
        const runCrossMove = () => {
            if (state.teamSpec.length !== 0 || Math.abs(state.teamRed.length - state.teamBlue.length) < 2) {
                if (callback) callback();
                return;
            }
            const movesNeeded = Math.floor(Math.abs(state.teamRed.length - state.teamBlue.length) / 2);
            const moveOneAcross = () => {
                if (Math.abs(state.teamRed.length - state.teamBlue.length) >= 2) {
                    const biggerTeam = state.teamRed.length > state.teamBlue.length ? state.teamRed : state.teamBlue;
                    const smallerSide = state.teamRed.length > state.teamBlue.length ? Team.BLUE : Team.RED;
                    room.setPlayerTeam(biggerTeam[biggerTeam.length - 1].id, smallerSide);
                }
            };
            for (let i = 0; i < movesNeeded; i++) {
                if (i === 0) {
                    moveOneAcross();
                } else {
                    setTimeout(moveOneAcross, 5 * i);
                }
            }
            setTimeout(() => {
                if (callback) callback();
            }, 5 * movesNeeded);
        };
        if (n === 0) {
            runCrossMove();
        } else {
            const pullOne = () => {
                safeMoveNextSpec(state.teamRed.length <= state.teamBlue.length ? Team.RED : Team.BLUE);
            };
            for (let i = 0; i < n; i++) {
                if (i === 0) {
                    pullOne();
                } else {
                    setTimeout(pullOne, 5 * i);
                }
            }
            setTimeout(runCrossMove, 5 * n);
        }
    }

    // Replaces what used to be 5 identical copies (one per handlePlayersStop
    // branch) of "wait delayMs, run the pre-start safety net, then start the
    // game 50ms after that settles" — same delayMs (2000 everywhere it was
    // used) and same 50ms trailing buffer every time, just written out
    // separately per branch.
    function scheduleRestart(delayMs) {
        state.startTimeout = setTimeout(() => {
            ensureFullFieldBeforeStart(() => {
                setTimeout(() => {
                    room.startGame();
                }, 50);
            });
        }, delayMs);
    }

    // Rebuilds from a clean 0v0, assigning every current player (capped at
    // 2*teamSize) to a RANDOM side, one at a time, always topping up
    // whichever side is currently smaller (ties toward red) — same
    // principle randomButton()'s own pair logic uses, just generalized to
    // work for odd totals too (a 2v1/3v2/etc. shape, unavoidable with an
    // odd count, still gets a genuinely random assignment instead of sync
    // count-based pairs). Used specifically where there's no genuine
    // outside spectator pool to draw from — see its call site's own
    // comment for why that matters.
    function randomFillAll() {
        resetButton();
        const totalToPlace = Math.min(state.teamSpec.length, 2 * teamSize);
        for (let i = 0; i < totalToPlace; i++) {
            setTimeout(() => {
                if (state.teamSpec.length === 0) return;
                const idx = getRandomInt(state.teamSpec.length);
                const team = state.teamRed.length <= state.teamBlue.length ? Team.RED : Team.BLUE;
                room.setPlayerTeam(state.teamSpec[idx].id, team);
            }, 5 * i);
        }
    }

    // handlePlayersJoin()/handlePlayersLeave() call balanceTeams()
    // unconditionally on every join/leave — but a join/leave landing while
    // handlePlayersStop's own staggered blueToSpecButton/redToSpecButton +
    // topButton() rebuild is still in flight (state.removingPlayers or
    // state.insertingPlayers true) starts a SECOND, independent pair-fill
    // sequence pulling from the same shrinking teamSpec pool, uncoordinated
    // with the first. Confirmed in practice: a player leaving mid-rebuild
    // could land both sequences' moves on the SAME side back to back
    // (spec[0] resolving to a different player each time as the pool
    // shrinks from both directions at once), settling on an uneven split
    // like 3v1 instead of the intended 2v2 — this is state.insertingPlayers'
    // actual purpose, previously set all over this file but never read
    // anywhere. Retrying every 50ms until the in-flight sequence's own
    // auto-clear timeout fires defers to a single clean pass against the
    // final, settled roster instead of racing it.
    function safeBalanceTeams() {
        if (state.removingPlayers || state.insertingPlayers) {
            setTimeout(safeBalanceTeams, 50);
            return;
        }
        balanceTeams();
    }

    function balanceTeams() {
        // Self-heal a chooseMode session that's stuck true below the
        // threshold it needs (a full-or-bigger house) — not just here for
        // handlePlayersLeave's own leave-triggered version of this same
        // check, but for EVERY caller of balanceTeams(), including
        // handlePlayersJoin(). Once chooseMode is stuck, balanceTeams()
        // itself is a no-op (see the guard right below) for as long as it
        // stays stuck — so a room that got stuck small via leaves, then
        // simply had people JOIN back up afterward, would otherwise stay
        // parked with every new joiner piling into spectators forever:
        // nothing about a join alone was ever guaranteed to satisfy the
        // diff/specLen completion checks that would normally clear it.
        if (state.chooseMode && state.players.length < 2 * teamSize) {
            deactivateChooseMode();
            resumeGame();
            setTimeout(() => {
                reassertStadium();
            }, 5);
        }
        if (!state.chooseMode) {
            if (state.players.length == 0) {
                room.stopGame();
                room.setScoreLimit(scoreLimit);
                room.setTimeLimit(timeLimit);
            } else if (state.players.length == 1 && state.teamRed.length == 0) {
                instantRestart();
                setTimeout(() => {
                    stadiumCommand(emptyPlayer, `!training`);
                }, 5);
                room.setPlayerTeam(state.players[0].id, Team.RED);
            } else if (Math.abs(state.teamRed.length - state.teamBlue.length) == state.teamSpec.length && state.teamSpec.length > 0) {
                const n = Math.abs(state.teamRed.length - state.teamBlue.length);
                // Only a genuine training -> classic transition (the lone
                // player from the branch above just got a 2nd player) needs
                // a restart — there's no real match in progress yet to
                // interrupt. If this same 2-player shape is reached by a
                // bigger match shrinking down instead, currentStadium is
                // already 'classic'/'big' and the match plays out as-is;
                // matches only ever get cut short by the single-player case.
                if (state.players.length == 2 && state.currentStadium == 'training') {
                    instantRestart();
                    setTimeout(() => {
                        stadiumCommand(emptyPlayer, `!classic`);
                    }, 5);
                }
                // Always index [0], not [i]: room.setPlayerTeam fires
                // room.onPlayerTeamChange synchronously, which calls
                // updateTeams() and replaces state.teamSpec with a shorter
                // array with the just-moved player gone. Indexing by the
                // loop counter walked past players who'd already shifted
                // down into the earlier slots — for n>=2 this skipped every
                // other spectator (leaving them stuck spectating) and then
                // ran off the end of the shrunk array entirely (a thrown
                // TypeError on state.teamSpec[i].id, aborting the loop
                // early with the gap only half-closed).
                if (state.teamRed.length > state.teamBlue.length) {
                    for (let i = 0; i < n; i++) {
                        room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
                    }
                } else {
                    for (let i = 0; i < n; i++) {
                        room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
                    }
                }
            } else if (Math.abs(state.teamRed.length - state.teamBlue.length) > state.teamSpec.length) {
                if (state.players.length == 1) {
                    instantRestart();
                    setTimeout(() => {
                        stadiumCommand(emptyPlayer, `!training`);
                    }, 5);
                    room.setPlayerTeam(state.players[0].id, Team.RED);
                    return;
                }
                // A shrinking match (someone left, leaving more excess
                // players on one side than there are spectators to fill the
                // other) used to bench the excess players to force parity —
                // the room's policy now is to just keep playing uneven
                // instead of pulling a player off the field because their
                // opponent quit. The teamSize*2-1 reset below is unrelated
                // to benching (it voids qualification-game stat tracking
                // once the house is no longer full) and stays either way.
                if (state.players.length == teamSize * 2 - 1) {
                    state.teamRedStats = [];
                    state.teamBlueStats = [];
                }
                // Bug (reported live): a PARTIAL bench — some non-AFK
                // spectators genuinely waiting, just not ENOUGH of them to
                // fully close the gap on their own (e.g. a 4v0 with only 2
                // waiting, not the 4 needed) — used to fall through this
                // whole branch doing nothing at all, since the old inline
                // cross-move only ever fired when teamSpec was EXACTLY
                // empty. Those waiting spectators just sat there
                // indefinitely ("капитаном синих должен стать человек из
                // зрителей, не афк, но он не встаёт") until an unrelated
                // join/leave/afk toggle happened to shift the numbers into
                // one of the branches that DID do something. Fixed by
                // pullSpectatorsToParity() (see its own comment): pull
                // whatever IS actually available first (rule 2), then
                // cross-move any remaining gap of 2+ once spectators are
                // genuinely exhausted (rule 3) — this branch's own reason
                // for existing (diff > specLen) guarantees the pull alone
                // can never fully close the gap here, so the cross-move
                // always has real work left to do once it runs.
                pullSpectatorsToParity();
            } else if (Math.abs(state.teamRed.length - state.teamBlue.length) < state.teamSpec.length && state.teamRed.length != state.teamBlue.length) {
                const n = Math.abs(state.teamRed.length - state.teamBlue.length);
                if (state.players.length >= 2 * teamSize) {
                    // Enough for a full 4v4 — let captains hand-pick from the
                    // extra spectators instead of just auto-filling.
                    room.pauseGame(true);
                    activateChooseMode();
                    choosePlayer();
                } else {
                    // Not yet a full house — just balance directly and keep
                    // playing (2v2/3v3/etc); the rest wait as spectators.
                    // Index [0], not [i] — see the identical fix/comment on
                    // the branch above; the same shrinking-array hazard
                    // applies here.
                    if (state.teamRed.length > state.teamBlue.length) {
                        for (let i = 0; i < n; i++) {
                            room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
                        }
                    } else {
                        for (let i = 0; i < n; i++) {
                            room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
                        }
                    }
                }
            } else if (state.teamRed.length == state.teamBlue.length && state.teamSpec.length > 0 && state.currentStadium != 'training') {
                // Teams are already balanced (e.g. a running 1v1) but there's
                // still room to grow within the CURRENT stadium's own
                // capacity — classic tops out at 2v2, big at teamSize v
                // teamSize — so waiting spectators get pulled in one pair at
                // a time instead of sitting through the rest of the round.
                // Growing PAST the current stadium's capacity is still
                // deliberately not done here — that needs a stadium switch +
                // restart, which stays a between-rounds/handlePlayersStop
                // concern (see the note this replaced).
                const stadiumCap = state.currentStadium == 'classic' ? 2 : teamSize;
                const slotsAvailable = stadiumCap - state.teamRed.length;
                // Tried activating choose mode here once the current
                // stadium's cap was already full (e.g. 4v4 on big) with
                // more waiting — turned out wrong: the field here is
                // already an even, complete match (that's how this branch
                // is reached at all), so there's genuinely nothing to
                // "pick" — choosePlayer()'s cascade has no natural stopping
                // point that respects an ALREADY-full side, and confirmed
                // in practice it overshot past teamSize (5v5, even 6v6).
                // A real full house's worth of players waiting for the
                // NEXT round is endGame()'s job (see entry.js), triggered
                // once this match actually ends — not something ordinary
                // joins mid-match should retroactively start picking for.
                const n = Math.min(slotsAvailable, Math.floor(state.teamSpec.length / 2));
                // One real tick apart (setTimeout), alternating RED/BLUE,
                // not n pairs of back-to-back same-tick calls. Always index
                // [0] — room.setPlayerTeam fires room.onPlayerTeamChange,
                // which calls updateTeams() and replaces state.teamSpec
                // with a fresh array, so [0] naturally lands on whoever's
                // next after each move — but back-to-back calls with zero
                // gap weren't reliably enough for that replacement to have
                // actually happened by the very next call in production:
                // the second call in a pair could still see the SAME
                // just-moved player at [0] and yank them from RED onto BLUE
                // instead of picking the next spectator, leaving red short
                // one and the real next-in-line stuck spectating (a 3v3
                // growing to 3v4 instead of 4v4, one waiting spectator
                // ignored).
                for (let i = 0; i < 2 * n; i++) {
                    setTimeout(() => {
                        // n was computed once, up front, from teamRed/
                        // teamSpec's length at that moment — but a
                        // concurrent join/leave (or another balanceTeams()
                        // run) landing in one of these staggered gaps can
                        // ALSO see the pre-fill state and schedule its own,
                        // completely unaware overlapping batch of moves.
                        // Confirmed in practice: two such batches together
                        // pulled a side past the stadium's own cap (e.g.
                        // 5v5, even 6v6, on big, past teamSize). Re-check
                        // the LIVE cap (re-read fresh, in case the stadium
                        // itself changed) right before every individual
                        // move — and specifically for the SIDE this call is
                        // about to fill, not "either side has room": the
                        // other side having space doesn't mean THIS one
                        // does.
                        const liveCap = state.currentStadium == 'classic' ? 2 : teamSize;
                        const targetTeam = i % 2 === 0 ? Team.RED : Team.BLUE;
                        const targetSize = targetTeam === Team.RED ? state.teamRed.length : state.teamBlue.length;
                        if (targetSize < liveCap) {
                            safeMoveNextSpec(targetTeam);
                        }
                    }, 5 * i);
                }
            }
            // Bug: none of the branches above ever reassert the stadium —
            // by design, since switching mid-play would interrupt a live
            // match. But that only actually matters while a match is truly
            // being PLAYed; balanceTeams() runs on every join/leave
            // regardless, including plenty of moments where nothing is
            // live yet (gameState == STOP: a room still filling up before
            // its first kickoff, or between rounds). In exactly those safe
            // moments, ordinary joins/leaves could grow or shrink the
            // field (3v3, 4v4, back down to 2v2, ...) without the stadium
            // ever catching up — confirmed in practice, a room could sit
            // on 'classic' at a settled 3v3, or stay on 'big' after
            // shrinking back to 2v2, indefinitely. Re-check state.chooseMode
            // fresh (not the outer guard's stale read) since a branch above
            // may have just turned it on — that path handles its own map
            // once it resolves, this shouldn't race it. Deferred long
            // enough to cover the slowest branch above (the growth pair
            // loop, up to teamSize pairs at 5ms apart).
            if (!state.chooseMode && state.gameState == State.STOP) {
                setTimeout(() => {
                    if (!state.chooseMode) {
                        reassertStadium();
                    }
                }, 50);
            }
        }
    }

    function handlePlayersJoin() {
        if (state.chooseMode) {
            getSpecList(state.teamRed.length <= state.teamBlue.length ? state.teamRed[0] : state.teamBlue[0]);
        }
        safeBalanceTeams();
    }

    function handlePlayersLeave() {
        if (state.gameState != State.STOP) {
            const scores = room.getScores();
            if (state.players.length >= 2 * teamSize && scores.time >= (5 / 6) * state.game.scores.timeLimit && state.teamRed.length != state.teamBlue.length) {
                let rageQuitCheck = false;
                if (state.teamRed.length < state.teamBlue.length) {
                    if (scores.blue - scores.red == 2) {
                        endGame(Team.BLUE);
                        rageQuitCheck = true;
                    }
                } else {
                    if (scores.red - scores.blue == 2) {
                        endGame(Team.RED);
                        rageQuitCheck = true;
                    }
                }
                if (rageQuitCheck) {
                    room.sendAnnouncement(
                        "Ууу, рейджкуит. Игра остановлена досрочно.",
                        null,
                        infoColor,
                        'bold',
                        HaxNotification.MENTION
                    )
                    state.stopTimeout = setTimeout(() => {
                        room.stopGame();
                    }, 100);
                    return;
                }
            }
        }
        if (state.chooseMode) {
            // Choose mode's whole premise (a full-or-bigger house, letting
            // captains hand-pick from genuine surplus) no longer holds once
            // the room has shrunk below that — bail out unconditionally
            // rather than falling through to the diff/specLen checks below.
            // Those checks are only guaranteed to eventually fire for
            // PICKS (each one moves the counts in a tightly self-resolving
            // way — see determineSideForm's captain-alternation), not for
            // ordinary LEAVES, which can hit red/blue/spec in any order.
            // E.g. spectators simply sitting still while active players
            // keep leaving can walk red/blue/specLen through values where
            // abs(diff) never lands exactly on specLen and Red never equals
            // Blue while specLen<2 — chooseMode then stays stuck true
            // forever. handlePlayersStop has no room.startGame() call for
            // that stuck (chooseMode true, not a full house) case, so the
            // room would silently sit parked after the next match ends —
            // "leave broadcasts fine, kicks are fine, but the room never
            // starts a new round again" is exactly what that looks like.
            if (state.players.length < 2 * teamSize) {
                deactivateChooseMode();
                resumeGame();
                balanceTeams();
                setTimeout(() => {
                    reassertStadium();
                }, 5);
                return;
            }
            if (state.teamRed.length == 0 || state.teamBlue.length == 0) {
                room.setPlayerTeam(state.teamSpec[0].id, state.teamRed.length == 0 ? Team.RED : Team.BLUE);
                return;
            }
            if (Math.abs(state.teamRed.length - state.teamBlue.length) == state.teamSpec.length) {
                deactivateChooseMode();
                resumeGame();
                const b = state.teamSpec.length;
                if (state.teamRed.length > state.teamBlue.length) {
                    for (let i = 0; i < b; i++) {
                        clearTimeout(state.insertingTimeout);
                        state.insertingPlayers = true;
                        setTimeout(() => {
                            safeMoveNextSpec(Team.BLUE);
                        }, 5 * i);
                    }
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 5 * b);
                } else {
                    for (let i = 0; i < b; i++) {
                        clearTimeout(state.insertingTimeout);
                        state.insertingPlayers = true;
                        setTimeout(() => {
                            safeMoveNextSpec(Team.RED);
                        }, 5 * i);
                    }
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 5 * b);
                }
                return;
            }
            if (state.streak == 0 && state.gameState == State.STOP) {
                if (Math.abs(state.teamRed.length - state.teamBlue.length) == 2) {
                    const teamIn = state.teamRed.length > state.teamBlue.length ? state.teamRed : state.teamBlue;
                    room.setPlayerTeam(teamIn[teamIn.length - 1].id, Team.SPECTATORS)
                }
            }
            if (state.teamRed.length == state.teamBlue.length && state.teamSpec.length < 2) {
                deactivateChooseMode();
                resumeGame();
                return;
            }

            // Bug: getSpecList() alone only shows an updated waiting-list —
            // it does NOT re-prompt anyone or re-arm state.timeOutCap. A
            // leave can shift the teamRed<=teamBlue comparison (whose
            // "turn" it is) WITHOUT checkCaptainLeave setting capLeft (that
            // only fires when the departing player WAS the current-turn
            // captain themselves) — leaving the room desynced: whoever was
            // already prompted keeps their armed timer for a turn that
            // isn't theirs anymore, while whoever's turn it actually
            // becomes now was only shown a spectator list, never asked
            // anything, with no timer of their own either. Reported live as
            // a complete freeze after one player left a 9-person
            // choose-mode session, with blue never getting a captain
            // prompt. choosePlayer() already calls getSpecList() itself
            // once it settles on a real captain, so always calling it here
            // is a strict superset — it just also (re-)establishes a
            // working prompt+timer for whoever's actually up.
            choosePlayer();
        }
        safeBalanceTeams();
    }

    function handlePlayersTeamChange(byPlayer) {
        if (state.chooseMode && !state.removingPlayers && byPlayer == null) {
            if (Math.abs(state.teamRed.length - state.teamBlue.length) == state.teamSpec.length) {
                deactivateChooseMode();
                resumeGame();
                // The b-loop below only tops the SMALLER side up to match
                // the larger one — the larger side's count right now
                // already IS the final maxSide, so reassertStadium() is
                // correct even read before the loop runs. Deferred by a
                // tick like every other stadium switch in this file (never
                // called synchronously mid-cascade). This path resumes play
                // directly (no game stop/restart in between), so unlike
                // handlePlayersStop nothing else was ever going to catch a
                // stale map here on its own.
                setTimeout(() => {
                    reassertStadium();
                }, 5);
                const b = state.teamSpec.length;
                if (state.teamRed.length > state.teamBlue.length) {
                    for (let i = 0; i < b; i++) {
                        clearTimeout(state.insertingTimeout);
                        state.insertingPlayers = true;
                        setTimeout(() => {
                            safeMoveNextSpec(Team.BLUE);
                        }, 5 * i);
                    }
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 5 * b);
                } else {
                    for (let i = 0; i < b; i++) {
                        clearTimeout(state.insertingTimeout);
                        state.insertingPlayers = true;
                        setTimeout(() => {
                            safeMoveNextSpec(Team.RED);
                        }, 5 * i);
                    }
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 5 * b);
                }
                return;
            } else if (
                (state.teamRed.length == teamSize && state.teamBlue.length == teamSize) ||
                (state.teamRed.length == state.teamBlue.length && state.teamSpec.length < 2)
            ) {
                deactivateChooseMode();
                resumeGame();
                // Both sides are already equal here (either both at
                // teamSize, or Red==Blue outright) and nothing further
                // moves anyone in this branch, so the map is already
                // decided — same deferred-by-a-tick reasoning as above.
                setTimeout(() => {
                    reassertStadium();
                }, 5);
            } else if (state.teamRed.length <= state.teamBlue.length && state.redCaptainChoice != '') {
                // Bug: none of these three indexed into state.teamSpec
                // guarded against it already being empty — a captain's
                // stored 'top'/'random'/'bottom' preference auto-continues
                // picking on every subsequent room.onPlayerTeamChange
                // recursion (see the comment above this function), and an
                // odd leftover (diff still != 0 once teamSpec hits 0) can
                // reach this branch before the abs(diff)==specLen
                // completion check above ever catches it, throwing on
                // state.teamSpec[...].id being undefined.
                if (state.teamSpec.length > 0) {
                    if (state.redCaptainChoice == 'top') {
                        room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
                    } else if (state.redCaptainChoice == 'random') {
                        const r = getRandomInt(state.teamSpec.length);
                        room.setPlayerTeam(state.teamSpec[r].id, Team.RED);
                    } else {
                        room.setPlayerTeam(state.teamSpec[state.teamSpec.length - 1].id, Team.RED);
                    }
                }
                return;
            } else if (state.teamBlue.length < state.teamRed.length && state.blueCaptainChoice != '') {
                // See the identical guard/comment on the red branch above.
                if (state.teamSpec.length > 0) {
                    if (state.blueCaptainChoice == 'top') {
                        room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
                    } else if (state.blueCaptainChoice == 'random') {
                        const r = getRandomInt(state.teamSpec.length);
                        room.setPlayerTeam(state.teamSpec[r].id, Team.BLUE);
                    } else {
                        room.setPlayerTeam(state.teamSpec[state.teamSpec.length - 1].id, Team.BLUE);
                    }
                }
                return;
            } else {
                choosePlayer();
            }
        }
    }

    // Bug: this used to also have a second, near-identical copy of the
    // WinStay bench+refill logic below, reached whenever state.chooseMode
    // was still true (endGame() used to defensively activateChooseMode()
    // on every win with a full-or-bigger house — see its own comment for
    // why that was removed). That copy is now unreachable:
    // activateChooseMode() is only ever called from balanceTeams()'s own
    // ordinary-growth branch during LIVE play, which requires
    // state.gameState to not already be freshly STOP, and can't coincide
    // with state.endGameVariable being true at the moment this function's
    // own guard checks it (endGameVariable only becomes true inside
    // endGame(), which is what a genuine match conclusion sets — not
    // something a still-live, mid-pick round has done yet). Deleting it
    // removed ~140 lines of duplicated bench/refill/reset logic that had
    // its own, subtly different bugs from the copy below over the course
    // of this file's history.
    function handlePlayersStop(byPlayer) {
        if (byPlayer == null && state.endGameVariable) {
            if (state.players.length == 2) {
                if (state.lastWinner == Team.BLUE) {
                    swapButton();
                }
                // swapButton() only relabels which color the winner wears —
                // team SIZES are already final synchronously, but still
                // deferred a tick like every other stadium switch in this
                // file (never called synchronously mid-cascade).
                setTimeout(() => {
                    reassertStadium();
                }, 5);
                scheduleRestart(2000);
            } else if (state.players.length == 3 || state.players.length == 5 || state.players.length == 7 || state.players.length >= 2 * teamSize) {
                // Bug: 7 was missing entirely from this list — every OTHER
                // total from 2 up to a full house (2, 3, 4, 5, 6) had a
                // branch, plus 8 and 9+, but a match ending at exactly 7
                // (e.g. 4v3) matched none of them. handlePlayersStop did
                // nothing at all: no rebuild, no stadium check, no
                // room.startGame() — the room sat frozen with no new round
                // ever starting until something else (a join or leave
                // changing the total) happened to trigger a different
                // path. Folded in here since 7, like 3 and 5, is "odd,
                // below a full house" — same bench+refill shape applies.
                // 5 used to also trigger captain-choosing mode here — the
                // room's policy now is to wait for a full 4v4 house before
                // doing that, so 5 (like 3) just keeps playing: the losing
                // team benches, the refill below pulls someone back in.
                // >=2*teamSize (8, 9+) used to be reached only when
                // state.chooseMode was still true (via endGame()'s own
                // defensive activateChooseMode() call — removed, see its
                // own comment) through a second, near-identical copy of
                // this exact branch. Folded in here instead: same WinStay
                // bench+refill shape as every other total.
                //
                // Bug: with genuinely ZERO waiting spectators (checked
                // BEFORE any benching below — the bench itself always
                // creates a non-empty teamSpec, that's not what this
                // checks), the bench+swap+refill sequence only ever has the
                // just-benched loser(s) to draw the refill from — reported
                // live as "a match ending 2v1 starts the next one 2v1
                // again": the SAME loser gets put right back, reconstructing
                // the identical shape (winners kept together, loser alone)
                // instead of a fresh, random reassignment. An uneven split
                // itself is unavoidable with an odd total (someone's always
                // going to be the "extra"), but WHO ends up where shouldn't
                // be tied to who just won or lost. Reuse the same random
                // rebuild the exact-4/exact-6 branches already do below for
                // this specific case.
                if (state.teamSpec.length == 0) {
                    randomFillAll();
                    clearTimeout(state.insertingTimeout);
                    state.insertingPlayers = true;
                    const totalToPlace = Math.min(state.players.length, 2 * teamSize);
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 5 * totalToPlace);
                    setTimeout(() => {
                        reassertStadium();
                    }, 5 * totalToPlace);
                } else {
                    if (state.lastWinner == Team.RED) {
                        blueToSpecButton();
                    } else {
                        redToSpecButton();
                        setTimeout(() => {
                            swapButton();
                        }, 5);
                    }
                    clearTimeout(state.insertingTimeout);
                    state.insertingPlayers = true;
                    // Bug (reported live): the refill used to compute
                    // computeSpectatorsToInsert() SYNCHRONOUSLY, immediately
                    // after blueToSpecButton()/redToSpecButton() returns —
                    // but room.setPlayerTeam() firing room.onPlayerTeamChange
                    // synchronously isn't reliable for a TIGHT loop of
                    // back-to-back calls in real production (the exact same
                    // reasoning behind every other "index [0], staggered 5ms
                    // apart" pattern in this file — see e.g. topButton()'s
                    // own comment). The just-benched losers weren't reliably
                    // counted in state.teamSpec yet, undercounting how many
                    // were actually available and stranding the rest:
                    // reported live as 9 players (2v2 + 5 waiting) settling
                    // on a 3v3 with 3 non-AFK spectators left over instead of
                    // the 4v4 those numbers could have filled. Deferred a
                    // tick so the bench (and, on the swapped path, the swap
                    // itself) has actually landed before counting off it —
                    // then pullSpectatorsToParity() handles the actual
                    // refill (pull to parity, cross-move if genuinely
                    // nobody's left — see its own comment). state.insertingPlayers
                    // is cleared from ITS completion callback (not a
                    // guessed fixed duration like the old inline version
                    // used) — more precise, and required: leaving it stuck
                    // true forever (a real regression introduced while
                    // consolidating this branch) permanently stalled
                    // safeBalanceTeams() for every subsequent join/leave,
                    // confirmed via the fuzzer as a genuine rule-2
                    // violation (a waiting spectator never getting pulled
                    // in, no matter how long the room sat afterward).
                    setTimeout(() => {
                        pullSpectatorsToParity(() => {
                            state.insertingPlayers = false;
                            reassertStadium();
                        });
                    }, 10);
                }
                scheduleRestart(2000);
            } else if (state.players.length == 4) {
                // resetButton() + 2x randomButton() below always rebuilds an
                // even 2v2 regardless of the shape leading in, so the map is
                // already known up front — switch BEFORE the rebuild so it's
                // already settled before anyone gets placed on it.
                if (state.currentStadium != desiredStadiumFor(2)) {
                    setTimeout(() => {
                        stadiumCommand(emptyPlayer, `!${desiredStadiumFor(2)}`);
                    }, 5);
                }
                resetButton();
                clearTimeout(state.insertingTimeout);
                state.insertingPlayers = true;
                setTimeout(() => {
                    randomButton();
                    setTimeout(() => {
                        randomButton();
                    }, 500);
                }, 500);
                state.insertingTimeout = setTimeout(() => {
                    state.insertingPlayers = false;
                }, 2000);
                scheduleRestart(2000);
            } else if (state.players.length == 6) {
                // Same reasoning as the 4-player case above — resetButton()
                // + 3x randomButton() always rebuilds an even 3v3.
                if (state.currentStadium != desiredStadiumFor(3)) {
                    setTimeout(() => {
                        stadiumCommand(emptyPlayer, `!${desiredStadiumFor(3)}`);
                    }, 5);
                }
                resetButton();
                clearTimeout(state.insertingTimeout);
                state.insertingPlayers = true;
                state.insertingTimeout = setTimeout(() => {
                    state.insertingPlayers = false;
                }, 1500);
                setTimeout(() => {
                    randomButton();
                    setTimeout(() => {
                        randomButton();
                        setTimeout(() => {
                            randomButton();
                        }, 500);
                    }, 500);
                }, 500);
                scheduleRestart(2000);
            }
        }
    }

    return {
        balanceTeams,
        ensureFullFieldBeforeStart,
        handlePlayersJoin,
        handlePlayersLeave,
        handlePlayersTeamChange,
        handlePlayersStop,
    };
};
