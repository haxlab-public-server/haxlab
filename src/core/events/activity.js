/*
 * room.onPlayerChat/BallKick/Activity — chat commands and per-tick activity tracking.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createActivityEvents({
    room,
    state,
    authArray,
    BallTouch,
    HaxNotification,
    Role,
    Situation,
    State,
    Team,
    adminChatColor,
    commands,
    discordBot,
    errorColor,
    masterChatColor,
    muteArray,
    vipChatColor,
    checkGoalKickTouch,
    chooseModeFunction,
    getCommand,
    getDate,
    getGoalGame,
    getPlayerComp,
    getRole,
    playerChat,
    slowModeFunction,
    teamChat,
}) {
    function onPlayerChat(player, message) {
        if (state.gameState !== State.STOP && player.team != Team.SPECTATORS) {
            let pComp = getPlayerComp(player);
            if (pComp != null) pComp.inactivityTicks = 0;
        }
        let msgArray = message.split(/ +/);
        discordBot.sendLog(`[${getDate()}] 💬 CHAT\n**${player.name}** : ${message.replace('@', '@ ')}`);
        if (msgArray[0][0] == '!') {
            let command = getCommand(msgArray[0].slice(1).toLowerCase());
            if (command != false && commands[command].roles <= getRole(player)) {
                // Fire-and-forget, same as every call site here always was —
                // some command functions are now async (they touch the DB
                // through a bridge), so this catches a rejection that would
                // otherwise have nothing else awaiting it and become an
                // unhandled rejection instead of a logged, per-command error.
                const result = commands[command].function(player, message);
                if (result instanceof Promise) result.catch((err) => console.error(`Error in command !${command}:`, err));
            }
            else
                room.sendAnnouncement(
                    `Команда, которую вы пытались ввести, не существует для вас. Введите "!help" для получения доступных команд.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            return false;
        }
        if (msgArray[0].toLowerCase() == 't') {
            teamChat(player, message);
            return false;
        }
        if (msgArray[0].substring(0, 2) === '@@') {
            playerChat(player, message);
            return false;
        }
        if (state.chooseMode && state.teamRed.length * state.teamBlue.length != 0) {
            const choosingMessageCheck = chooseModeFunction(player, message);
            if (choosingMessageCheck) return false;
        }
        if (state.slowMode > 0) {
            const filter = slowModeFunction(player, message);
            if (filter) return false;
        }
        if (!player.admin && muteArray.getByAuth(authArray[player.id][0]) != null) {
            room.sendAnnouncement(
                `Вы замучены !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return false;
        }

        // MASTER/ADMIN/VIP get a role prefix on ordinary chat — HaxBall's
        // default chat bubble can't show one, so it's suppressed (return
        // false) in favor of a custom sendAnnouncement, same trick teamChat/
        // playerChat already use above. Regular players are untouched and
        // keep the native chat bubble.
        const role = getRole(player);
        let prefix = null;
        let prefixColor = null;
        if (role == Role.MASTER) {
            prefix = '👑 [ВЛАДЕЛЕЦ]';
            prefixColor = masterChatColor;
        } else if (role >= Role.ADMIN_TEMP) {
            prefix = '🛡️ [АДМИН]';
            prefixColor = adminChatColor;
        } else if (role == Role.VIP) {
            prefix = '⭐ [ВИП]';
            prefixColor = vipChatColor;
        }
        if (prefix != null) {
            room.sendAnnouncement(
                `${prefix} ${player.name}: ${message}`,
                null,
                prefixColor,
                'bold',
                null
            );
            return false;
        }
    }

    function onPlayerActivity(player) {
        if (state.gameState !== State.STOP) {
            let pComp = getPlayerComp(player);
            if (pComp != null) pComp.inactivityTicks = 0;
        }
    }

    function onPlayerBallKick(player) {
        if (state.playSituation != Situation.GOAL) {
            const ballPosition = room.getBallPosition();
            if (state.game.touchArray.length == 0 || player.id != state.game.touchArray[state.game.touchArray.length - 1].player.id) {
                if (state.playSituation == Situation.KICKOFF) state.playSituation = Situation.PLAY;
                state.lastTeamTouched = player.team;
                state.game.touchArray.push(
                    new BallTouch(
                        player,
                        state.game.scores.time,
                        getGoalGame(),
                        ballPosition
                    )
                );
                state.lastTouches[0] = checkGoalKickTouch(
                    state.game.touchArray,
                    state.game.touchArray.length - 1,
                    getGoalGame()
                );
                state.lastTouches[1] = checkGoalKickTouch(
                    state.game.touchArray,
                    state.game.touchArray.length - 2,
                    getGoalGame()
                );
            }
        }
    }

    return {
        onPlayerChat,
        onPlayerActivity,
        onPlayerBallKick,
    };
};
