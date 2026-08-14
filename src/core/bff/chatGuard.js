/*
 * BFF's own spam-flood + mute check, PLUS the manual !mute/!unmute/!mutes/
 * !hide moderation commands — forked out of events/activity.js's
 * checkSpamFlood/isMuted/announceMuted and commands/admin.js's
 * muteCommand/unmuteCommand/muteListCommand/hideCommand respectively
 * (identical thresholds/behavior in every case), not reused as-is:
 * activity.js's onPlayerChat is far too coupled to trophies/clubs/economy/
 * pauseVote/chooseMode, and admin.js's factory bundles these 4 functions
 * together with restart/swap/kickTeam/stadium commands BFF doesn't want,
 * which would need dummy stadium-map/instantRestart/swapButton values just
 * to construct (see haxchill-second-room-plan project memory).
 *
 * Mutable room state is reached through `state`/`authArray`, never
 * captured by value: those bindings are reassigned on every room event.
 */
module.exports = function createBffChatGuard({
    room,
    authArray,
    MutePlayer,
    muteArray,
    hiddenAdminsSet,
    announcementColor,
    errorColor,
    HaxNotification,
    muteDuration = 5,
    spamWindowMs = 4000,
    spamMessageThreshold = 5,
    spamMuteMinutes = 5,
}) {
    const recentMessageTimestamps = new Map(); // auth -> timestamps[]

    function checkSpamFlood(player) {
        if (player.admin) return;
        const auth = authArray[player.id][0];
        if (muteArray.getByAuth(auth) != null) return;
        const now = Date.now();
        const timestamps = (recentMessageTimestamps.get(auth) ?? []).filter((t) => now - t < spamWindowMs);
        timestamps.push(now);
        if (timestamps.length < spamMessageThreshold) {
            recentMessageTimestamps.set(auth, timestamps);
            return;
        }
        recentMessageTimestamps.delete(auth);
        const muteObj = new MutePlayer(player.name, player.id, auth);
        muteObj.setDuration(spamMuteMinutes);
        room.sendAnnouncement(
            `🔇 ${player.name} автоматически замучен(а) на ${spamMuteMinutes} минут за спам в чате.`,
            null,
            errorColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    function isMuted(player) {
        return !player.admin && muteArray.getByAuth(authArray[player.id][0]) != null;
    }

    function announceMuted(player) {
        room.sendAnnouncement(`Вы замучены !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    // !mute #<id> [минуты] — Role.ADMIN_TEMP, same as the main room.
    function muteCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray[0].length > 0 && msgArray[0][0] == '#') {
                msgArray[0] = msgArray[0].substring(1, msgArray[0].length);
                if (room.getPlayer(parseInt(msgArray[0])) != null) {
                    const playerMute = room.getPlayer(parseInt(msgArray[0]));
                    let minutesMute = muteDuration;
                    if (msgArray.length > 1 && parseInt(msgArray[1]) > 0) {
                        minutesMute = parseInt(msgArray[1]);
                    }
                    if (!playerMute.admin) {
                        const muteObj = new MutePlayer(playerMute.name, playerMute.id, authArray[playerMute.id][0]);
                        muteObj.setDuration(minutesMute);
                        room.sendAnnouncement(`${playerMute.name} был замучен на ${minutesMute} минут.`, null, announcementColor, 'bold', null);
                    } else {
                        room.sendAnnouncement(`Вы не можете замутить администратора.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                    }
                } else {
                    room.sendAnnouncement(`Игрока с таким ID нет в комнате. Введите "!help mute" для получения информации.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                }
            } else {
                room.sendAnnouncement(`Неверный формат вашего аргумента. Введите "!help mute" для получения информации.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            }
        } else {
            room.sendAnnouncement(`Неверное количество аргументов. Введите "!help mute" для получения информации.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
        }
    }

    // !unmute #<id> or !unmute <muteId> — Role.ADMIN_TEMP.
    function unmuteCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray[0].length > 0 && msgArray[0][0] == '#') {
                msgArray[0] = msgArray[0].substring(1, msgArray[0].length);
                if (room.getPlayer(parseInt(msgArray[0])) != null) {
                    const playerUnmute = room.getPlayer(parseInt(msgArray[0]));
                    if (muteArray.getByPlayerId(playerUnmute.id) != null) {
                        const muteObj = muteArray.getByPlayerId(playerUnmute.id);
                        muteObj.remove();
                        room.sendAnnouncement(`${playerUnmute.name} был размучен !`, null, announcementColor, 'bold', HaxNotification.CHAT);
                    } else {
                        room.sendAnnouncement(`Этот игрок не замучен !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                    }
                } else {
                    room.sendAnnouncement(`Игрока с таким ID нет в комнате. Введите "!help unmute" для получения информации.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                }
            } else if (msgArray[0].length > 0 && parseInt(msgArray[0]) > 0 && muteArray.getById(parseInt(msgArray[0])) != null) {
                const playerUnmute = muteArray.getById(parseInt(msgArray[0]));
                playerUnmute.remove();
                room.sendAnnouncement(`${playerUnmute.name} был размучен !`, null, announcementColor, 'bold', HaxNotification.CHAT);
            } else {
                room.sendAnnouncement(`Неверный формат вашего аргумента. Введите "!help unmute" для получения информации.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            }
        } else {
            room.sendAnnouncement(`Неверное количество аргументов. Введите "!help unmute" для получения информации.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
        }
    }

    // !mutes — Role.ADMIN_TEMP, lists everyone currently muted.
    function muteListCommand(player) {
        if (muteArray.list.length == 0) {
            room.sendAnnouncement("🔇 В списке мутов никого нет.", player.id, announcementColor, 'bold', null);
            return;
        }
        let cstm = '🔇 Список мутов : ';
        for (const mute of muteArray.list) {
            cstm += mute.name + `[${mute.id}], `;
        }
        cstm = cstm.substring(0, cstm.length - 2) + '.';
        room.sendAnnouncement(cstm, player.id, announcementColor, 'bold', null);
    }

    // !hide — Role.ADMIN_TEMP. Toggles the room admin crown + chat prefix
    // without touching adminList/masterList — role/permissions untouched.
    function hideCommand(player) {
        if (hiddenAdminsSet.has(player.id)) {
            hiddenAdminsSet.delete(player.id);
            room.setPlayerAdmin(player.id, true);
            room.sendAnnouncement(`👁️ Скрытность отключена — бейдж и префикс снова видны.`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
        } else {
            hiddenAdminsSet.add(player.id);
            room.setPlayerAdmin(player.id, false);
            room.sendAnnouncement(`🕶️ Скрытность включена — бейдж и префикс скрыты.`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
    }

    return { checkSpamFlood, isMuted, announceMuted, muteCommand, unmuteCommand, muteListCommand, hideCommand };
};
