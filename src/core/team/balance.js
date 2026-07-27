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
                // Exception: if there's truly nobody left to draw from (no
                // non-AFK spectators waiting at all — AFK players are
                // already excluded from state.teamSpec by updateTeams(), so
                // this only fires on a genuinely empty bench, not merely a
                // short one), a lopsided match like 4v2 would otherwise stay
                // that way indefinitely. Nudge it back toward parity by
                // moving the last player of the BIGGER side across to the
                // smaller one — they keep playing, just switch sides,
                // unlike the old benching behavior above that this
                // deliberately doesn't bring back. Only when the gap is at
                // least 2: moving exactly one player changes the gap by
                // exactly 2 either way, so at a gap of 1 (e.g. 4v3) this
                // would just flip who has the extra player (4v3 -> 3v4) —
                // no actual improvement, just churn — whereas a gap of 2+
                // (4v2 -> 3v3) is always a genuine step toward parity.
                if (state.teamSpec.length == 0 && Math.abs(state.teamRed.length - state.teamBlue.length) >= 2) {
                    const biggerTeam = state.teamRed.length > state.teamBlue.length ? state.teamRed : state.teamBlue;
                    const smallerSide = state.teamRed.length > state.teamBlue.length ? Team.BLUE : Team.RED;
                    room.setPlayerTeam(biggerTeam[biggerTeam.length - 1].id, smallerSide);
                }
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
                        safeMoveNextSpec(i % 2 === 0 ? Team.RED : Team.BLUE);
                    }, 5 * i);
                }
            }
        }
    }

    function handlePlayersJoin() {
        if (state.chooseMode) {
            getSpecList(state.teamRed.length <= state.teamBlue.length ? state.teamRed[0] : state.teamBlue[0]);
        }
        balanceTeams();
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

            if (state.capLeft) {
                choosePlayer();
            } else {
                getSpecList(state.teamRed.length <= state.teamBlue.length ? state.teamRed[0] : state.teamBlue[0]);
            }
        }
        balanceTeams();
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
                if (state.redCaptainChoice == 'top') {
                    room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
                } else if (state.redCaptainChoice == 'random') {
                    const r = getRandomInt(state.teamSpec.length);
                    room.setPlayerTeam(state.teamSpec[r].id, Team.RED);
                } else {
                    room.setPlayerTeam(state.teamSpec[state.teamSpec.length - 1].id, Team.RED);
                }
                return;
            } else if (state.teamBlue.length < state.teamRed.length && state.blueCaptainChoice != '') {
                if (state.blueCaptainChoice == 'top') {
                    room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
                } else if (state.blueCaptainChoice == 'random') {
                    const r = getRandomInt(state.teamSpec.length);
                    room.setPlayerTeam(state.teamSpec[r].id, Team.BLUE);
                } else {
                    room.setPlayerTeam(state.teamSpec[state.teamSpec.length - 1].id, Team.BLUE);
                }
                return;
            } else {
                choosePlayer();
            }
        }
    }

    function handlePlayersStop(byPlayer) {
        if (byPlayer == null && state.endGameVariable) {
            if (state.chooseMode) {
                if (state.players.length == 2 * teamSize) {
                    // endGame() activates choose mode defensively on EVERY
                    // win with a full-or-bigger house, before it's known
                    // whether there are actually any extra spectators to
                    // pick from. Landing here means there weren't (exactly
                    // 2*teamSize total) — nothing to choose, so skip
                    // straight to a random fill. Must go through
                    // deactivateChooseMode(), not a bare assignment: it also
                    // resets slowMode back down (otherwise chat stays on the
                    // slower captain-picking rate) and clears
                    // redCaptainChoice/blueCaptainChoice (otherwise a stale
                    // 'top'/'random'/'bottom' from this round leaks into the
                    // NEXT real choose-mode session, silently auto-picking
                    // for whichever captain sits down next without ever
                    // asking them).
                    deactivateChooseMode();
                    // resetButton() + teamSize x randomButton() below always
                    // rebuilds an even teamSize v teamSize split regardless
                    // of whatever shape led in here, so the map this needs
                    // is already known up front — no need to wait and
                    // observe the rebuilt teams. Switching the stadium
                    // BEFORE the rebuild (not after) is deliberate: loading
                    // a stadium resets everyone to spectators, so the
                    // rebuild has to run against that reset roster, not the
                    // other way around.
                    if (state.currentStadium != desiredStadiumFor(teamSize)) {
                        setTimeout(() => {
                            stadiumCommand(emptyPlayer, `!${desiredStadiumFor(teamSize)}`);
                        }, 5);
                    }
                    resetButton();
                    for (let i = 0; i < teamSize; i++) {
                        clearTimeout(state.insertingTimeout);
                        state.insertingPlayers = true;
                        setTimeout(() => {
                            randomButton();
                        }, 200 * i);
                    }
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 200 * teamSize);
                    state.startTimeout = setTimeout(() => {
                        room.startGame();
                    }, 2000);
                } else {
                    if (state.lastWinner == Team.RED) {
                        blueToSpecButton();
                    } else if (state.lastWinner == Team.BLUE) {
                        redToSpecButton();
                        setTimeout(() => {
                            swapButton();
                        }, 10);
                    } else {
                        resetButton();
                    }
                    clearTimeout(state.insertingTimeout);
                    state.insertingPlayers = true;
                    // Same reasoning as the plain 3/5/9+ branch below: one
                    // topButton() call only pulls in a single spectator,
                    // which stranded the rest of a benched bigger team
                    // instead of refilling properly. Loop once per spectator
                    // NEEDED — capped at how many actually fit up to
                    // teamSize per side (2*teamSize total), not
                    // state.teamSpec.length outright. Whenever there were
                    // MORE waiting spectators than room for (e.g. a house
                    // that grew past a full 2*teamSize before the round
                    // ended), draining every one of them regardless kept
                    // calling topButton() after both sides already reached
                    // teamSize — silently growing the match past its
                    // intended cap (5v5 instead of stopping at 4v4).
                    const spectatorsToInsert = Math.min(
                        state.teamSpec.length,
                        2 * teamSize - state.teamRed.length - state.teamBlue.length
                    );
                    for (let i = 0; i < spectatorsToInsert; i++) {
                        setTimeout(() => {
                            topButton();
                        }, 300 + 5 * i);
                    }
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 300 + 5 * spectatorsToInsert);
                    // Unlike the exact-2*teamSize branch above, the shape
                    // this settles on isn't known in advance (depends on how
                    // many spectators were actually available to refill
                    // with) — wait for the refill to finish, then reassert
                    // off the real result rather than guessing from the
                    // pre-refill player count.
                    setTimeout(() => {
                        reassertStadium();
                    }, 300 + 5 * spectatorsToInsert);
                }
            } else {
                if (state.players.length == 2) {
                    if (state.lastWinner == Team.BLUE) {
                        swapButton();
                    }
                    // swapButton() only relabels which color the winner
                    // wears — team SIZES are already final synchronously,
                    // but still deferred a tick like every other stadium
                    // switch in this file (never called synchronously
                    // mid-cascade).
                    setTimeout(() => {
                        reassertStadium();
                    }, 5);
                    state.startTimeout = setTimeout(() => {
                        room.startGame();
                    }, 2000);
                } else if (state.players.length == 3 || state.players.length == 5 || state.players.length >= 2 * teamSize + 1) {
                    // 5 used to also trigger captain-choosing mode here — the
                    // room's policy now is to wait for a full 4v4 house before
                    // doing that, so 5 (like 3) just keeps playing: the losing
                    // team benches, topButton() pulls someone back in. 9+ here
                    // shouldn't normally happen — endGame() already turns on
                    // choose mode at a full 4v4 house before this ever runs.
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
                    // One topButton() call only ever pulls in a single
                    // spectator — fine when the losing side had just one
                    // player to begin with, but benching a bigger losing
                    // side (e.g. a 3v2 down to 5 total) left the rest
                    // stranded in spectators instead of playing, settling on
                    // something like 2v1/3v1 instead of the 3v2 those 5
                    // players could actually fill. Looping once per
                    // spectator NEEDED (each call only ever needs one more to
                    // place, since it re-reads the live roster every time)
                    // drains them all, same "b" pattern the full-house branch
                    // above uses for randomButton() — capped at how many
                    // actually fit up to teamSize per side, same reasoning
                    // as that branch's identical cap (this one shares the
                    // same >=2*teamSize+1 condition above, so it's just as
                    // reachable with more waiting spectators than room for).
                    const spectatorsToInsert = Math.min(
                        state.teamSpec.length,
                        2 * teamSize - state.teamRed.length - state.teamBlue.length
                    );
                    for (let i = 0; i < spectatorsToInsert; i++) {
                        setTimeout(() => {
                            topButton();
                        }, 200 + 5 * i);
                    }
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 300 + 5 * spectatorsToInsert);
                    // Same reasoning as the chooseMode branch above: the
                    // resulting shape depends on how many spectators were
                    // actually available, so wait for the refill to settle
                    // before reasserting — well before room.startGame()
                    // fires at 2000ms below.
                    setTimeout(() => {
                        reassertStadium();
                    }, 300 + 5 * spectatorsToInsert);
                    state.startTimeout = setTimeout(() => {
                        room.startGame();
                    }, 2000);
                } else if (state.players.length == 4) {
                    // resetButton() + 2x randomButton() below always
                    // rebuilds an even 2v2 regardless of the shape leading
                    // in, so (same reasoning as the exact-2*teamSize
                    // chooseMode branch) the map is already known — switch
                    // BEFORE the rebuild since loading a stadium resets
                    // everyone to spectators.
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
                    state.startTimeout = setTimeout(() => {
                        room.startGame();
                    }, 2000);
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
                    state.startTimeout = setTimeout(() => {
                        room.startGame();
                    }, 2000);
                }
            }
        }
    }

    return {
        balanceTeams,
        handlePlayersJoin,
        handlePlayersLeave,
        handlePlayersTeamChange,
        handlePlayersStop,
    };
};
