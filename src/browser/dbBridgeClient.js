/*
 * In-page stand-in for api/database.js's `db`, used only when this bundle
 * runs inside the real HaxBall room page (see src/browser/entry.js) instead
 * of directly inside a Node process. node:sqlite doesn't exist in a browser
 * — every method here forwards to window.__dbCall (exposed by the Node
 * orchestrator via Puppeteer's page.exposeFunction, see src/index.js),
 * which runs the real query against the real db and returns the result.
 *
 * Same method names/shapes as api/database.js's createDatabaseApi() — every
 * src/core/* factory that takes `db` as a dependency-injected parameter
 * works unmodified against this, the only difference is these calls are now
 * genuinely async (a real cross-process round trip) where the direct
 * node:sqlite version was synchronous. Only the methods src/core/* actually
 * calls are listed here — init/backup/close/etc. stay orchestrator-only,
 * there's no reason for the page to be able to reach them at all.
 */
const BRIDGED_METHODS = [
    'getAuthBan',
    'getAuthBans',
    'banAuth',
    'unbanAuth',
    'getAdmins',
    'addAdmin',
    'removeAdmin',
    'getVips',
    'addVip',
    'removeVip',
    'getMasters',
    'getPlayerStats',
    'savePlayerStats',
    'getLeaderboard',
    'linkDiscordId',
    'getSetting',
    'setSetting',
];

function createBridgedDb() {
    const db = {};
    for (const method of BRIDGED_METHODS) {
        db[method] = (...args) => window.__dbCall(method, args);
    }
    return db;
}

module.exports = { createBridgedDb, BRIDGED_METHODS };
