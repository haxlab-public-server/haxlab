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
    Trophies,
    adminChatColor,
    commands,
    discordBot,
    errorColor,
    hiddenAdminsSet,
    masterChatColor,
    muteArray,
    vipChatColor,
    checkGoalKickTouch,
    chooseModeFunction,
    formatTrophyLabel,
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

        // Every chat message is sent through room.sendAnnouncement, never
        // left to HaxBall's native chat bubble — same trick teamChat/
        // playerChat already use above. MASTER/ADMIN/VIP get a role prefix
        // and keep the bold style; everyone else (including plain players
        // and club/trophy-only prefixes) renders in the normal style.
        // !hide (commands/admin.js) suppresses just the MASTER/ADMIN prefix
        // — role/permissions are untouched, so a hidden VIP-flagged admin
        // would still fall through to the VIP prefix rather than none at all.
        const role = getRole(player);
        const showAdminPrefix = !hiddenAdminsSet.has(player.id);
        let rolePrefix = null;
        let prefixColor = null;
        if (showAdminPrefix && role == Role.MASTER) {
            rolePrefix = '[👑СЗД]';
            prefixColor = masterChatColor;
        } else if (showAdminPrefix && role >= Role.ADMIN_TEMP) {
            rolePrefix = '[🛡️АДМ]';
            prefixColor = adminChatColor;
        } else if (role == Role.VIP) {
            rolePrefix = '[⭐ВИП]';
            prefixColor = vipChatColor;
        }
        // Full prefix order is [клуб] [трофей] [роль] — club tag first, then
        // the equipped trophy (!trophy, see commands/trophies.js), then the
        // role prefix last. They stack rather than one replacing another
        // (e.g. an admin who's also in a club shows both) — the role's own
        // color always wins over the club's custom one, since a role is
        // never "hidden" here whereas a club member with no custom color set
        // just falls back to the default chat color (see constants.js's
        // defaultColor/null semantics in room.sendAnnouncement).
        const auth = authArray[player.id][0];
        const membership = state.clubMembers.find((m) => m.auth == auth);
        const club = membership && state.clubs.find((c) => c.id == membership.clubId);
        const clubPrefix = club ? `[${club.emoji ?? ''}${club.prefix}]` : null;
        // Tracked separately from prefixColor itself: only a color that
        // actually came from the club is a per-viewer preference
        // (!customcolors, see commands/player.js) — a role's color never is.
        let usesClubColor = false;
        if (club && prefixColor == null) {
            prefixColor = club.color;
            usesClubColor = club.color != null;
        }
        // A trophy only actually shows while state.topPlayers still agrees
        // the player holds a top-3 spot — an equipped-but-since-lost trophy
        // silently stops appearing rather than lying (see commands/trophies.js).
        // The medal (🥇/🥈/🥉) always reflects the player's ACTUAL current
        // rank, never whatever it was when they last ran !trophy.
        const equippedTrophyKey = state.equippedTrophies[auth];
        const equippedRankIndex = equippedTrophyKey
            ? (state.topPlayers[equippedTrophyKey] ?? []).findIndex((e) => e.auth == auth)
            : -1;
        const trophyPrefix = equippedRankIndex !== -1
            ? `[${formatTrophyLabel(Trophies, equippedTrophyKey, equippedRankIndex + 1)}]`
            : null;
        const prefix = [clubPrefix, trophyPrefix, rolePrefix].filter((p) => p != null).join(' ');
        const displayName = prefix ? `${prefix} ${player.name}` : player.name;
        // Only a role (MASTER/ADMIN/VIP) earns the bold style — club/trophy
        // prefixes alone don't, same as a plain player with no prefix at all.
        const style = rolePrefix != null ? 'bold' : 'normal';
        const text = `${displayName}: ${message}`;
        if (usesClubColor) {
            // !customcolors (commands/player.js) is a per-VIEWER preference:
            // whoever has opted out sees this specific message in the
            // default color instead — everyone else still sees the club's
            // chosen color, and the prefix TEXT is identical for both. Only
            // a genuinely per-message loop (rather than one broadcast) can
            // give two viewers different colors for the same line.
            for (const viewer of state.playersAll) {
                const viewerAuth = authArray[viewer.id][0];
                const viewerColor = state.hiddenCustomColorsSet.has(viewerAuth) ? null : prefixColor;
                room.sendAnnouncement(text, viewer.id, viewerColor, style, null);
            }
        } else {
            room.sendAnnouncement(text, null, prefixColor, style, null);
        }
        return false;
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
