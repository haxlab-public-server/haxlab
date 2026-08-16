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
    announceTeamForms,
    balanceTeams,
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
    playGoalSizeEffect,
    resetPauseVotes,
    updateTeams,
    achievementColor,
    infoColor,
    authArray,
    db,
}) {
    // Same-day rematch (item #13) takes priority over a general rivalry
    // callout (item #10) when both would apply — it's the more specific,
    // more timely storyline. Only ONE line ever fires per match start
    // (never both, never one per pair) — same "don't clutter chat with
    // every possible signal" reasoning as the rest of this session's
    // batch. RIVALRY_MIN_GAMES keeps a first-ever meeting (games === 1,
    // which every pair trivially "has" the moment they've played once)
    // from reading as a manufactured rivalry.
    const RIVALRY_MIN_GAMES = 5;
    async function announceMatchupStorylines() {
        const pairs = [];
        for (const red of state.teamRed) {
            for (const blue of state.teamBlue) {
                const authRed = authArray[red.id]?.[0];
                const authBlue = authArray[blue.id]?.[0];
                if (!authRed || !authBlue) continue;
                const h2h = await db.getHeadToHead(authRed, authBlue);
                if (h2h) pairs.push({ red, blue, h2h });
            }
        }
        if (pairs.length === 0) return;

        const today = new Date().toISOString().slice(0, 10);
        const rematchPair = pairs.find((p) => p.h2h.lastPlayedAt.slice(0, 10) === today);
        if (rematchPair) {
            room.sendAnnouncement(
                `🔄 Реванш ! ${rematchPair.red.name} и ${rematchPair.blue.name} уже играли друг против друга сегодня — личный счёт ${rematchPair.h2h.winsFor}-${rematchPair.h2h.winsAgainst}.`,
                null, infoColor, 'bold', HaxNotification.CHAT
            );
            return;
        }

        const biggestRivalry = pairs.reduce((best, p) => (p.h2h.games > (best?.h2h.games ?? 0) ? p : best), null);
        if (biggestRivalry.h2h.games >= RIVALRY_MIN_GAMES) {
            room.sendAnnouncement(
                `🔥 Принципиальная встреча ! ${biggestRivalry.red.name} против ${biggestRivalry.blue.name} — личный счёт ${biggestRivalry.h2h.winsFor}-${biggestRivalry.h2h.winsAgainst}.`,
                null, infoColor, 'bold', HaxNotification.CHAT
            );
        }
    }
    // In-match comeback detection (requested 2026-08-17, item #12) — a
    // COMEBACK_THRESHOLD-goal deficit that gets fully erased (level or
    // ahead) is called out the instant it happens, not after the match
    // ends. Per-team running "worst deficit faced so far this match" and a
    // one-shot "already announced" flag, both reset every onGameStart —
    // see onTeamGoal's own comment for exactly how they're used together.
    const COMEBACK_THRESHOLD = 3;
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
        state.matchWorstDeficit = { [Team.RED]: 0, [Team.BLUE]: 0 };
        state.comebackAnnounced = { [Team.RED]: false, [Team.BLUE]: false };
        // Clean-sheet watch (item #14) — reset here alongside the other
        // per-match flags above even though checkTime() (entry.js) is the
        // only thing that ever reads/sets it; state is shared, this is
        // just the established "everything per-match resets in
        // onGameStart" convention.
        state.cleanSheetWatchAnnounced = false;
        // !votepause (see core/pauseVote.js) — once-per-match allowance
        // resets on every fresh match, same as the rest of this function's
        // per-round state.
        resetPauseVotes();
        state.pauseVoteUsed = { [Team.RED]: false, [Team.BLUE]: false };
        // !tip #<id> (commands/player.js) — once-per-match allowance, same
        // "everything per-match resets in onGameStart" convention as
        // pauseVoteUsed just above.
        state.tipUsedThisMatch = new Set();
        if (state.teamRed.length == teamSize && state.teamBlue.length == teamSize) {
            for (let i = 0; i < teamSize; i++) {
                state.teamRedStats.push(state.teamRed[i]);
                state.teamBlueStats.push(state.teamBlue[i]);
            }
        }
        // Defensive re-apply: HaxBall can reset a disc's custom color across
        // a stadium change/restart, independent of any team-change event — a
        // fresh match start is the other moment (alongside movement.js's
        // onPlayerTeamChange) a worn form could otherwise silently fall off.
        // announceTeamForms (not the silent applyTeamForms movement.js uses
        // on every roster change) since a genuine match start is
        // specifically when players should be told what forms are in play
        // this round. 'size' has no standing state to re-apply here at all —
        // see playGoalSizeEffect's doc comment in economy.js.
        announceTeamForms().catch((err) => console.error('[economy] announceTeamForms failed:', err));
        calculateStadiumVariables();
        room.setKickRateLimit(6, 12, 4);
        // Items #10/#13 — deliberately NOT gated behind the teamSize-only
        // block above: a rivalry/rematch pairing is just as real in a 1v1
        // or 2v2 as it is in a full house, so this reads straight off
        // state.teamRed/state.teamBlue (the actual current rosters of
        // whatever size just started), not the teamSize-gated *Stats
        // snapshots.
        announceMatchupStorylines().catch((err) => console.error('[gameManagement] announceMatchupStorylines failed:', err));
    }

    function onGameStop(byPlayer) {
        clearTimeout(state.stopTimeout);
        clearTimeout(state.unpauseTimeout);
        if (byPlayer != null) clearTimeout(state.startTimeout);
        resetPauseVotes();
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
        // Bug (reported live): handlePlayersStop only ever does anything on
        // a NATURAL end (byPlayer==null, the round's own endGame() already
        // ran) — a genuine admin/native stop mid-round (someone pausing
        // the game directly in the HaxBall client, not via !restart or any
        // command that manages its own follow-up) leaves the roster
        // completely unmanaged: no bench, no refill, nothing scheduled to
        // ever restart it. The room just sits there until some UNRELATED
        // join/leave/afk happens to trigger balanceTeams() on its own —
        // reported live as the room eventually limping back to life via a
        // side effect of an unrelated choose-mode session, landing on a
        // half-built team (blue with no captain, sometimes no blue at
        // all). The room's policy is that it should keep working on its
        // own regardless of why it stopped — so whenever
        // handlePlayersStop's own guard didn't fire, fall back to the same
        // ordinary self-heal joins/leaves already get, right away instead
        // of waiting on an unrelated event to trigger it.
        if (!(byPlayer == null && state.endGameVariable)) {
            balanceTeams();
        }
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
            'bold',
            HaxNotification.CHAT
        );
        discordBot.sendLog(`[${getDate()}] ${goalString}`);
        // In-match comeback detection (item #12) — must run BEFORE updating
        // matchWorstDeficit below with THIS goal's own result: the check is
        // "how far behind were they at some point BEFORE this exact goal",
        // not "how far behind are they right now" (which, for the team
        // that just scored, can only ever have gotten smaller).
        const scoringTeamOldWorstDeficit = state.matchWorstDeficit[team];
        state.matchWorstDeficit[Team.RED] = Math.max(state.matchWorstDeficit[Team.RED], scores.blue - scores.red);
        state.matchWorstDeficit[Team.BLUE] = Math.max(state.matchWorstDeficit[Team.BLUE], scores.red - scores.blue);
        const scoringTeamNowLevelOrAhead = team == Team.RED ? scores.red >= scores.blue : scores.blue >= scores.red;
        if (scoringTeamOldWorstDeficit >= COMEBACK_THRESHOLD && scoringTeamNowLevelOrAhead && !state.comebackAnnounced[team]) {
            state.comebackAnnounced[team] = true;
            const teamName = team == Team.RED ? 'Красная команда' : 'Синяя команда';
            const verb = scores.red === scores.blue ? 'сравняла счёт' : 'вышла вперёд';
            room.sendAnnouncement(
                `🔄 Какой камбэк ! ${teamName} отыгрывалась с отставания в ${scoringTeamOldWorstDeficit} мяча и только что ${verb} !`,
                null,
                achievementColor,
                'bold',
                HaxNotification.MENTION
            );
        }
        // The scorer.team === team check excludes own goals — on an own
        // goal, lastTouches[0] is the player who caused it, on the OPPOSING
        // side from the team that benefits (see goalAttribution.js's own
        // team-mismatch branch) — so this only ever fires for a genuine,
        // deliberate goal.
        const scorer = state.lastTouches[0]?.player;
        if (scorer != null && scorer.team === team) {
            playGoalAnimation(scorer).catch((err) => console.error('[economy] playGoalAnimation failed:', err));
            playGoalSizeEffect(scorer).catch((err) => console.error('[economy] playGoalSizeEffect failed:', err));
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
