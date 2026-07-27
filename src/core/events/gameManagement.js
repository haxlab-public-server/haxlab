/*
 * room.onGameStart/Stop/Pause/Unpause/TeamGoal/PositionsReset — the match lifecycle.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createGameManagementEvents({
    room,
    state,
    Game,
    HaxNotification,
    Situation,
    State,
    Team,
    blueColor,
    defaultColor,
    discordBot,
    fetchRecordingVariable,
    getStartingLineups,
    mentionPlayersUnpause,
    redColor,
    teamSize,
    applyEquippedDiscCosmetics,
    calculateStadiumVariables,
    deactivateChooseMode,
    endGame,
    fetchRecording,
    fetchSummaryEmbed,
    getBallSpeed,
    getDate,
    getGoalString,
    getPlayerComp,
    handleActivityStop,
    handlePlayersStop,
    playGoalAnimation,
    updateTeams,
}) {
    function onGameStart(byPlayer) {
        clearTimeout(state.startTimeout);
        if (byPlayer != null) clearTimeout(state.stopTimeout);
        state.game = new Game(room, getStartingLineups);
        state.possession = [0, 0];
        state.actionZoneHalf = [0, 0];
        state.gameState = State.PLAY;
        state.endGameVariable = false;
        state.goldenGoal = false;
        state.playSituation = Situation.KICKOFF;
        state.lastTouches = Array(2).fill(null);
        state.lastTeamTouched = Team.SPECTATORS;
        state.teamRedStats = [];
        state.teamBlueStats = [];
        if (state.teamRed.length == teamSize && state.teamBlue.length == teamSize) {
            for (let i = 0; i < teamSize; i++) {
                state.teamRedStats.push(state.teamRed[i]);
                state.teamBlueStats.push(state.teamBlue[i]);
            }
        }
        // Defensive re-apply: HaxBall can reset a disc's custom properties
        // (color, radius) across a stadium change/restart, independent of
        // any team-change event — a fresh match start is the other moment
        // (alongside movement.js's onPlayerTeamChange) a worn form/size
        // could otherwise silently fall off.
        for (const player of [...state.teamRed, ...state.teamBlue]) {
            applyEquippedDiscCosmetics(player).catch((err) => console.error('[economy] applyEquippedDiscCosmetics failed:', err));
        }
        calculateStadiumVariables();
    }

    function onGameStop(byPlayer) {
        clearTimeout(state.stopTimeout);
        clearTimeout(state.unpauseTimeout);
        if (byPlayer != null) clearTimeout(state.startTimeout);
        state.game.rec = room.stopRecording();
        if (
            !state.cancelGameVariable && state.game.playerComp[0].length + state.game.playerComp[1].length > 0 &&
            (
                (state.game.scores.timeLimit != 0 &&
                    ((state.game.scores.time >= 0.5 * state.game.scores.timeLimit &&
                        state.game.scores.time < 0.75 * state.game.scores.timeLimit &&
                        state.game.scores.red != state.game.scores.blue) ||
                        state.game.scores.time >= 0.75 * state.game.scores.timeLimit)
                ) ||
                state.endGameVariable
            )
        ) {
            fetchSummaryEmbed(state.game);
            if (fetchRecordingVariable) {
                setTimeout((gameEnd) => { fetchRecording(gameEnd, discordBot); }, 500, state.game);
            }
        }
        state.cancelGameVariable = false;
        state.gameState = State.STOP;
        state.playSituation = Situation.STOP;
        updateTeams();
        handlePlayersStop(byPlayer);
        handleActivityStop();
    }

    function onGamePause(byPlayer) {
        if (mentionPlayersUnpause && state.gameState == State.PAUSE) {
            if (byPlayer != null) {
                room.sendAnnouncement(
                    `Игра остановлена ${byPlayer.name} !`,
                    null,
                    defaultColor,
                    'bold',
                    HaxNotification.NONE
                );
            } else {
                room.sendAnnouncement(
                    `Игра остановлена !`,
                    null,
                    defaultColor,
                    'bold',
                    HaxNotification.NONE
                );
            }
        }
        clearTimeout(state.unpauseTimeout);
        state.gameState = State.PAUSE;
    }

    function onGameUnpause(byPlayer) {
        state.unpauseTimeout = setTimeout(() => {
            state.gameState = State.PLAY;
        }, 2000);
        if (mentionPlayersUnpause) {
            if (byPlayer != null) {
                room.sendAnnouncement(
                    `Игра возобновлена ${byPlayer.name} !`,
                    null,
                    defaultColor,
                    'bold',
                    HaxNotification.NONE
                );
            } else {
                room.sendAnnouncement(
                    `Игра возобновлена !`,
                    null,
                    defaultColor,
                    'bold',
                    HaxNotification.NONE
                );
            }
        }
        if (
            (state.teamRed.length == teamSize && state.teamBlue.length == teamSize && state.chooseMode) ||
            (state.teamRed.length == state.teamBlue.length && state.teamSpec.length < 2 && state.chooseMode)
        ) {
            deactivateChooseMode();
        }
    }

    function onTeamGoal(team) {
        const scores = room.getScores();
        state.game.scores = scores;
        state.playSituation = Situation.GOAL;
        state.ballSpeed = getBallSpeed();
        const goalString = getGoalString(team);
        for (let player of state.teamRed) {
            const playerComp = getPlayerComp(player);
            team == Team.RED ? playerComp.goalsScoredTeam++ : playerComp.goalsConcededTeam++;
        }
        for (let player of state.teamBlue) {
            const playerComp = getPlayerComp(player);
            team == Team.BLUE ? playerComp.goalsScoredTeam++ : playerComp.goalsConcededTeam++;
        }
        room.sendAnnouncement(
            goalString,
            null,
            team == Team.RED ? redColor : blueColor,
            null,
            HaxNotification.CHAT
        );
        discordBot.sendLog(`[${getDate()}] ${goalString}`);
        // The scorer.team === team check excludes own goals — on an own
        // goal, lastTouches[0] is the player who caused it, on the OPPOSING
        // side from the team that benefits (see goalAttribution.js's own
        // team-mismatch branch) — so this only ever fires for a genuine,
        // deliberate goal.
        const scorer = state.lastTouches[0]?.player;
        if (scorer != null && scorer.team === team) {
            playGoalAnimation(scorer).catch((err) => console.error('[economy] playGoalAnimation failed:', err));
        }
        if ((scores.scoreLimit != 0 && (scores.red == scores.scoreLimit || scores.blue == scores.scoreLimit)) || state.goldenGoal) {
            endGame(team);
            state.goldenGoal = false;
            state.stopTimeout = setTimeout(() => {
                room.stopGame();
            }, 1000);
        }
    }

    function onPositionsReset() {
        state.lastTouches = Array(2).fill(null);
        state.lastTeamTouched = Team.SPECTATORS;
        state.playSituation = Situation.KICKOFF;
    }

    return {
        onGameStart,
        onGameStop,
        onGamePause,
        onGameUnpause,
        onTeamGoal,
        onPositionsReset,
    };
};
