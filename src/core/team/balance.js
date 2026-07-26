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
    function balanceTeams() {
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
                if (state.teamRed.length > state.teamBlue.length) {
                    for (let i = 0; i < n; i++) {
                        room.setPlayerTeam(state.teamSpec[i].id, Team.BLUE);
                    }
                } else {
                    for (let i = 0; i < n; i++) {
                        room.setPlayerTeam(state.teamSpec[i].id, Team.RED);
                    }
                }
            } else if (Math.abs(state.teamRed.length - state.teamBlue.length) > state.teamSpec.length) {
                const n = Math.abs(state.teamRed.length - state.teamBlue.length);
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
                // other) no longer restarts/switches stadium here — only
                // the single-player case above does that. The excess
                // players below just get benched to spectators and the
                // match keeps playing on whatever map it's already on.
                if (state.players.length == teamSize * 2 - 1) {
                    state.teamRedStats = [];
                    state.teamBlueStats = [];
                }
                if (state.teamRed.length > state.teamBlue.length) {
                    for (let i = 0; i < n; i++) {
                        room.setPlayerTeam(
                            state.teamRed[state.teamRed.length - 1 - i].id,
                            Team.SPECTATORS
                        );
                    }
                } else {
                    for (let i = 0; i < n; i++) {
                        room.setPlayerTeam(
                            state.teamBlue[state.teamBlue.length - 1 - i].id,
                            Team.SPECTATORS
                        );
                    }
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
                    if (state.teamRed.length > state.teamBlue.length) {
                        for (let i = 0; i < n; i++) {
                            room.setPlayerTeam(state.teamSpec[i].id, Team.BLUE);
                        }
                    } else {
                        for (let i = 0; i < n; i++) {
                            room.setPlayerTeam(state.teamSpec[i].id, Team.RED);
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
                for (let i = 0; i < n; i++) {
                    room.setPlayerTeam(state.teamSpec[2 * i].id, Team.RED);
                    room.setPlayerTeam(state.teamSpec[2 * i + 1].id, Team.BLUE);
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
            if (teamSize > 2 && state.players.length == 5) {
                setTimeout(() => {
                    stadiumCommand(emptyPlayer, `!classic`);
                }, 5);
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
                            room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
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
                            room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
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
                const b = state.teamSpec.length;
                if (state.teamRed.length > state.teamBlue.length) {
                    for (let i = 0; i < b; i++) {
                        clearTimeout(state.insertingTimeout);
                        state.insertingPlayers = true;
                        setTimeout(() => {
                            room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
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
                            room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
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
                    state.chooseMode = false;
                    // A full 4v4 needs the big map — classic (1v1/2v2-sized)
                    // is too small and would otherwise stay active if the
                    // room simply grew into this from a smaller match.
                    if (state.currentStadium != 'big') {
                        setTimeout(() => {
                            stadiumCommand(emptyPlayer, `!big`);
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
                    // Any other count while choose mode is active (9, 10, ...
                    // up to whatever's in the room) is still a 4v4-or-bigger
                    // situation by definition — choose mode only ever turns on
                    // at a full 4v4 house — so this must be on the big map too.
                    if (state.currentStadium != 'big') {
                        setTimeout(() => {
                            stadiumCommand(emptyPlayer, `!big`);
                        }, 5);
                    }
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
                    setTimeout(() => {
                        topButton();
                    }, 300);
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 300);
                }
            } else {
                if (state.players.length == 2) {
                    if (state.lastWinner == Team.BLUE) {
                        swapButton();
                    }
                    state.startTimeout = setTimeout(() => {
                        room.startGame();
                    }, 2000);
                } else if (state.players.length == 3 || state.players.length == 5 || state.players.length >= 2 * teamSize + 1) {
                    // 5 used to also trigger captain-choosing mode here — the
                    // room's policy now is to wait for a full 4v4 house before
                    // doing that, so 5 (like 3) just keeps playing: the losing
                    // team benches, topButton() pulls someone back in. 9+ here
                    // shouldn't normally happen — endGame() already turns on
                    // choose mode at a full 4v4 house before this ever runs —
                    // but if it somehow does, it's still big-map territory,
                    // unlike the 3/5 cases sharing this branch.
                    if (state.players.length >= 2 * teamSize + 1 && state.currentStadium != 'big') {
                        setTimeout(() => {
                            stadiumCommand(emptyPlayer, `!big`);
                        }, 5);
                    }
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
                    setTimeout(() => {
                        topButton();
                    }, 200);
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 300);
                    state.startTimeout = setTimeout(() => {
                        room.startGame();
                    }, 2000);
                } else if (state.players.length == 4) {
                    // 2v2 belongs on the small classic map — re-assert it in
                    // case the room just shrank down from a bigger match.
                    if (state.currentStadium != 'classic') {
                        setTimeout(() => {
                            stadiumCommand(emptyPlayer, `!classic`);
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
                    // 3v3 needs the big map, same reasoning as the 4v4 case above.
                    if (state.currentStadium != 'big') {
                        setTimeout(() => {
                            stadiumCommand(emptyPlayer, `!big`);
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
