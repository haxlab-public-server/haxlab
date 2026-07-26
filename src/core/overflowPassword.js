/*
 * Once the room fills past a threshold below capacity, sets a random
 * password reserving the remaining slots for people who know it (shared in
 * Discord), rotating it hourly while active, and clears it again once the
 * population drops back below the threshold.
 *
 * The rotation timer runs continuously once started rather than being
 * torn down/recreated on every activate/deactivate — the population
 * naturally flaps right around the threshold (someone leaving and
 * rejoining within minutes is the common case, not an edge case), and
 * re-activating must reuse whatever password is still current instead of
 * minting a brand new one each time. Without this, a room hovering at the
 * threshold could get a fresh password (and a fresh Discord announcement)
 * every few minutes instead of the intended once an hour.
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
    let currentPassword = null;
    let rotateTimer = null;

    function applyNewPassword() {
        currentPassword = generateRoomPassword();
        state.roomPassword = currentPassword;
        room.setPassword(currentPassword);
        discordBot.sendPassword(currentPassword);
    }

    function activate() {
        active = true;
        if (currentPassword) {
            // Still within this password's rotation window — reuse it
            // rather than generating (and re-announcing to Discord) a new
            // one just because the room briefly dipped below the threshold.
            state.roomPassword = currentPassword;
            room.setPassword(currentPassword);
        } else {
            applyNewPassword();
        }
        // Started once and left running: it only needs to check `active`
        // on each tick, so activate()/deactivate() flapping never needs to
        // touch it.
        if (!rotateTimer) {
            rotateTimer = setInterval(() => {
                if (active) applyNewPassword();
            }, rotateIntervalMs);
        }
    }

    function deactivate() {
        active = false;
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
