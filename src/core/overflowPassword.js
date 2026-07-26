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
 * currentPassword/active/rotateTimer are otherwise pure in-memory state,
 * which used to mean a full bot restart silently invalidated whatever
 * password was last posted to Discord — the room comes back with 0
 * players (below threshold, correctly open), but once it refills past the
 * threshold again this used to mint and announce a brand new password even
 * though the one people already have in Discord is still "current" from
 * their point of view. initialPassword/initialPasswordSetAt (persisted via
 * db.setSetting, read once at startup in entry.js before this factory is
 * even called) seed currentPassword across that gap: if the persisted
 * password hasn't hit its hourly rotation yet, the very next threshold
 * crossing reuses it (and does NOT re-announce, exactly like any other
 * reuse-across-flapping case) instead of generating a new one nobody's
 * seen yet.
 *
 * Mutable room state is reached through `state`, never captured by value.
 *
 * Note: this shares state.roomPassword/room.setPassword with the master
 * !password command (see commands/master.js). If an admin manually sets a
 * password while the room is already at/above the threshold, the next
 * hourly rotation here will silently overwrite it — an accepted rough edge,
 * not handled specially.
 */
const PASSWORD_SETTING_KEY = 'overflowPasswordValue';
const PASSWORD_SET_AT_SETTING_KEY = 'overflowPasswordSetAt';

module.exports = function createOverflowPassword({
    room,
    state,
    maxPlayers,
    passwordThreshold,
    discordBot,
    generateRoomPassword,
    rotateIntervalMs,
    db,
    initialPassword,
    initialPasswordSetAt,
}) {
    let active = false;
    // A persisted password past its hourly rotation is just as stale as no
    // password at all — only seed from it if it's still within window.
    let currentPassword = (initialPassword && Date.now() - initialPasswordSetAt < rotateIntervalMs)
        ? initialPassword
        : null;
    let rotateTimer = null;

    // Fire-and-forget like every other db write from this bundle (see
    // dbBridgeClient.js) — a failed persist just means the next restart
    // falls back to minting a fresh password, not a crash.
    function persistPassword(password) {
        db.setSetting(PASSWORD_SETTING_KEY, password).catch((err) => console.error('[overflowPassword] persist failed:', err));
        db.setSetting(PASSWORD_SET_AT_SETTING_KEY, String(Date.now())).catch((err) => console.error('[overflowPassword] persist failed:', err));
    }

    function applyNewPassword() {
        currentPassword = generateRoomPassword();
        state.roomPassword = currentPassword;
        room.setPassword(currentPassword);
        discordBot.sendPassword(currentPassword);
        persistPassword(currentPassword);
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
