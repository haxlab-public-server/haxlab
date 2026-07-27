/*
 * room.onPlayerJoin/Leave/TeamChange/Kicked — keeps auth/team bookkeeping in sync.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createMovementEvents({
    room,
    state,
    authArray,
    db,
    AFKSet,
    HaxNotification,
    Role,
    State,
    Team,
    announcementColor,
    debugMode,
    disableBans,
    discordBot,
    errorColor,
    infoColor,
    masterList,
    maxPlayers,
    welcomeColor,
    getDate,
    applyTeamForms,
    checkCaptainLeave,
    checkOverflowPassword,
    getRole,
    ghostKickHandle,
    handleActivityPlayerTeamChange,
    handleLineupChangeLeave,
    handleLineupChangeTeamChange,
    handlePlayersJoin,
    handlePlayersLeave,
    handlePlayersTeamChange,
    updateTeams,
}) {
    async function onPlayerJoin(player) {
        authArray[player.id] = [player.auth, player.conn];

        // Auth-ban check: HaxBall's own ban (the client kick dialog's checkbox)
        // only blocks the connection that was live when it was issued — it can't
        // reach someone who reconnects later, or who was never online when the
        // ban was made. This is enforced here regardless, straight from the DB.
        const ban = await db.getAuthBan(player.auth);
        if (ban) {
            room.kickPlayer(player.id, ban.reason ? `Вы забанены: ${ban.reason}` : 'Вы забанены.', false);
            return;
        }

        discordBot.sendLog(
            `[${getDate()}] ➡️ JOIN (${state.playersAll.length + 1}/${maxPlayers})\n**` +
            `${player.name}** [${authArray[player.id][0]}] {${authArray[player.id][1]}}`
        );
        room.sendAnnouncement(
            `${player.name} [${player.auth}]`,
            null,
            infoColor,
            'small',
            null
        );
        room.sendAnnouncement(
            `👋 Добро пожаловать ${player.name} !\n Следите за новостями в Discord: dsc.gg/haxlab`,
            player.id,
            welcomeColor,
            'bold',
            HaxNotification.CHAT
        );
        updateTeams();
        discordBot.updateRoomStatus();
        checkOverflowPassword();
        if (masterList.findIndex((auth) => auth == player.auth) != -1) {
            room.sendAnnouncement(
                `Владелец ${player.name} присоединился к комнате !`,
                null,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            room.setPlayerAdmin(player.id, true);
        } else if (state.adminList.map((a) => a[0]).findIndex((auth) => auth == player.auth) != -1) {
            room.sendAnnouncement(
                `Админ ${player.name} присоединился к комнате !`,
                null,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            room.setPlayerAdmin(player.id, true);
        }
        const sameAuthCheck = state.playersAll.filter((p) => p.id != player.id && authArray[p.id][0] == player.auth);
        if (sameAuthCheck.length > 0 && !debugMode) {
            const oldPlayerArray = state.playersAll.filter((p) => p.id != player.id && authArray[p.id][0] == player.auth);
            for (let oldPlayer of oldPlayerArray) {
                ghostKickHandle(oldPlayer, player);
            }
        }
        handlePlayersJoin();
    }

    function onPlayerTeamChange(changedPlayer, byPlayer) {
        handleLineupChangeTeamChange(changedPlayer);
        if (AFKSet.has(changedPlayer.id) && changedPlayer.team != Team.SPECTATORS) {
            room.setPlayerTeam(changedPlayer.id, Team.SPECTATORS);
            room.sendAnnouncement(
                `🌅 ${changedPlayer.name} больше не AFK !`,
                null,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        updateTeams();
        // After updateTeams(), not before — applyTeamForms() reads
        // state.teamRed/teamBlue, which only reflect this team change once
        // updateTeams() has run. Runs regardless of direction (joining OR
        // leaving a team can change who's captain, or the random-fallback
        // pool, on either side).
        applyTeamForms().catch((err) => console.error('[economy] applyTeamForms failed:', err));
        if (state.gameState != State.STOP) {
            if (changedPlayer.team != Team.SPECTATORS && state.game.scores.time <= (3 / 4) * state.game.scores.timeLimit && Math.abs(state.game.scores.blue - state.game.scores.red) < 2) {
                changedPlayer.team == Team.RED ? state.teamRedStats.push(changedPlayer) : state.teamBlueStats.push(changedPlayer);
            }
        }
        handleActivityPlayerTeamChange(changedPlayer);
        handlePlayersTeamChange(byPlayer);
    }

    function onPlayerLeave(player) {
        setTimeout(() => {
            if (!state.kickFetchVariable) {
                discordBot.sendLog(
                    `[${getDate()}] ⬅️ LEAVE (${state.playersAll.length}/${maxPlayers})\n**${player.name}**` +
                    `[${authArray[player.id][0]}] {${authArray[player.id][1]}}`
                );
                room.sendAnnouncement(
                    `${player.name} [${authArray[player.id][0]}]`,
                    null,
                    infoColor,
                    'small',
                    null
                );
            } else state.kickFetchVariable = false;
        }, 10);
        handleLineupChangeLeave(player);
        checkCaptainLeave(player);
        updateTeams();
        discordBot.updateRoomStatus();
        checkOverflowPassword();
        handlePlayersLeave();
    }

    function onPlayerKicked(kickedPlayer, reason, ban, byPlayer) {
        state.kickFetchVariable = true;
        discordBot.sendLog(
            `[${getDate()}] ⛔ ${ban ? 'BAN' : 'KICK'} (${state.playersAll.length}/${maxPlayers})\n` +
            `**${kickedPlayer.name}** [${authArray[kickedPlayer.id][0]}] {${authArray[kickedPlayer.id][1]}} was ${ban ? 'banned' : 'kicked'}` +
            `${byPlayer != null ? ' by **' + byPlayer.name + '** [' + authArray[byPlayer.id][0] + '] {' + authArray[byPlayer.id][1] + '}' : ''}`
        );
        if ((ban && ((byPlayer != null &&
            (byPlayer.id == kickedPlayer.id || getRole(byPlayer) < Role.MASTER)) || getRole(kickedPlayer) == Role.MASTER)) || disableBans
        ) {
            room.clearBan(kickedPlayer.id);
            return;
        }
        if (byPlayer != null && getRole(byPlayer) < Role.ADMIN_PERM) {
            room.sendAnnouncement(
                'Вам не разрешено кикать/банить игроков !',
                byPlayer.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            room.setPlayerAdmin(byPlayer.id, false);
            return;
        }
        if (ban) state.banList.push([kickedPlayer.name, kickedPlayer.id]);
    }

    return {
        onPlayerJoin,
        onPlayerTeamChange,
        onPlayerLeave,
        onPlayerKicked,
    };
};
