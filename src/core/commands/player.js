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
    State,
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
    silencedAuths,
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
    printAllRankings,
    printClubRankings,
    updateTeams,
    getCommands,
    formatCoins,
    discordBot,
    formatBanRemaining,
}) {
    // One-time reward for linking a Discord account — only paid out on a
    // genuine first link (see db.linkDiscordId's isNewLink), so relinking
    // to fix a typo doesn't farm coins.
    const DISCORD_LINK_BONUS_COINS = 100;

    // !report — per-player cooldown so one player can't spam-ping admins.
    // A plain Set is safe to hold via closure here (unlike `state`'s
    // bindings): it's created once and only ever mutated, never reassigned.
    const REPORT_COOLDOWN_MS = 60 * 1000;
    const reportCooldownSet = new Set();

    // !up — per-player cooldown so the same VIP can't camp the front of the
    // captain queue every round. The "only one live claim at a time" part
    // is separately enforced via state.priorityCaptainId itself (a single
    // slot — see team/choosing.js's resolveNextCaptainId).
    const UP_COOLDOWN_MS = 30 * 60 * 1000;
    const upCooldownSet = new Set();
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
        const statsString = await printPlayerStats(stats);
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

    // Toggles whether THIS player sees other club members' custom chat
    // colors (see commands/club.js's !club color) — the club prefix TEXT
    // still shows either way, only the color falls back to default for
    // whoever has opted out. Purely a viewer-side preference: it has no
    // effect on what anyone else sees, including the toggling player's own
    // messages as seen by others.
    async function customColorsCommand(player, message) {
        const auth = authArray[player.id][0];
        const hidden = state.hiddenCustomColorsSet.has(auth);
        if (hidden) {
            state.hiddenCustomColorsSet.delete(auth);
            await db.setHideCustomColors(auth, false);
            room.sendAnnouncement(
                `✔️ Кастомные цвета клубов снова отображаются для вас в чате !`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        } else {
            state.hiddenCustomColorsSet.add(auth);
            await db.setHideCustomColors(auth, true);
            room.sendAnnouncement(
                `✔️ Кастомные цвета клубов больше не отображаются для вас в чате !`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // Role-gated to Role.VIP in commands.js — trusts the dispatcher, same as
    // every other role-gated command here, so this never re-checks the role
    // itself. Overrides the shared vipChatColor (see constants.js) with a
    // color this VIP picked for themselves; no argument clears it back to
    // the shared default. Unlike !customcolors, this isn't a per-viewer
    // preference — everyone sees the same color for this VIP's messages.
    async function vipColorCommand(player, message) {
        const auth = authArray[player.id][0];
        const hex = message.split(/ +/)[1];
        if (!hex) {
            await db.setVipColor(auth, null);
            delete state.vipColors[auth];
            room.sendAnnouncement(`✔️ Ваш VIP-цвет сброшен на стандартный !`, player.id, successColor, 'bold', HaxNotification.CHAT);
            return;
        }
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {
            room.sendAnnouncement(
                `Использование: !vipcolor <hex>. Введите "!vipcolor" без аргумента, чтобы сбросить цвет. Пример: !vipcolor ff8800.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const color = parseInt(hex, 16);
        await db.setVipColor(auth, color);
        state.vipColors[auth] = color;
        room.sendAnnouncement(`✔️ Ваш VIP-цвет обновлен !`, player.id, successColor, 'bold', HaxNotification.CHAT);
    }

    function vipHelpCommand(player, message) {
        const text = [
            '⭐ Команды VIP:',
            '!vipcolor <hex> — изменить цвет вашего VIP-префикса в чате, или без аргумента чтобы сбросить на стандартный. Пример: !vipcolor ff8800.',
            '!viphelp — эта команда.',
            '',
            '⭐ Также, пока у вас есть VIP: анимации "Дым", "Фейерверк" и "Черная дыра" после гола доступны бесплатно — просто наденьте их через "!equip smoke-<цвет>", "!equip fireworks" или "!equip blackhole", без покупки.',
        ].join('\n');
        room.sendAnnouncement(text, player.id, announcementColor, 'bold', HaxNotification.CHAT);
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
        const auth = authArray[player.id][0];
        const isNewLink = await db.linkDiscordId(auth, discordId);
        room.sendAnnouncement(
            `Ваш аккаунт Discord был связан ! Теперь вы можете использовать "!stats" в Discord, не вводя свое имя.`,
            player.id,
            successColor,
            'bold',
            HaxNotification.CHAT
        );
        // Catches a VIP role already sitting on this Discord account from
        // BEFORE it was ever linked (a giveaway, a boost, a manual grant —
        // whatever) — the live guildMemberUpdate edge that would normally
        // catch a role grant already fired and was silently dropped at that
        // point, since there was no linked auth yet to grant it to (see
        // discord.js's handleGuildMemberUpdate/checkVipRoleOnLink). Safe to
        // call every link, not just a first-time one — grantVipByAuth is
        // already a no-op for someone who's not VIP-eligible or already VIP.
        discordBot.checkVipRoleOnLink(discordId, auth, player.name);
        if (isNewLink) {
            await db.addCoins(auth, player.name, DISCORD_LINK_BONUS_COINS);
            const newBalance = await db.getBalance(auth);
            room.sendAnnouncement(
                `💰 Бонус за привязку Discord: +${formatCoins(DISCORD_LINK_BONUS_COINS)} ! Баланс: ${formatCoins(newBalance)}`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // !tops [stat] — every leaderboard (!goals/!wins/etc.) used to be its
    // own top-level command; now they're all just arguments to this one.
    // No argument shows every category in one message (see
    // stats/roomStats.js's printAllRankings), skipping any that don't have
    // the 5-player quorum yet rather than erroring.
    const TOPS_STAT_KEYS = ['games', 'wins', 'goals', 'assists', 'cs', 'playtime', 'pt', 'clubs'];
    async function topsCommand(player, message) {
        const key = message.split(/ +/)[1]?.toLowerCase();
        if (!key) {
            await printAllRankings(player.id);
            return;
        }
        if (!TOPS_STAT_KEYS.includes(key)) {
            room.sendAnnouncement(
                `Использование: !tops [games|wins|goals|assists|cs|playtime|clubs]. Без аргумента показывает все таблицы лидеров сразу.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (key === 'clubs') {
            await printClubRankings(player.id);
            return;
        }
        await printRankings(key == 'pt' ? 'playtime' : key, player.id);
    }

    function afkCommand(player, message) {
        // Also allowed for a player still nominally on RED/BLUE from the
        // just-finished match during the between-rounds pause (State.STOP)
        // before the next random reshuffle — lets them bench themselves for
        // the upcoming round instead of getting swept back onto a team.
        // Excludes an active captain draft (state.chooseMode): dodging into
        // AFK mid-pick would leave a captain's selection in a half-built
        // state.
        const betweenRandomRounds = state.gameState == State.STOP && !state.chooseMode;
        if (player.team == Team.SPECTATORS || state.players.length == 1 || betweenRandomRounds) {
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
                    AFKSet.set(player.id, Date.now());
                    // Admins are fully exempt from all three timers on
                    // purpose — including the max-duration auto-return: an
                    // admin AFK is meant to be indefinite, not just exempt
                    // from the min/cooldown abuse limits.
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
                                // Guards against double-handling: the player
                                // may have already toggled AFK off themselves
                                // (!afk) before this fires — that path has
                                // already announced/rebalanced, nothing to
                                // redo here.
                                if (!AFKSet.has(id)) return;
                                AFKSet.delete(id);
                                const p = room.getPlayer(id);
                                if (p != null) {
                                    room.sendAnnouncement(
                                        `😴 ${p.name} вышел из AFK !`,
                                        null,
                                        announcementColor,
                                        'bold',
                                        null
                                    );
                                    room.sendAnnouncement(
                                        `Вы слишком долго находились в AFK.`,
                                        id,
                                        errorColor,
                                        'bold',
                                        HaxNotification.CHAT
                                    );
                                }
                                updateTeams();
                                handlePlayersJoin();
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
                    // Only a REAL move (the state.players.length==1 edge case
                    // above, someone going AFK straight off a team) — the
                    // far more common path (player.team already SPECTATORS)
                    // would make this a no-op reassignment, but
                    // room.setPlayerTeam still fires room.onPlayerTeamChange
                    // regardless of whether the team actually changed. If
                    // chooseMode happened to be active (building the next
                    // match's roster right after this one ended), that
                    // spurious event cascaded into handlePlayersTeamChange
                    // and could trigger an UNRELATED auto-pick of its own —
                    // stacking with the explicit handlePlayersLeave() call
                    // just below (which reacts to this same AFK event
                    // properly) to double-process a single AFK toggle as two
                    // separate roster changes. Symptoms: an extra spectator
                    // silently pulled onto a side mid-pick ("2 captains"
                    // landing on blue when only one pick happened), or a
                    // pick sequence left in a state where blue stayed empty.
                    if (player.team != Team.SPECTATORS) {
                        room.setPlayerTeam(player.id, Team.SPECTATORS);
                    }
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
        AFKSet.forEach((afkSince, id) => {
            const p = room.getPlayer(id);
            if (p != null) {
                const minutesAfk = Math.floor((Date.now() - afkSince) / 60000);
                cstm += `${p.name} (${minutesAfk} мин.), `;
            }
        });
        cstm = cstm.substring(0, cstm.length - 2) + '.';
        room.sendAnnouncement(cstm, player.id, announcementColor, 'bold', null);
    }

    // Toggles, for the CALLER only, whether they see chat messages from the
    // target — see events/activity.js's onPlayerChat, which skips delivery
    // to any viewer whose silencedAuths set contains the speaker's auth.
    // Nobody else's view changes, unlike !mute (commands/admin.js), which
    // blocks the message for everyone. Admins/moderators are exempt so a
    // player can't silence their way out of a moderation call made in chat.
    function silenceCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        if (msgArray.length == 0 || msgArray[0][0] != '#' || room.getPlayer(parseInt(msgArray[0].substring(1))) == null) {
            room.sendAnnouncement(
                `Использование: !silence #<id>. Введите "!help silence" для получения информации.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const target = room.getPlayer(parseInt(msgArray[0].substring(1)));
        if (target.id == player.id) {
            room.sendAnnouncement(
                `Вы не можете заглушить самого себя !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (getRole(target) >= Role.ADMIN_TEMP) {
            room.sendAnnouncement(
                `Вы не можете заглушить администратора или модератора !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        const viewerAuth = authArray[player.id][0];
        const targetAuth = authArray[target.id][0];
        let silenced = silencedAuths.get(viewerAuth);
        if (silenced && silenced.has(targetAuth)) {
            silenced.delete(targetAuth);
            room.sendAnnouncement(
                `✔️ ${target.name} больше не заглушен для вас !`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        } else {
            if (!silenced) {
                silenced = new Set();
                silencedAuths.set(viewerAuth, silenced);
            }
            silenced.add(targetAuth);
            room.sendAnnouncement(
                `🔇 ${target.name} теперь заглушен только для вас ! Введите "!silence #${target.id}" еще раз, чтобы отменить.`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }

    // Calls admins into the room — announces to everyone (HaxNotification.
    // MENTION, same attention-grabbing level !votepause/!voteban use) and
    // pings @here in a dedicated Discord channel via discordBot.sendAdminCall.
    async function reportCommand(player, message) {
        const restriction = await db.getCommandRestriction(authArray[player.id][0], 'report');
        if (restriction) {
            room.sendAnnouncement(
                `Вам запрещено использовать !report (осталось: ${formatBanRemaining(restriction.expiresAt)})${restriction.reason ? ' : ' + restriction.reason : ''}.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (reportCooldownSet.has(player.id)) {
            room.sendAnnouncement(
                `Команду !report можно использовать раз в минуту. Подождите немного.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        reportCooldownSet.add(player.id);
        setTimeout(() => reportCooldownSet.delete(player.id), REPORT_COOLDOWN_MS);
        room.sendAnnouncement(
            `🚨 ${player.name} позвал(а) администрацию !`,
            null,
            errorColor,
            'bold',
            HaxNotification.MENTION
        );
        discordBot.sendAdminCall(player.name);
    }

    // !up (Role.VIP) — claims priority to become the NEXT captain chosen,
    // jumping ahead of whoever's simply first in the spectator queue (see
    // team/choosing.js's resolveNextCaptainId, which both choosePlayer()
    // and team/balance.js's handlePlayersLeave() call whenever an empty
    // side needs a captain). Not available while captains are actively
    // mid-pick (state.chooseMode) — by the time this fires, both captain
    // slots are already filled, there's nothing left to jump ahead of.
    function upCommand(player, message) {
        if (state.chooseMode) {
            room.sendAnnouncement(
                `Нельзя использовать !up, пока капитаны выбирают игроков !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (player.team !== Team.SPECTATORS) {
            room.sendAnnouncement(
                `!up доступен только зрителям !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        // A stale claim (the holder left the spectator pool since claiming
        // — disconnected, or otherwise ended up on a team some other way)
        // frees the slot instead of blocking every other VIP forever.
        if (state.priorityCaptainId != null && !state.teamSpec.some((p) => p.id === state.priorityCaptainId)) {
            state.priorityCaptainId = null;
        }
        if (state.priorityCaptainId != null) {
            room.sendAnnouncement(
                `Уже есть VIP в очереди на капитанство — дождитесь следующей итерации !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        if (upCooldownSet.has(player.id)) {
            room.sendAnnouncement(
                `Команду !up можно использовать раз в 30 минут !`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        state.priorityCaptainId = player.id;
        upCooldownSet.add(player.id);
        setTimeout(() => upCooldownSet.delete(player.id), UP_COOLDOWN_MS);
        room.sendAnnouncement(
            `⭐ ${player.name} станет капитаном при следующем формировании команд !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    return {
        leaveCommand,
        helpCommand,
        globalStatsCommand,
        renameCommand,
        customColorsCommand,
        vipColorCommand,
        vipHelpCommand,
        linkDiscordCommand,
        topsCommand,
        afkCommand,
        afkListCommand,
        silenceCommand,
        reportCommand,
        upCommand,
    };
};
