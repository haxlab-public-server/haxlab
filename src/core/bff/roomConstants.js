/*
 * BFF's own room configuration — separate from ../roomConstants.js (the
 * main room's), since this is a genuinely different HaxBall room with its
 * own name/capacity/token, not a mode flag on the same room. Same
 * "no process.env access" constraint applies here too (bundled into the
 * browser page — see src/browser/bffEntry.js), for the same reason as the
 * main room's file.
 */
const roomName = '🧪 HaxLab | BFF 🧪';
const maxPlayers = 14;
const roomPublic = true;
const geo = { code: 'RU', lat: 55.3, lon: 37.6173 }; // Moscow, same as the main room

const HAXBALL_TOKEN_LENGTH = 39;

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
    buildGameConfig,
};
