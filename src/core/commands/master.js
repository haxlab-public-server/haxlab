/*
 * Master-level commands: ban list maintenance, admin roster and the room password.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createMasterCommands({
    room,
    state,
    authArray,
    db,
    masterList,
    announcementColor,
    errorColor,
    HaxNotification,
}) {
    function clearbansCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length == 0) {
            room.clearBans();
            room.sendAnnouncement(
                '✔️ Баны очищены !',
                null,
                announcementColor,
                'bold',
                null
            );
            state.banList = [];
        } else if (msgArray.length == 1) {
            if (parseInt(msgArray[0]) > 0) {
                const ID = parseInt(msgArray[0]);
                room.clearBan(ID);
                if (state.banList.length != state.banList.filter((p) => p[1] != ID).length) {
                    room.sendAnnouncement(
                        `✔️ ${state.banList.filter((p) => p[1] == ID)[0][0]} был разбанен из комнаты !`,
                        null,
                        announcementColor,
                        'bold',
                        null
                    );
                } else {
                    room.sendAnnouncement(
                        `ID, который вы ввели, не связан с каким-либо баном. Введите "!help clearbans" для получения информации.`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
                state.banList = state.banList.filter((p) => p[1] != ID);
            } else {
                room.sendAnnouncement(
                    `Неверный ID. Введите "!help clearbans" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        } else {
            room.sendAnnouncement(
                `Неверное количество аргументов. Введите "!help clearbans" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    function banListCommand(player, message) {
        if (state.banList.length == 0) {
            room.sendAnnouncement(
                "📢 В списке банов никого нет.",
                player.id,
                announcementColor,
                'bold',
                null
            );
            return false;
        }
        let cstm = '📢 Список банов : ';
        for (let ban of state.banList) {
            cstm += ban[0] + `[${ban[1]}], `;
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

    function adminListCommand(player, message) {
        if (state.adminList.length == 0) {
            room.sendAnnouncement(
                "📢 В списке администраторов никого нет.",
                player.id,
                announcementColor,
                'bold',
                null
            );
            return false;
        }
        let cstm = '📢 Список администраторов : ';
        for (let i = 0; i < state.adminList.length; i++) {
            cstm += state.adminList[i][1] + `[${i}], `;
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

    async function setAdminCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray[0].length > 0 && msgArray[0][0] == '#') {
                msgArray[0] = msgArray[0].substring(1, msgArray[0].length);
                if (room.getPlayer(parseInt(msgArray[0])) != null) {
                    const playerAdmin = room.getPlayer(parseInt(msgArray[0]));

                    if (!state.adminList.map((a) => a[0]).includes(authArray[playerAdmin.id][0])) {
                        if (!masterList.includes(authArray[playerAdmin.id][0])) {
                            room.setPlayerAdmin(playerAdmin.id, true);
                            state.adminList.push([authArray[playerAdmin.id][0], playerAdmin.name]);
                            await db.addAdmin(authArray[playerAdmin.id][0], playerAdmin.name);
                            room.sendAnnouncement(
                                `${playerAdmin.name} теперь администратор комнаты !`,
                                null,
                                announcementColor,
                                'bold',
                                HaxNotification.CHAT
                            );
                        } else {
                            room.sendAnnouncement(
                                `Этот игрок уже является владельцем !`,
                                player.id,
                                errorColor,
                                'bold',
                                HaxNotification.CHAT
                            );
                        }
                    } else {
                        room.sendAnnouncement(
                            `Этот игрок уже является постоянным администратором !`,
                            player.id,
                            errorColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    }
                } else {
                    room.sendAnnouncement(
                        `Такого игрока нет в комнате. Введите "!help setadmin" для получения информации.`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
            } else {
                room.sendAnnouncement(
                    `Неверный формат вашего аргумента. Введите "!help setadmin" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        } else {
            room.sendAnnouncement(
                `Неверное количество аргументов. Введите "!help setadmin" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    async function removeAdminCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray[0].length > 0 && msgArray[0][0] == '#') {
                msgArray[0] = msgArray[0].substring(1, msgArray[0].length);
                if (room.getPlayer(parseInt(msgArray[0])) != null) {
                    const playerAdmin = room.getPlayer(parseInt(msgArray[0]));

                    if (state.adminList.map((a) => a[0]).includes(authArray[playerAdmin.id][0])) {
                        room.setPlayerAdmin(playerAdmin.id, false);
                        state.adminList = state.adminList.filter((a) => a[0] != authArray[playerAdmin.id][0]);
                        await db.removeAdmin(authArray[playerAdmin.id][0]);
                        room.sendAnnouncement(
                            `${playerAdmin.name} больше не администратор комнаты !`,
                            null,
                            announcementColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    } else {
                        room.sendAnnouncement(
                            `Этот игрок не является постоянным администратором !`,
                            player.id,
                            errorColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    }
                } else {
                    room.sendAnnouncement(
                        `Такого игрока нет в комнате. Введите "!help removeadmin" для получения информации.`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
            } else if (msgArray[0].length > 0 && parseInt(msgArray[0]) < state.adminList.length) {
                const index = parseInt(msgArray[0]);
                const playerAdmin = state.adminList[index];
                if (state.playersAll.findIndex((p) => authArray[p.id][0] == playerAdmin[0]) != -1) {
                    // check if there is the removed admin in the room
                    const indexRem = state.playersAll.findIndex((p) => authArray[p.id][0] == playerAdmin[0]);
                    room.setPlayerAdmin(state.playersAll[indexRem].id, false);
                }
                state.adminList.splice(index);
                await db.removeAdmin(playerAdmin[0]);
                room.sendAnnouncement(
                    `${playerAdmin[1]} больше не администратор комнаты !`,
                    null,
                    announcementColor,
                    'bold',
                    HaxNotification.CHAT
                );
            } else {
                room.sendAnnouncement(
                    `Неверный формат вашего аргумента. Введите "!help removeadmin" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        } else {
            room.sendAnnouncement(
                `Неверное количество аргументов. Введите "!help removeadmin" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // VIP grants no permissions (no command role check treats it specially) —
    // it's purely a chat-prefix perk, so unlike setAdminCommand there's no
    // room admin badge to grant and no need to exclude masters/admins.
    async function setVipCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray[0].length > 0 && msgArray[0][0] == '#') {
                msgArray[0] = msgArray[0].substring(1, msgArray[0].length);
                if (room.getPlayer(parseInt(msgArray[0])) != null) {
                    const playerVip = room.getPlayer(parseInt(msgArray[0]));

                    if (!state.vipList.map((v) => v[0]).includes(authArray[playerVip.id][0])) {
                        state.vipList.push([authArray[playerVip.id][0], playerVip.name]);
                        await db.addVip(authArray[playerVip.id][0], playerVip.name);
                        room.sendAnnouncement(
                            `${playerVip.name} теперь VIP !`,
                            null,
                            announcementColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    } else {
                        room.sendAnnouncement(
                            `Этот игрок уже является VIP !`,
                            player.id,
                            errorColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    }
                } else {
                    room.sendAnnouncement(
                        `Такого игрока нет в комнате. Введите "!help setvip" для получения информации.`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
            } else {
                room.sendAnnouncement(
                    `Неверный формат вашего аргумента. Введите "!help setvip" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        } else {
            room.sendAnnouncement(
                `Неверное количество аргументов. Введите "!help setvip" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    async function removeVipCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray[0].length > 0 && msgArray[0][0] == '#') {
                msgArray[0] = msgArray[0].substring(1, msgArray[0].length);
                if (room.getPlayer(parseInt(msgArray[0])) != null) {
                    const playerVip = room.getPlayer(parseInt(msgArray[0]));

                    if (state.vipList.map((v) => v[0]).includes(authArray[playerVip.id][0])) {
                        state.vipList = state.vipList.filter((v) => v[0] != authArray[playerVip.id][0]);
                        await db.removeVip(authArray[playerVip.id][0]);
                        room.sendAnnouncement(
                            `${playerVip.name} больше не VIP !`,
                            null,
                            announcementColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    } else {
                        room.sendAnnouncement(
                            `Этот игрок не является VIP !`,
                            player.id,
                            errorColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    }
                } else {
                    room.sendAnnouncement(
                        `Такого игрока нет в комнате. Введите "!help removevip" для получения информации.`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
            } else if (msgArray[0].length > 0 && parseInt(msgArray[0]) < state.vipList.length) {
                const index = parseInt(msgArray[0]);
                const playerVip = state.vipList[index];
                state.vipList.splice(index, 1);
                await db.removeVip(playerVip[0]);
                room.sendAnnouncement(
                    `${playerVip[1]} больше не VIP !`,
                    null,
                    announcementColor,
                    'bold',
                    HaxNotification.CHAT
                );
            } else {
                room.sendAnnouncement(
                    `Неверный формат вашего аргумента. Введите "!help removevip" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        } else {
            room.sendAnnouncement(
                `Неверное количество аргументов. Введите "!help removevip" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    function vipListCommand(player, message) {
        if (state.vipList.length == 0) {
            room.sendAnnouncement(
                "📢 В списке VIP никого нет.",
                player.id,
                announcementColor,
                'bold',
                null
            );
            return false;
        }
        let cstm = '📢 Список VIP : ';
        for (let i = 0; i < state.vipList.length; i++) {
            cstm += state.vipList[i][1] + `[${i}], `;
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

    // Bans by auth, not by HaxBall's native connection-based ban — works on a
    // player who isn't in the room right now, and survives them reconnecting
    // with a fresh connection under the same auth (see db.getAuthBan(), checked
    // in room.onPlayerJoin).
    async function banAuthCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = msgArray[0];
        if (!auth) {
            room.sendAnnouncement(
                `Неверный auth. Введите "!help banauth" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const reason = msgArray.slice(1).join(' ');
        const targetIndex = state.playersAll.findIndex((p) => authArray[p.id][0] == auth);
        const targetName = targetIndex != -1 ? state.playersAll[targetIndex].name : auth;
        await db.banAuth(auth, targetName, reason);
        if (targetIndex != -1) {
            room.kickPlayer(state.playersAll[targetIndex].id, reason ? `Вы забанены: ${reason}` : 'Вы забанены.', false);
        }
        room.sendAnnouncement(
            `✔️ ${targetName} забанен по auth !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function unbanAuthCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = msgArray[0];
        if (!auth) {
            room.sendAnnouncement(
                `Неверный auth. Введите "!help unbanauth" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const existing = await db.getAuthBan(auth);
        if (!existing) {
            room.sendAnnouncement(
                `Этот auth не забанен !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        await db.unbanAuth(auth);
        room.sendAnnouncement(
            `✔️ ${existing.playerName} разбанен по auth !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function authBanListCommand(player, message) {
        const bans = await db.getAuthBans();
        if (bans.length == 0) {
            room.sendAnnouncement(
                "📢 В списке банов по auth никого нет.",
                player.id,
                announcementColor,
                'bold',
                null
            );
            return false;
        }
        let cstm = '📢 Список банов по auth : ';
        for (let ban of bans) {
            cstm += `${ban.playerName} [${ban.auth}]${ban.reason ? ' (' + ban.reason + ')' : ''}, `;
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

    // Lists everyone currently in the room with their auth, so a master can
    // pick one to pass to !banauth (including from Discord, via !players there).
    function playersListCommand(player, message) {
        if (state.playersAll.length == 0) {
            room.sendAnnouncement(
                "📢 В комнате никого нет.",
                player.id,
                announcementColor,
                'bold',
                null
            );
            return false;
        }
        let cstm = '📢 Игроки в комнате : ';
        for (let p of state.playersAll) {
            cstm += `${p.name} [${authArray[p.id][0]}], `;
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

    function passwordCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray.length == 1 && msgArray[0] == '') {
                state.roomPassword = '';
                room.setPassword(null);
                room.sendAnnouncement(
                    `Пароль комнаты был удален.`,
                    player.id,
                    announcementColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            state.roomPassword = msgArray.join(' ');
            room.setPassword(state.roomPassword);
            room.sendAnnouncement(
                `Пароль комнаты был установлен на ${state.roomPassword}`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
        } else {
            if (state.roomPassword != '') {
                state.roomPassword = '';
                room.setPassword(null);
                room.sendAnnouncement(
                    `Пароль комнаты был удален.`,
                    player.id,
                    announcementColor,
                    'bold',
                    HaxNotification.CHAT
                );
            } else {
                room.sendAnnouncement(
                    `Комната в данный момент не имеет пароля. Введите "!help password" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        }
    }

    return {
        clearbansCommand,
        banListCommand,
        adminListCommand,
        setAdminCommand,
        removeAdminCommand,
        setVipCommand,
        removeVipCommand,
        vipListCommand,
        banAuthCommand,
        unbanAuthCommand,
        authBanListCommand,
        playersListCommand,
        passwordCommand,
    };
};
