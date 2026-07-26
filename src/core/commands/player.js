/*
 * Player-facing commands: help, stats, rename, AFK handling and leaving.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createPlayerCommands({
    room,
    state,
    Team,
    Role,
    HaxStatistics,
    authArray,
    db,
    AFKSet,
    AFKMinSet,
    AFKCooldownSet,
    minAFKDuration,
    maxAFKDuration,
    AFKCooldown,
    announcementColor,
    errorColor,
    infoColor,
    successColor,
    HaxNotification,
    getCommand,
    getRole,
    handlePlayersJoin,
    handlePlayersLeave,
    printPlayerStats,
    printRankings,
    updateTeams,
    getCommands,
}) {
    function leaveCommand(player, message) {
        room.kickPlayer(player.id, 'Пока !', false);
    }

    function helpCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length == 0) {
            let commandString = 'Доступные команды игрока :';
            for (const [key, value] of Object.entries(getCommands())) {
                if (value.desc && value.roles == Role.PLAYER) commandString += ` !${key},`;
            }
            commandString = commandString.substring(0, commandString.length - 1) + '.\n';
            if (getRole(player) >= Role.VIP) {
                commandString += `Доступные команды VIP :`;
                for (const [key, value] of Object.entries(getCommands())) {
                    if (value.desc && value.roles == Role.VIP) commandString += ` !${key},`;
                }
                if (commandString.slice(commandString.length - 1) == ':')
                    commandString += ` None,`;
                commandString = commandString.substring(0, commandString.length - 1) + '.\n';
            }
            if (getRole(player) >= Role.ADMIN_TEMP) {
                commandString += `Доступные команды администратора :`;
                for (const [key, value] of Object.entries(getCommands())) {
                    if (value.desc && value.roles == Role.ADMIN_TEMP) commandString += ` !${key},`;
                }
                if (commandString.slice(commandString.length - 1) == ':')
                    commandString += ` None,`;
                commandString = commandString.substring(0, commandString.length - 1) + '.\n';
            }
            if (getRole(player) >= Role.MASTER) {
                commandString += `Доступные команды владельца :`;
                for (const [key, value] of Object.entries(getCommands())) {
                    if (value.desc && value.roles == Role.MASTER) commandString += ` !${key},`;
                }
                if (commandString.slice(commandString.length - 1) == ':') commandString += ` None,`;
                commandString = commandString.substring(0, commandString.length - 1) + '.\n';
            }
            commandString += "\nДля получения информации о конкретной команде, введите '!help <имя команды>'.";
            room.sendAnnouncement(
                commandString,
                player.id,
                infoColor,
                'bold',
                HaxNotification.CHAT
            );
        } else if (msgArray.length >= 1) {
            const commandName = getCommand(msgArray[0].toLowerCase());
            if (commandName != false && getCommands()[commandName].desc != false)
                room.sendAnnouncement(
                    `\'${commandName}\' команда :\n${getCommands()[commandName].desc}`,
                    player.id,
                    infoColor,
                    'bold',
                    HaxNotification.CHAT
                );
            else
                room.sendAnnouncement(
                    `Команда, которую вы пытались получить информацию, не существует. Чтобы проверить все доступные команды, введите '!help'`,
                    player.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
        }
    }

    async function globalStatsCommand(player, message) {
        const stats = (await db.getPlayerStats(authArray[player.id][0])) ?? new HaxStatistics(player.name);
        const statsString = printPlayerStats(stats);
        room.sendAnnouncement(
            statsString,
            player.id,
            infoColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function renameCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = authArray[player.id][0];
        const stats = await db.getPlayerStats(auth);
        if (stats) {
            stats.playerName = msgArray.length == 0 ? player.name : msgArray.join(' ');
            await db.savePlayerStats(auth, stats);
            room.sendAnnouncement(
                `Вы успешно переименовали себя на ${stats.playerName} !`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        } else {
            room.sendAnnouncement(
                `Вы еще не играли в этой комнате !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    async function linkDiscordCommand(player, message) {
        const discordId = message.split(/ +/)[1];
        if (!discordId || !/^\d{15,20}$/.test(discordId)) {
            room.sendAnnouncement(
                `Неверный ID Discord. Введите "!help discord" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        await db.linkDiscordId(authArray[player.id][0], discordId);
        room.sendAnnouncement(
            `Ваш аккаунт Discord был связан ! Теперь вы можете использовать "!stats" в Discord, не вводя свое имя.`,
            player.id,
            successColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function statsLeaderboardCommand(player, message) {
        const key = message.split(/ +/)[0].substring(1).toLowerCase();
        await printRankings(key, player.id);
    }

    function afkCommand(player, message) {
        if (player.team == Team.SPECTATORS || state.players.length == 1) {
            if (AFKSet.has(player.id)) {
                if (AFKMinSet.has(player.id)) {
                    room.sendAnnouncement(
                        `Минимальное время AFK: ${minAFKDuration} минут. Не злоупотребляйте командой !`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else {
                    AFKSet.delete(player.id);
                    room.sendAnnouncement(
                        `🌅 ${player.name} больше не AFK !`,
                        null,
                        announcementColor,
                        'bold',
                        null
                    );
                    updateTeams();
                    handlePlayersJoin();
                }
            } else {
                if (AFKCooldownSet.has(player.id)) {
                    room.sendAnnouncement(
                        `Вы можете становиться AFK только каждые ${AFKCooldown} минут. Не злоупотребляйте командой !`,
                        player.id,
                        errorColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else {
                    AFKSet.add(player.id);
                    if (!player.admin) {
                        AFKMinSet.add(player.id);
                        AFKCooldownSet.add(player.id);
                        setTimeout(
                            (id) => {
                                AFKMinSet.delete(id);
                            },
                            minAFKDuration * 60 * 1000,
                            player.id
                        );
                        setTimeout(
                            (id) => {
                                AFKSet.delete(id);
                            },
                            maxAFKDuration * 60 * 1000,
                            player.id
                        );
                        setTimeout(
                            (id) => {
                                AFKCooldownSet.delete(id);
                            },
                            AFKCooldown * 60 * 1000,
                            player.id
                        );
                    }
                    room.setPlayerTeam(player.id, Team.SPECTATORS);
                    room.sendAnnouncement(
                        `😴 ${player.name} теперь AFK !`,
                        null,
                        announcementColor,
                        'bold',
                        null
                    );
                    updateTeams();
                    handlePlayersLeave();
                }
            }
        } else {
            room.sendAnnouncement(
                `Вы не можете стать AFK, пока находитесь в команде !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    function afkListCommand(player, message) {
        if (AFKSet.size == 0) {
            room.sendAnnouncement(
                "😴 В списке AFK никого нет.",
                player.id,
                announcementColor,
                'bold',
                null
            );
            return;
        }
        let cstm = '😴 AFK лист : ';
        AFKSet.forEach((_, value) => {
            const p = room.getPlayer(value);
            if (p != null) cstm += p.name + `, `;
        });
        cstm = cstm.substring(0, cstm.length - 2) + '.';
        room.sendAnnouncement(cstm, player.id, announcementColor, 'bold', null);
    }

    return {
        leaveCommand,
        helpCommand,
        globalStatsCommand,
        renameCommand,
        linkDiscordCommand,
        statsLeaderboardCommand,
        afkCommand,
        afkListCommand,
    };
};
