/*
 * room.onRoomLink/PlayerAdminChange/KickRateLimitSet/StadiumChange/GameTick.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createMiscEvents({
    room,
    state,
    HaxNotification,
    Role,
    discordBot,
    emptyPlayer,
    errorColor,
    infoColor,
    checkTime,
    getDate,
    getGameStats,
    getLastTouchOfTheBall,
    getRole,
    handleActivity,
    stadiumCommand,
    updateTeams,
}) {
    function onRoomLink(url) {
        console.log(url);
        discordBot.sendLog(`[${getDate()}] 🔗 LINK ${url}`);
        discordBot.setRoomLink(url);
    }

    // The room works fine with no admin at all — nobody gets the badge
    // auto-assigned. Masters/permanent admins always keep (or get restored)
    // theirs; anyone else who ends up admin for any other reason (e.g.
    // HaxBall's own server auto-granting it to the first player in an empty
    // room) has it revoked immediately.
    function onPlayerAdminChange(changedPlayer, byPlayer) {
        updateTeams();
        if (getRole(changedPlayer) >= Role.ADMIN_PERM) {
            if (!changedPlayer.admin) room.setPlayerAdmin(changedPlayer.id, true);
            return;
        }
        if (changedPlayer.admin) room.setPlayerAdmin(changedPlayer.id, false);
    }

    function onKickRateLimitSet(min, rate, burst, byPlayer) {
        if (byPlayer != null) {
            room.sendAnnouncement(
                `Изменение лимита скорости кика не допускается. Он должен остаться на "6-12-4".`,
                byPlayer.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            room.setKickRateLimit(6, 0, 0);
        }
    }

    function onStadiumChange(newStadiumName, byPlayer) {
        if (byPlayer !== null) {
            if (getRole(byPlayer) < Role.MASTER && state.currentStadium != 'other') {
                room.sendAnnouncement(
                    `Вы не можете изменить стадион вручную! Пожалуйста, используйте команды стадиона.`,
                    byPlayer.id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
                stadiumCommand(emptyPlayer, `!${state.currentStadium}`);
            } else {
                room.sendAnnouncement(
                    `Стадион изменен. После завершения игры на этом стадионе, пожалуйста, используйте команды стадиона.`,
                    byPlayer.id,
                    infoColor,
                    'bold',
                    HaxNotification.CHAT
                );
                state.currentStadium = 'other';
            }
        }
        state.checkStadiumVariable = true;
    }

    function onGameTick() {
        checkTime();
        getLastTouchOfTheBall();
        getGameStats();
        handleActivity();
    }

    return {
        onRoomLink,
        onPlayerAdminChange,
        onKickRateLimitSet,
        onStadiumChange,
        onGameTick,
    };
};
