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
                if (state.players.length == 2) {
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
                } else if (teamSize > 2 && state.players.length == 5) {
                    instantRestart();
                    setTimeout(() => {
                        stadiumCommand(emptyPlayer, `!classic`);
                    }, 5);
                }
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
                room.pauseGame(true);
                activateChooseMode();
                choosePlayer();
            }
            // Deliberately no branch grows an already-balanced, already-full
            // match (e.g. a running 2v2) into a bigger one on its own — the
            // room's policy is that whichever map/team size is currently
            // active stays put, and any extra joiners simply wait as
            // spectators rather than forcing a stadium switch + restart.
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
                } else if (state.players.length == 3 || state.players.length >= 2 * teamSize + 1) {
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
                } else if (state.players.length == 5 || state.players.length >= 2 * teamSize + 1) {
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
                    state.insertingTimeout = setTimeout(() => {
                        state.insertingPlayers = false;
                    }, 200);
                    setTimeout(() => {
                        topButton();
                    }, 200);
                    activateChooseMode();
                } else if (state.players.length == 6) {
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
