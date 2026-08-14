// Orchestrator-only (reads process.env — see src/core/config.js's own
// docblock for why that means this file never gets bundled into a browser
// page). Deliberately separate from the main room's src/core/config.js:
// BFF is a genuinely different HaxBall room with its own token/password,
// not a mode flag sharing the main room's secrets.
const bffRoomPassword = process.env.BFF_ROOM_PASSWORD ?? '';
const bffToken = process.env.BFF_HAXBALL_TOKEN ?? ''; // from https://www.haxball.com/headlesstoken — separate token, this is a separate room

const testMode = process.env.BFF_TEST_MODE === 'true';

module.exports = {
    bffRoomPassword,
    bffToken,
    testMode,
};
