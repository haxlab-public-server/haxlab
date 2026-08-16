/*
 * Once the room fills past a threshold below capacity, sets a random
 * password reserving the remaining slots for people who know it (shared in
 * Discord), rotating it hourly while active, and clears it again once the
 * population drops back below the threshold.
 *
 * Shared across BOTH rooms (requested 2026-08-17): the main room and BFF
 * each run their own instance of this factory, independently deciding
 * WHETHER a password is currently needed (their own `passwordThreshold`,
 * unchanged), but the VALUE itself is pulled from one shared store so both
 * rooms always show the same password — there's only one Discord channel
 * for it, two different values made no sense. `db` here is expected to be
 * a settings store that ultimately lands on the SAME physical row for both
 * callers: the main room passes its own `db` directly (its file already
 * IS the canonical one); BFF passes a thin wrapper routing getSetting/
 * setSetting to core/bff/dbBridge.js's getSharedSetting/setSharedSetting
 * (the main room's file) instead of its own — see bffEntry.js's own
 * wiring comment.
 *
 * Since neither room can trust its own in-memory state to reflect what the
 * OTHER room just did, `syncPassword()` re-reads the shared value on every
 * tick rather than only generating locally: if the shared password is
 * missing or past its hourly rotation, THIS tick mints a fresh one
 * (whichever room's tick notices first "wins" — a low-stakes race, same
 * spirit as the accepted rough edge noted below for the master !password
 * command); if a different, still-fresh value is already there (the OTHER
 * room rotated it), this room silently adopts it without re-announcing
 * (already posted once by whoever minted it).
 *
 * The sync timer runs continuously once started rather than being torn
 * down/recreated on every activate/deactivate, for the same "population
 * flaps right around the threshold" reason as before — activate()/
 * deactivate() flapping never needs to touch it.
 *
 * Mutable room state is reached through `state`, never captured by value.
 *
 * Note: this shares state.roomPassword/room.setPassword with the master
 * !password command (see commands/master.js). If an admin manually sets a
 * password while the room is already at/above the threshold, the next
 * sync here will silently overwrite it — an accepted rough edge, not
 * handled specially.
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
    syncIntervalMs = 60000,
}) {
    let active = false;
    // A persisted password past its hourly rotation is just as stale as no
    // password at all — only seed from it if it's still within window.
    let currentPassword = (initialPassword && Date.now() - initialPasswordSetAt < rotateIntervalMs)
        ? initialPassword
        : null;
    let syncTimer = null;
    // Guarantees room.setPassword() actually gets called at least once per
    // activation, even if the shared value happens to already equal the
    // locally-seeded currentPassword (e.g. reused from initialPassword on a
    // restart) — without this, syncPassword's "only apply if it changed"
    // check below would wrongly conclude nothing needs applying, even
    // though the ACTUAL native room was never told about it this session.
    let appliedThisActivation = false;

    // Fire-and-forget like every other db write from this bundle (see
    // dbBridgeClient.js) — a failed persist just means the next sync tick
    // (this room's or the other room's) falls back to minting a fresh
    // password, not a crash.
    function persistPassword(password) {
        db.setSetting(PASSWORD_SETTING_KEY, password).catch((err) => console.error('[overflowPassword] persist failed:', err));
        db.setSetting(PASSWORD_SET_AT_SETTING_KEY, String(Date.now())).catch((err) => console.error('[overflowPassword] persist failed:', err));
    }

    function applyLocally(password) {
        currentPassword = password;
        state.roomPassword = password;
        room.setPassword(password);
        appliedThisActivation = true;
    }

    function mintNewPassword() {
        const password = generateRoomPassword();
        applyLocally(password);
        discordBot.sendPassword(password);
        persistPassword(password);
    }

    // Pulls the current shared value; mints a fresh one if it's missing or
    // stale, otherwise applies it locally ONLY if it's new to this room
    // this activation (a fresh activation always applies at least once —
    // see appliedThisActivation above; a later tick within the same
    // activation only re-applies if the value actually changed under us,
    // i.e. the OTHER room rotated it — avoiding a redundant
    // room.setPassword() call every single sync tick otherwise). A failed
    // shared-state read falls back to minting a local password rather than
    // leaving the room unprotected.
    async function syncPassword() {
        if (!active) return;
        try {
            const sharedValue = await db.getSetting(PASSWORD_SETTING_KEY);
            const sharedSetAt = Number(await db.getSetting(PASSWORD_SET_AT_SETTING_KEY)) || 0;
            const isStale = !sharedValue || Date.now() - sharedSetAt >= rotateIntervalMs;
            if (isStale) {
                mintNewPassword();
            } else if (!appliedThisActivation || sharedValue !== currentPassword) {
                applyLocally(sharedValue);
            }
        } catch (err) {
            console.error('[overflowPassword] shared-state read failed, minting a local password instead:', err);
            mintNewPassword();
        }
    }

    function activate() {
        active = true;
        appliedThisActivation = false;
        syncPassword().catch((err) => console.error('[overflowPassword] sync failed:', err));
        // Started once and left running: it only needs to check `active`
        // on each tick, so activate()/deactivate() flapping never needs to
        // touch it.
        if (!syncTimer) {
            syncTimer = setInterval(() => {
                if (active) syncPassword().catch((err) => console.error('[overflowPassword] sync failed:', err));
            }, syncIntervalMs);
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
