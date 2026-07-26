/*
 * Chat / lookup helpers.
 *
 * Note: playersAll / teamRed / teamBlue / teamSpec / commands are passed as
 * accessors, not values. They are reassigned wholesale by updateTeams() on every
 * room event, so capturing them by value would freeze this module on whatever
 * they held at wiring time (undefined, since the factory runs before they exist).
 */
module.exports = function createChatHelpers({
    room,
    Team,
    redColor,
    blueColor,
    errorColor,
    privateMessageColor,
    HaxNotification,
    getPlayersAll,
    getTeamRed,
    getTeamBlue,
    getTeamSpec,
    getCommands,
}) {
    function getCommand(commandStr) {
        const commands = getCommands();
        if (commands.hasOwnProperty(commandStr)) return commandStr;
        for (const [key, value] of Object.entries(commands)) {
            for (let alias of value.aliases) {
                if (alias == commandStr) return key;
            }
        }
        return false;
    }

    function getTeamArray(team, includeAFK = true) {
        if (team == Team.RED) return getTeamRed();
        if (team == Team.BLUE) return getTeamBlue();
        if (includeAFK) {
            return getPlayersAll().filter((p) => p.team === Team.SPECTATORS);
        }
        return getTeamSpec();
    }

    function sendAnnouncementTeam(message, team, color, style, mention) {
        for (let player of team) {
            room.sendAnnouncement(message, player.id, color, style, mention);
        }
    }

    function teamChat(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const emoji = player.team == Team.RED ? '🔴' : player.team == Team.BLUE ? '🔵' : '⚪';
        var message = `${emoji} [TEAM] ${player.name}: ${msgArray.join(' ')}`;
        const team = getTeamArray(player.team, true);
        const color = player.team == Team.RED ? redColor : player.team == Team.BLUE ? blueColor : null;
        const style = 'bold';
        const mention = HaxNotification.CHAT;
        sendAnnouncementTeam(message, team, color, style, mention);
    }

    function playerChat(player, message) {
        const playersAll = getPlayersAll();
        const msgArray = message.split(/ +/);
        const playerTargetIndex = playersAll.findIndex(
            (p) => p.name.replaceAll(' ', '_') == msgArray[0].substring(2)
        );
        if (playerTargetIndex == -1) {
            room.sendAnnouncement(
                `Такого игрока не существует.`,
                player.id,
                errorColor,
                'bold',
                null
            );
            return false;
        }
        const playerTarget = playersAll[playerTargetIndex];
        if (player.id == playerTarget.id) {
            room.sendAnnouncement(
                `Ты не можешь отправить личные сообщения самому себе!`,
                player.id,
                errorColor,
                'bold',
                null
            );
            return false;
        }
        const messageFrom = `📝 [ЛС с ${playerTarget.name}] ${player.name}: ${msgArray.slice(1).join(' ')}`;

        const messageTo = `📝 [ЛС с ${player.name}] ${playerTarget.name}: ${msgArray.slice(1).join(' ')}`;

        room.sendAnnouncement(
            messageFrom,
            player.id,
            privateMessageColor,
            'bold',
            HaxNotification.CHAT
        );
        room.sendAnnouncement(
            messageTo,
            playerTarget.id,
            privateMessageColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    return {
        getCommand,
        getTeamArray,
        sendAnnouncementTeam,
        teamChat,
        playerChat,
    };
};
