/*
 * Once the room fills past a threshold below capacity, sets a random
 * password reserving the remaining slots for people who know it (shared in
 * Discord), rotating it hourly while active, and clears it again once the
 * population drops back below the threshold.
 *
 * Mutable room state is reached through `state`, never captured by value.
 *
 * Note: this shares state.roomPassword/room.setPassword with the master
 * !password command (see commands/master.js). If an admin manually sets a
 * password while the room is already at/above the threshold, the next
 * hourly rotation here will silently overwrite it — an accepted rough edge,
 * not handled specially.
 */
module.exports = function createOverflowPassword({
    room,
    state,
    maxPlayers,
    passwordThreshold,
    discordBot,
    generateRoomPassword,
    rotateIntervalMs,
}) {
    let active = false;
    let rotateTimer = null;

    function applyPassword() {
        const password = generateRoomPassword();
        state.roomPassword = password;
        room.setPassword(password);
        discordBot.sendPassword(password);
    }

    function activate() {
        active = true;
        applyPassword();
        rotateTimer = setInterval(applyPassword, rotateIntervalMs);
    }

    function deactivate() {
        active = false;
        clearInterval(rotateTimer);
        rotateTimer = null;
        state.roomPassword = '';
        room.setPassword(null);
    }

    function checkOverflowPassword() {
        const isFull = state.playersAll.length >= passwordThreshold;
        if (isFull && !active) activate();
        else if (!isFull && active) deactivate();
    }

    return {
        checkOverflowPassword,
    };
};
