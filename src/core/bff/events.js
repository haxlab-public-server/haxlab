/*
 * BFF's own room.onXxx handlers — deliberately NOT events/movement.js,
 * events/activity.js's chat-only portions, or events/gameManagement.js:
 * those are threaded through with economy/poker/blackjack/club/pause-vote
 * dependencies BFF doesn't have (confirmed by reading their factory
 * signatures before deciding to fork rather than stub them all out).
 *
 * `endGame` is injected rather than defined here — same "composition-root
 * function, not a factory-extracted module" convention the main room uses
 * for its own checkTime/endGame (see entry.js) — it lives in bffEntry.js
 * itself, alongside checkTime, wired to room.onGameTick there.
 */
module.exports = function createBffEvents({
    room,
    state,
    authArray,
    db,
    Team,
    State,
    Situation,
    Game,
    HaxNotification,
    Role,
    announcementColor,
    errorColor,
    infoColor,
    welcomeColor,
    redColor,
    blueColor,
    masterList,
    maxPlayers,
    discordBot,
    getDate,
    getRole,
    getGoalString,
    getPlayerComp,
    getStartingLineups,
    handleLineupChangeLeave,
    handleLineupChangeTeamChange,
    ghostKickHandle,
    updateTeams,
    calculateStadiumVariables,
    checkOverflowPassword,
    endGame,
    matchFlow,
    bffRoomStats,
    teamSize,
    fetchSummaryEmbed,
    fetchRecording,
}) {
    async function onPlayerJoin(player) {
        authArray[player.id] = [player.auth, player.conn];

        // BFF's own ban list — explicitly NOT shared with the main room
        // (confirmed 2026-08-14, see haxchill-second-room-plan memory).
        const ban = await db.getAuthBan(player.auth);
        if (ban) {
            room.kickPlayer(player.id, ban.reason ? `Вы забанены: ${ban.reason}` : 'Вы забанены.', false);
            return;
        }

        discordBot.sendLog(
            `[${getDate()}] ➡️ JOIN (${state.playersAll.length + 1}/${maxPlayers})\n**` +
            `${player.name}** [${authArray[player.id][0]}] {${authArray[player.id][1]}}`
        );
        room.sendAnnouncement(`${player.name} [${player.auth}]`, null, infoColor, 'small', null);
        room.sendAnnouncement(
            `👋 Добро пожаловать ${player.name} !`,
            player.id,
            welcomeColor,
            'bold',
            HaxNotification.CHAT
        );

        updateTeams();
        discordBot.updateRoomStatus();
        checkOverflowPassword();
        // Fairness queue (see matchFlow.js's assembleMatch) — every fresh
        // joiner starts at the back of the line, same as anyone benched
        // after playing. Harmless even if matchFlow.handlePlayersJoin()
        // below immediately pulls them into a match — the entry just goes
        // unused until they're ever benched again.
        state.specQueueSince.set(player.id, Date.now());

        // Masters/admins are shared with the main room (see dbBridge.js) —
        // same badge-on-join announcement as the main room's own
        // movement.js.
        if (masterList.includes(player.auth)) {
            room.sendAnnouncement(`Владелец ${player.name} присоединился к комнате !`, null, announcementColor, 'bold', HaxNotification.CHAT);
            room.setPlayerAdmin(player.id, true);
        } else if (state.adminList.some((a) => a[0] === player.auth)) {
            room.sendAnnouncement(`Админ ${player.name} присоединился к комнате !`, null, announcementColor, 'bold', HaxNotification.CHAT);
            room.setPlayerAdmin(player.id, true);
        }

        // Same auth-only (not conn) ghost-kick check as the main room —
        // see movement.js's own comment for why conn was tried and reverted.
        const duplicateCheck = state.playersAll.filter((p) => p.id != player.id && authArray[p.id][0] == player.auth);
        for (const oldPlayer of duplicateCheck) {
            ghostKickHandle(oldPlayer, player);
        }

        await matchFlow.handlePlayersJoin();
    }

    async function onPlayerLeave(player) {
        setTimeout(() => {
            discordBot.sendLog(
                `[${getDate()}] ⬅️ LEAVE (${state.playersAll.length}/${maxPlayers})\n**${player.name}**` +
                `[${authArray[player.id][0]}] {${authArray[player.id][1]}}`
            );
            room.sendAnnouncement(`${player.name} [${authArray[player.id][0]}]`, null, infoColor, 'small', null);
        }, 10);
        // Keeps state.game.playerComp's timeEntry/timeExit accurate for
        // whoever was actually ON a team when they disconnected mid-match
        // — needed for correct playtime/stat attribution (see
        // stats/playerStats.js), same as the main room's movement.js.
        handleLineupChangeLeave(player);
        updateTeams();
        discordBot.updateRoomStatus();
        checkOverflowPassword();
        // Tidies up the fairness queue map — harmless to skip (an orphaned
        // entry for a departed player is never read again, since they're
        // gone from room.getPlayerList()), just hygiene.
        state.specQueueSince.delete(player.id);
        await matchFlow.handlePlayersLeave();
    }

    // Teams are locked (room.setTeamsLock(true), see bffEntry.js) — a
    // player can never self-assign, only matchFlow.js's own
    // room.setPlayerTeam calls move anyone. No captain-pick/swap-window
    // complexity to handle here at all, unlike the main room's equivalent.
    function onPlayerTeamChange(changedPlayer) {
        handleLineupChangeTeamChange(changedPlayer);
        updateTeams();
    }

    function onPlayerKicked(kickedPlayer, reason, ban, byPlayer) {
        discordBot.sendLog(
            `[${getDate()}] ⛔ ${ban ? 'BAN' : 'KICK'} (${state.playersAll.length}/${maxPlayers})\n` +
            `**${kickedPlayer.name}** [${authArray[kickedPlayer.id][0]}] {${authArray[kickedPlayer.id][1]}} was ${ban ? 'banned' : 'kicked'}` +
            `${byPlayer != null ? ' by **' + byPlayer.name + '** [' + authArray[byPlayer.id][0] + ']' : ''}`
        );
        // Same self-ban/master-immunity safety net as the main room's
        // movement.js: a master can never be banned, and nobody can ban
        // themselves via the native client dialog.
        if (ban && ((byPlayer != null && (byPlayer.id == kickedPlayer.id || getRole(byPlayer) < Role.MASTER)) || getRole(kickedPlayer) == Role.MASTER)) {
            room.clearBan(kickedPlayer.id);
            return;
        }
        if (byPlayer != null && getRole(byPlayer) < Role.ADMIN_PERM) {
            room.sendAnnouncement('Вам не разрешено кикать/банить игроков !', byPlayer.id, errorColor, 'bold', HaxNotification.CHAT);
            room.setPlayerAdmin(byPlayer.id, false);
            return;
        }
        // Feeds !banlist/!clearbans (see commands/master.js) — the native,
        // connection-based ban list, separate from the auth-based system.
        if (ban) state.banList.push([kickedPlayer.name, kickedPlayer.id]);
    }

    function onGameStart() {
        // Real gap found comparing against the main room's own onGameStart:
        // events/misc.js (reused as-is) has onKickRateLimitSet, which slaps
        // the kick rate limit down to (6,0,0) the instant anyone tampers
        // with it — the main room's onGameStart re-applies the real (6,12,4)
        // every match specifically to undo that lockdown before the next
        // kickoff. Without this, a single tampering attempt would leave
        // BFF's kick rate degraded for the rest of the room's life, never
        // restored by anything.
        room.setKickRateLimit(6, 12, 4);
        // Defensive, matching the main room's own onGameStart: guards
        // against a stale scheduled room.stopGame() (from checkTime/
        // onTeamGoal's own state.stopTimeout) firing after a fresh match
        // has already started, which would cut it short immediately.
        clearTimeout(state.stopTimeout);
        state.game = new Game(room, getStartingLineups);
        state.gameState = State.PLAY;
        state.endGameVariable = false;
        state.goldenGoal = false;
        state.playSituation = Situation.KICKOFF;
        // Not displayed anywhere in BFF, but stats/global.js's
        // getGameStats() (reused as-is) still tracks them every tick — see
        // bffEntry.js's own init comment on state.possession. Reset per
        // match, same as the main room's own onGameStart, so they don't
        // just accumulate meaninglessly across matches forever.
        state.possession = [0, 0];
        state.actionZoneHalf = [0, 0];
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
        calculateStadiumVariables();
    }

    // byPlayer==null + state.endGameVariable means a genuine natural
    // conclusion (endGame() already ran, from onTeamGoal or checkTime in
    // bffEntry.js) — same convention the main room's onGameStop uses to
    // tell that apart from an admin/native mid-round stop. A forced stop
    // just resets bookkeeping; matchFlow.js's own handlePlayersStop already
    // no-ops on byPlayer != null, so nothing double-fires either way.
    async function onGameStop(byPlayer) {
        state.gameState = State.STOP;
        state.playSituation = Situation.STOP;
        // Recording is always stopped, even on a forced/admin stop below —
        // same as the main room's onGameStop via room.stopRecording() —
        // but only actually uploaded to Discord on a genuine natural end
        // (see the fetchRecording call further down).
        if (state.game) state.game.rec = room.stopRecording();
        updateTeams();
        if (byPlayer == null && state.endGameVariable) {
            const outcome = state.lastWinner === Team.RED ? 'red' : state.lastWinner === Team.BLUE ? 'blue' : 'draw';
            try {
                await bffRoomStats.updateStats();
            } catch (err) {
                console.error('[bff/events] updateStats failed:', err);
                discordBot.sendLog(`⚠️ [BFF] Не удалось сохранить статистику: ${err.message}`);
            }
            // Every natural match end gets reported, any size — same
            // unconditional-by-size behavior as the main room's own
            // onGameStop (only the RATING update above is gated to a full
            // house, per matchFlow.js's own teamSize check).
            fetchSummaryEmbed(state.game);
            setTimeout((gameEnd) => { fetchRecording(gameEnd, discordBot); }, 500, state.game);
            await matchFlow.handlePlayersStop(null, outcome);
        } else {
            await matchFlow.handlePlayersStop(byPlayer, null);
        }
    }

    function onTeamGoal(team) {
        const scores = room.getScores();
        state.game.scores = scores;
        state.playSituation = Situation.GOAL;
        // Called ONCE — getGoalString has a side effect (pushes a Goal
        // record onto state.game.goals via goalAttribution.js), so calling
        // it a second time for the Discord log would double-record every
        // single goal.
        const goalString = getGoalString(team);
        room.sendAnnouncement(goalString, null, team == Team.RED ? redColor : blueColor, 'bold', HaxNotification.CHAT);
        discordBot.sendLog(`[${getDate()}] ${goalString}`);
        // state.goldenGoal (set by bffEntry.js's checkTime once the clock
        // runs out tied) ends the match on THIS goal regardless of the
        // score limit — draws are not possible, same as the main room
        // (confirmed 2026-08-14).
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
        onPlayerJoin,
        onPlayerLeave,
        onPlayerTeamChange,
        onPlayerKicked,
        onGameStart,
        onGameStop,
        onTeamGoal,
        onPositionsReset,
    };
};
