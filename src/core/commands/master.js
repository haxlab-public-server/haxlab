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
    formatBanRemaining,
    formatVipRemaining,
    discordBot,
}) {
    // A grant past its expiry is functionally identical to never having
    // been VIP at all — purged from both the cache and the db the moment
    // any VIP command notices it, same "delete rather than just filter"
    // reasoning as auth_bans (see getAuthBans). Called at the top of every
    // VIP command AND on a timer (see entry.js) — the timer is what makes
    // the Discord role actually get revoked promptly on expiry, rather than
    // only whenever someone next happens to run a VIP command.
    async function purgeExpiredVips() {
        const now = Date.now();
        const isExpired = (v) => v[2] != null && new Date(v[2]).getTime() <= now;
        const expired = state.vipList.filter(isExpired);
        if (expired.length === 0) return;
        state.vipList = state.vipList.filter((v) => !isExpired(v));
        await Promise.all(expired.map((v) => db.removeVip(v[0])));
        for (const v of expired) discordBot.revokeVipRole(v[0]);
    }

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
    // Target accepts #<id> (someone currently in the room) or a raw auth
    // string directly — works even if they're offline right now, same as
    // !banauth. Duration (in days) is optional — omitted means a permanent
    // grant, same as before that existed.
    async function setVipCommand(player, message) {
        await purgeExpiredVips();
        const msgArray = message.split(/ +/).slice(1);
        const target = msgArray[0];
        const usage = () => room.sendAnnouncement(
            `Использование: !setvip <#id|auth> [дни]. Введите "!help setvip" для получения информации.`,
            player.id,
            errorColor,
            'bold',
            HaxNotification.CHAT
        );
        if (!target) {
            usage();
            return;
        }

        let auth, targetName;
        if (target[0] == '#') {
            const id = parseInt(target.substring(1));
            const targetPlayer = state.playersAll.find((p) => p.id == id);
            if (!targetPlayer) {
                room.sendAnnouncement(
                    `Такого игрока нет в комнате. Введите "!help setvip" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
                return;
            }
            auth = authArray[targetPlayer.id][0];
            targetName = targetPlayer.name;
        } else {
            auth = target;
            const targetPlayer = state.playersAll.find((p) => authArray[p.id][0] == auth);
            targetName = targetPlayer ? targetPlayer.name : auth;
        }

        if (state.vipList.map((v) => v[0]).includes(auth)) {
            room.sendAnnouncement(
                `Этот игрок уже является VIP !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        let days = null;
        if (msgArray[1] !== undefined) {
            days = parseInt(msgArray[1]);
            if (!(days > 0)) {
                usage();
                return;
            }
        }
        const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60000).toISOString() : null;
        await applyVipGrant(auth, targetName, expiresAt);
        room.sendAnnouncement(
            `${targetName} теперь VIP ${days ? `на ${days} дн.` : 'навсегда'} !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    // Writes a VIP grant to both the live cache and the db — pulled out of
    // setVipCommand so every other grant path (grantVipByAuth below for the
    // Discord role sync, and stats/roomStats.js's 4v4-win VIP lottery) can
    // share the exact same "cache + persist" pair instead of duplicating it.
    // Assumes the caller already confirmed `auth` isn't VIP yet (each
    // caller does its own check first, in its own way).
    //
    // Also grants the configured Discord VIP role, if this auth has one
    // linked — including when the grant itself CAME from that role in the
    // first place (grantVipByAuth): safe, not a loop, since
    // grantVipRoleOnGuild (discord.js) skips a member who already has it,
    // and even if it didn't, a redundant role-add never crosses
    // handleGuildMemberUpdate's false->true edge a second time.
    async function applyVipGrant(auth, targetName, expiresAt) {
        state.vipList.push([auth, targetName, expiresAt]);
        await db.addVip(auth, targetName, expiresAt);
        discordBot.grantVipRole(auth);
    }

    // Called from the Discord bridge (see entry.js's
    // window.__roomBridge.grantVipByAuth, wired from discord.js's
    // guildMemberUpdate handler) whenever a member is given the configured
    // VIP role on the Discord server — grants the HaxBall auth linked to
    // that Discord account (via !discord, see commands/player.js)
    // permanent room VIP, live in state.vipList immediately rather than
    // only on the next restart. A no-op if that auth is already VIP, same
    // de-dupe setVipCommand itself does. Always permanent (no `days`):
    // a Discord role carries no duration of its own, and removing the role
    // doesn't revoke it either — that stays a manual !removevip, same as
    // any other VIP grant.
    async function grantVipByAuth(auth, targetName) {
        await purgeExpiredVips();
        if (state.vipList.some((v) => v[0] === auth)) return false;
        await applyVipGrant(auth, targetName, null);
        room.sendAnnouncement(
            `${targetName} теперь VIP (получил роль VIP на Discord-сервере) !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        return true;
    }

    // Mirrors applyVipGrant: removes a VIP from both the live cache and the
    // db, and revokes the Discord role too (if this auth has one linked).
    // Assumes the caller already confirmed `auth` IS currently VIP.
    async function revokeVip(auth) {
        state.vipList = state.vipList.filter((v) => v[0] != auth);
        await db.removeVip(auth);
        discordBot.revokeVipRole(auth);
    }

    async function removeVipCommand(player, message) {
        await purgeExpiredVips();
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length > 0) {
            if (msgArray[0].length > 0 && msgArray[0][0] == '#') {
                msgArray[0] = msgArray[0].substring(1, msgArray[0].length);
                if (room.getPlayer(parseInt(msgArray[0])) != null) {
                    const playerVip = room.getPlayer(parseInt(msgArray[0]));

                    if (state.vipList.map((v) => v[0]).includes(authArray[playerVip.id][0])) {
                        await revokeVip(authArray[playerVip.id][0]);
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
            } else if (state.vipList.some((v) => v[0] == msgArray[0])) {
                // A raw auth, not currently online (an online target would
                // already be caught by the #<id> branch above) — the
                // counterpart to !setvip accepting one, so a VIP granted by
                // auth to someone who never actually joins isn't stuck
                // needing to be looked up by list index instead.
                const auth = msgArray[0];
                const playerVip = state.vipList.find((v) => v[0] == auth);
                const vipName = playerVip[1];
                await revokeVip(auth);
                room.sendAnnouncement(
                    `${vipName} больше не VIP !`,
                    null,
                    announcementColor,
                    'bold',
                    HaxNotification.CHAT
                );
            } else if (msgArray[0].length > 0 && parseInt(msgArray[0]) < state.vipList.length) {
                const index = parseInt(msgArray[0]);
                const playerVip = state.vipList[index];
                await revokeVip(playerVip[0]);
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

    async function vipListCommand(player, message) {
        await purgeExpiredVips();
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
            cstm += `${state.vipList[i][1]} (${formatVipRemaining(state.vipList[i][2])}) [${i}], `;
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
    // in room.onPlayerJoin). Shared by both !banauth (Role.MASTER, unchanged)
    // and !ban (Role.ADMIN_TEMP, new — see commands.js) — identical behavior,
    // just a lower role gate on the second entry point.
    //
    // Target accepts either #<id> (someone currently in the room, like
    // !mute/!kick) or a raw auth string (works even if they're offline right
    // now) — resolved the same way !mute resolves #<id> before this. Duration
    // is mandatory: there is no more "omit it for a permanent ban" — every
    // ban issued through here always has a real expiry.
    async function banAuthCommand(player, message) {
        // Read back from the message itself (rather than hardcoding one
        // name) since this same function serves both !banauth and !ban —
        // the usage hint should match whichever one the caller actually typed.
        const commandUsed = message.split(/ +/)[0];
        const msgArray = message.split(/ +/).slice(1);
        const target = msgArray[0];
        const usage = () => room.sendAnnouncement(
            `Использование: ${commandUsed} <#id|auth> <минуты> [причина]. Введите "!help ${commandUsed.slice(1)}" для получения информации.`,
            player.id,
            errorColor,
            'bold',
            HaxNotification.CHAT
        );
        if (!target) {
            usage();
            return;
        }

        let auth, targetIndex;
        if (target[0] == '#') {
            const id = parseInt(target.substring(1));
            targetIndex = state.playersAll.findIndex((p) => p.id == id);
            if (targetIndex == -1) {
                room.sendAnnouncement(
                    `Игрока с таким ID нет в комнате. Введите "!help ${commandUsed.slice(1)}" для получения информации.`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
                return;
            }
            auth = authArray[state.playersAll[targetIndex].id][0];
        } else {
            auth = target;
            targetIndex = state.playersAll.findIndex((p) => authArray[p.id][0] == auth);
        }

        const minutes = parseInt(msgArray[1]);
        if (!(minutes > 0)) {
            usage();
            return;
        }
        const reason = msgArray.slice(2).join(' ');
        const targetName = targetIndex != -1 ? state.playersAll[targetIndex].name : auth;
        await db.banAuth(auth, targetName, reason, minutes);
        if (targetIndex != -1) {
            room.kickPlayer(state.playersAll[targetIndex].id, reason ? `Вы забанены на ${minutes} мин.: ${reason}` : `Вы забанены на ${minutes} мин.`, false);
        }
        room.sendAnnouncement(
            `✔️ ${targetName} забанен по auth на ${minutes} мин. !`,
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
            cstm += `${ban.playerName} [${ban.auth}] — осталось ${formatBanRemaining(ban.expiresAt)}${ban.reason ? ' (' + ban.reason + ')' : ''}, `;
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

    // !restrictcmd/!unrestrictcmd/!cmdrestrictions — blocks a specific player
    // from using a specific self-service room command (!voteban/!report,
    // both prone to abuse without a moderation lever), for a set time or
    // permanently. Same #<id>|auth target resolution and by-auth storage as
    // !banauth/!ban above (works even if the target is offline right now,
    // survives their reconnect).
    const RESTRICTABLE_COMMANDS = ['voteban', 'report'];

    function resolveRestrictionTarget(target) {
        if (target[0] == '#') {
            const id = parseInt(target.substring(1));
            const targetIndex = state.playersAll.findIndex((p) => p.id == id);
            if (targetIndex == -1) return null;
            return { auth: authArray[state.playersAll[targetIndex].id][0], name: state.playersAll[targetIndex].name };
        }
        const targetIndex = state.playersAll.findIndex((p) => authArray[p.id][0] == target);
        return { auth: target, name: targetIndex != -1 ? state.playersAll[targetIndex].name : target };
    }

    async function restrictCmdCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const usage = () => room.sendAnnouncement(
            `Использование: !restrictcmd <#id|auth> <${RESTRICTABLE_COMMANDS.join('|')}> <минуты|0> [причина]. 0 минут = навсегда.`,
            player.id,
            errorColor,
            'bold',
            HaxNotification.CHAT
        );
        const target = msgArray[0];
        const command = msgArray[1]?.toLowerCase();
        if (!target || !RESTRICTABLE_COMMANDS.includes(command)) {
            usage();
            return;
        }
        const resolved = resolveRestrictionTarget(target);
        if (!resolved) {
            room.sendAnnouncement(`Игрока с таким ID нет в комнате.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const minutesArg = msgArray[2];
        const minutes = parseInt(minutesArg);
        if (minutesArg === undefined || isNaN(minutes) || minutes < 0) {
            usage();
            return;
        }
        const reason = msgArray.slice(3).join(' ');
        await db.restrictCommand(resolved.auth, command, resolved.name, reason, minutes);
        room.sendAnnouncement(
            `✔️ ${resolved.name} больше не может использовать !${command} (${minutes > 0 ? minutes + ' мин.' : 'навсегда'})${reason ? ' : ' + reason : ''} !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function unrestrictCmdCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const target = msgArray[0];
        const command = msgArray[1]?.toLowerCase();
        const usage = () => room.sendAnnouncement(
            `Использование: !unrestrictcmd <#id|auth> <${RESTRICTABLE_COMMANDS.join('|')}>.`,
            player.id,
            errorColor,
            'bold',
            HaxNotification.CHAT
        );
        if (!target || !RESTRICTABLE_COMMANDS.includes(command)) {
            usage();
            return;
        }
        const resolved = resolveRestrictionTarget(target);
        if (!resolved) {
            room.sendAnnouncement(`Игрока с таким ID нет в комнате.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const existing = await db.getCommandRestriction(resolved.auth, command);
        if (!existing) {
            room.sendAnnouncement(`${resolved.name} и так может использовать !${command} !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        await db.unrestrictCommand(resolved.auth, command);
        room.sendAnnouncement(
            `✔️ ${existing.playerName} снова может использовать !${command} !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function cmdRestrictionsCommand(player, message) {
        const restrictions = await db.getCommandRestrictions();
        if (restrictions.length == 0) {
            room.sendAnnouncement("📢 Ограничений на команды сейчас нет.", player.id, announcementColor, 'bold', null);
            return false;
        }
        let cstm = '📢 Ограничения на команды : ';
        for (let r of restrictions) {
            cstm += `${r.playerName} [${r.auth}] — !${r.command}, осталось ${formatBanRemaining(r.expiresAt)}${r.reason ? ' (' + r.reason + ')' : ''}, `;
        }
        cstm = cstm.substring(0, cstm.length - 2) + '.';
        room.sendAnnouncement(cstm, player.id, announcementColor, 'bold', null);
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
        grantVipByAuth,
        applyVipGrant,
        purgeExpiredVips,
        restrictCmdCommand,
        unrestrictCmdCommand,
        cmdRestrictionsCommand,
    };
};
