/*
 * Room configuration that has no dependency on process.env — split out of
 * config.js specifically so this file is safe to bundle into the browser
 * page (src/browser/entry.js): `process` doesn't exist there at all, so
 * anything reading process.env directly would throw the instant the bundle
 * loads. The HaxBall token and room password DO come from process.env (via
 * config.js, read by the orchestrator — see src/index.js) and get injected
 * into the page separately as window.__secrets, rather than living here.
 */
const roomName = '    🧪 HaxLab | Futsal | 4x4 WinStay 🧪'; // room name
const maxPlayers = 20;
const roomPublic = true;
const geo = { code: 'RU', lat: 55.3, lon: 37.6173 }; // Moscow — shown as the room's flag/location

const fetchRecordingVariable = true;
const timeLimit = 5;
const scoreLimit = 5;

const HAXBALL_TOKEN_LENGTH = 39;

// token is a parameter (not a module-level constant read from process.env)
// specifically so this function works identically whether called from the
// orchestrator (old bootstrap, pre-migration) or from inside the page,
// where it's called with whatever token window.__secrets carried in.
// testMode is the same story — set via TEST_MODE (see npm run test /
// HaxBot_test.js), which only exists as process.env on the orchestrator
// side, so it has to cross into the page as a plain boolean too rather than
// being read here directly.
function buildGameConfig(token, testMode = false) {
    const gameConfig = {
        roomName: testMode ? `[TEST] ${roomName}` : roomName,
        maxPlayers,
        public: roomPublic,
        noPlayer: true,
        geo,
    };

    if (typeof token === 'string' && token.length === HAXBALL_TOKEN_LENGTH) {
        gameConfig.token = token;
    }

    return gameConfig;
}

module.exports = {
    roomName,
    maxPlayers,
    roomPublic,
    geo,
    fetchRecordingVariable,
    timeLimit,
    scoreLimit,
    buildGameConfig,
};
