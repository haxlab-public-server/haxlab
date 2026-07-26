/*
 * Registers a player's auth as a permanent room master, directly in the
 * database — there is no in-game command for this (masters are configured
 * out-of-band on purpose, not granted at runtime).
 *
 * Finding your own auth: join the room once with fetchRecordingVariable/
 * roomWebhook logging enabled, or check the bot's console output on
 * room.onPlayerJoin — it's printed there. It's the same value every time you
 * join with the same HaxBall account.
 *
 * Usage: node scripts/add-master.js <auth>
 */
const path = require('path');
const { createDatabaseApi } = require('../api/database');

const auth = process.argv[2];
if (!auth) {
    console.log('Usage: node scripts/add-master.js <auth>');
    process.exit(1);
}

const db = createDatabaseApi();
db.init();
db.addMaster(auth);
console.log(`"${auth}" is now a master. Restart the bot for it to take effect.`);
db.close();
