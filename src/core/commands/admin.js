/*
 * Admin commands: stadium switching, mutes, kicks and match restarts.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createAdminCommands({
    room,
    state,
    authArray,
    muteArray,
    muteDuration,
    MutePlayer,
    trainingMap,
    classicMap,
    bigMap,
    classicScoreLimit,
    classicTimeLimit,
    bigScoreLimit,
    bigTimeLimit,
    State,
    Situation,
    Role,
    announcementColor,
    errorColor,
    HaxNotification,
    hiddenAdminsSet,
    instantRestart,
    swapButton,
    getRole,
}) {
    function restartCommand(player, message) {
        instantRestart();
    }

    function restartSwapCommand(player, message) {
        room.stopGame();
        swapButton();
        state.startTimeout = setTimeout(() => {
            room.startGame();
        }, 10);
    }

    function swapCommand(player, message) {
        if (state.playSituation == Situation.STOP) {
            swapButton();
            room.sendAnnouncement(
                '✔️ Команды поменяны !',
                null,
                announcementColor,
                'bold',
                null
            );
        } else {
            room.sendAnnouncement(
                `Пожалуйста, остановите игру перед сменой команд.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    function kickTeamCommand(player, message) {
        const msgArray = message.split(/ +/);
        let reasonString = `Командное исключение игроком ${player.name}`;
        if (msgArray.length > 1) {
            reasonString = msgArray.slice(1).join(' ');
        }
        if (['!kickred', '!kickr'].includes(msgArray[0].toLowerCase())) {
            for (let i = 0; i < state.teamRed.length; i++) {
                setTimeout(() => {
                    room.kickPlayer(state.teamRed[0].id, reasonString, false);
                }, i * 20)
            }
        } else if (['!kickblue', '!kickb'].includes(msgArray[0].toLowerCase())) {
            for (let i = 0; i < state.teamBlue.length; i++) {
                setTimeout(() => {
                    room.kickPlayer(state.teamBlue[0].id, reasonString, false);
                }, i * 20)
            }
        } else if (['!kickspec', '!kicks'].includes(msgArray[0].toLowerCase())) {
            for (let i = 0; i < state.teamSpec.length; i++) {
                setTimeout(() => {
                    room.kickPlayer(state.teamSpec[0].id, reasonString, false);
                }, i * 20)
            }
        }
    }

    function stadiumCommand(player, message) {
        const msgArray = message.split(/ +/);
        if (state.gameState == State.STOP) {
            if (['!classic'].includes(msgArray[0].toLowerCase())) {
                if (JSON.parse(classicMap).name == 'Classic') {
                    room.setDefaultStadium('Classic');
                } else {
                    room.setCustomStadium(classicMap);
                }
                state.currentStadium = 'classic';
                room.setScoreLimit(classicScoreLimit);
                room.setTimeLimit(classicTimeLimit);
            } else if (['!big'].includes(msgArray[0].toLowerCase())) {
                if (JSON.parse(bigMap).name == 'Big') {
                    room.setDefaultStadium('Big');
                } else {
                    room.setCustomStadium(bigMap);
                }
                state.currentStadium = 'big';
                room.setScoreLimit(bigScoreLimit);
                room.setTimeLimit(bigTimeLimit);
            } else if (['!training'].includes(msgArray[0].toLowerCase())) {
                room.setCustomStadium(trainingMap);
                state.currentStadium = 'training';
            } else {
                room.sendAnnouncement(
                    `Арена не распознана.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        } else {
            room.sendAnnouncement(
                `Пожалуйста, остановите игру перед использованием этой команды.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

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
                        room.sendAnnouncement(
                            `${playerMute.name} был замучен на ${minutesMute} минут.`,
                            null,
                            announcementColor,
                            'bold',
                            null
                        );
                    } else {
                        room.sendAnnouncement(
                            `Вы не можете замутить администратора.`,
                            player.id,
                            errorColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    }
                } else {
                    room.sendAnnouncement(
                        `Игрока с таким ID нет в комнате. Введите "!help mute" для получения информации.`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
            } else {
                room.sendAnnouncement(
                    `Неверный формат вашего аргумента. Введите "!help mute" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        } else {
            room.sendAnnouncement(
                `Неверное количество аргументов. Введите "!help mute" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    function unmuteCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray[0].length > 0 && msgArray[0][0] == '#') {
                msgArray[0] = msgArray[0].substring(1, msgArray[0].length);
                if (room.getPlayer(parseInt(msgArray[0])) != null) {
                    const playerUnmute = room.getPlayer(parseInt(msgArray[0]));
                    if (muteArray.getByPlayerId(playerUnmute.id) != null) {
                        const muteObj = muteArray.getByPlayerId(playerUnmute.id);
                        muteObj.remove()
                        room.sendAnnouncement(
                            `${playerUnmute.name} был размучен !`,
                            null,
                            announcementColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    } else {
                        room.sendAnnouncement(
                            `Этот игрок не замучен !`,
                            player.id,
                            errorColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    }
                } else {
                    room.sendAnnouncement(
                        `Игрока с таким ID нет в комнате. Введите "!help unmute" для получения информации.`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
            } else if (msgArray[0].length > 0 && parseInt(msgArray[0]) > 0 && muteArray.getById(parseInt(msgArray[0])) != null) {
                const playerUnmute = muteArray.getById(parseInt(msgArray[0]));
                playerUnmute.remove();
                room.sendAnnouncement(
                    `${playerUnmute.name} был размучен !`,
                    null,
                    announcementColor,
                    'bold',
                    HaxNotification.CHAT
                );
            } else {
                room.sendAnnouncement(
                    `Неверный формат вашего аргумента. Введите "!help unmute" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        } else {
            room.sendAnnouncement(
                `Неверное количество аргументов. Введите "!help unmute" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // Toggles the room admin crown + chat prefix without touching
    // adminList/masterList — role/permissions stay exactly as they were,
    // only the visible indicators change. onPlayerAdminChange (misc.js)
    // normally auto-restores the crown for ADMIN_PERM/MASTER the instant
    // it's removed; it checks hiddenAdminsSet first specifically so this
    // command's own room.setPlayerAdmin(id, false) call actually sticks
    // instead of being immediately undone.
    function hideCommand(player, message) {
        if (hiddenAdminsSet.has(player.id)) {
            hiddenAdminsSet.delete(player.id);
            room.setPlayerAdmin(player.id, true);
            room.sendAnnouncement(
                `👁️ Скрытность отключена — бейдж и префикс снова видны.`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
        } else {
            hiddenAdminsSet.add(player.id);
            room.setPlayerAdmin(player.id, false);
            room.sendAnnouncement(
                `🕶️ Скрытность включена — бейдж и префикс скрыты.`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    function muteListCommand(player, message) {
        if (muteArray.list.length == 0) {
            room.sendAnnouncement(
                "🔇 В списке мутов никого нет.",
                player.id,
                announcementColor,
                'bold',
                null
            );
            return false;
        }
        let cstm = '🔇 Список мутов : ';
        for (let mute of muteArray.list) {
            cstm += mute.name + `[${mute.id}], `;
        }
        cstm = cstm.substring(0, cstm.length - 2) + '.';
        room.sendAnnouncement(
            cstm,
            player.id,
            announcementColor,
            'bold',
            null
        );
    }

    // Discord-triggered mute (see discord.js's !muteauth/`/muteauth`, gated
    // there to the room owner or the configured admin role) — same
    // MutePlayer/muteArray mechanism as muteCommand above, just targeting
    // whoever currently holds `auth` instead of a live #<id>, since Discord
    // has no room ids to give. Requires the target to actually be online
    // right now (same constraint muteCommand has via room.getPlayer) —
    // unlike !banauth, this can't reach someone who isn't currently in the
    // room. Re-mutes (replacing any existing mute's timer) rather than
    // stacking two independent auto-unmute timeouts for the same auth.
    function muteByAuth(auth, minutes) {
        const target = state.playersAll.find((p) => authArray[p.id]?.[0] === auth);
        if (!target) return { ok: false, reason: 'offline' };
        if (getRole(target) >= Role.ADMIN_TEMP) return { ok: false, reason: 'admin' };
        const existingMute = muteArray.getByAuth(auth);
        if (existingMute) existingMute.remove();
        const muteObj = new MutePlayer(target.name, target.id, auth);
        muteObj.setDuration(minutes);
        room.sendAnnouncement(
            `${target.name} был замучен на ${minutes} минут.`,
            null,
            announcementColor,
            'bold',
            null
        );
        return { ok: true, name: target.name };
    }

    // Companion to muteByAuth above — same auth-keyed lookup unmuteCommand
    // already uses for its #<id> path, just reachable from Discord.
    function unmuteByAuth(auth) {
        const existingMute = muteArray.getByAuth(auth);
        if (!existingMute) return { ok: false };
        const name = existingMute.name;
        existingMute.remove();
        room.sendAnnouncement(
            `${name} был размучен !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        return { ok: true, name };
    }

    return {
        restartCommand,
        restartSwapCommand,
        swapCommand,
        kickTeamCommand,
        stadiumCommand,
        muteCommand,
        unmuteCommand,
        muteListCommand,
        hideCommand,
        muteByAuth,
        unmuteByAuth,
    };
};
