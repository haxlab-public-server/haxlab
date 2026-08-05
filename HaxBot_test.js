/*
 * Test-mode entry point (npm run test / npm test) — same bot, same .env
 * secrets, but src/core/config.js's testMode ends up true: the room name
 * gets a "[TEST] " prefix (see roomConstants.js's buildGameConfig) and
 * ghost-kick/AFK-kick are disabled (see entry.js's debugMode), so you can
 * join a test room from the same account you're already using in the live
 * one without getting kicked out of either.
 */
const path = require('path');

try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn('No .env file found — copy .env.example to .env and fill in your secrets.');
}

// Set after loadEnvFile so this always wins regardless of anything (there
// shouldn't be one) named TEST_MODE in .env.
process.env.TEST_MODE = 'true';

require('./src/index.js');
