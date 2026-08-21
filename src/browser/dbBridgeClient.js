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
    'restrictCommand',
    'unrestrictCommand',
    'getCommandRestriction',
    'getCommandRestrictions',
    'getAdmins',
    'addAdmin',
    'removeAdmin',
    'getHelpers',
    'addHelper',
    'removeHelper',
    'getVips',
    'addVip',
    'removeVip',
    'getMasters',
    'getPlayerStats',
    'savePlayerStats',
    'getLeaderboard',
    'getStatRank',
    'getRating',
    'saveRating',
    'getRatingLeaderboard',
    'saveRatingHistory',
    'getRecentRatingDelta',
    'linkDiscordId',
    'getSetting',
    'setSetting',
    // Overflow password unification (requested 2026-08-17) — BFF-only alias
    // routing to the MAIN room's file (see core/bff/dbBridge.js), so both
    // rooms' core/overflowPassword.js instances read/write the same row
    // instead of each's own getSetting/setSetting above, which stay
    // per-room. The main room never calls these (its own getSetting/
    // setSetting already IS the shared file) — harmless either way, this
    // array is just an allowlist, not a required-to-use list.
    'getSharedSetting',
    'setSharedSetting',
    // Telegram account linking (requested 2026-08-17) — identity-level,
    // same "shared: main room's file" tier as VIPs/masters/admins above,
    // reachable from both rooms so !telegram works wherever a VIP plays.
    'createTelegramLinkCode',
    'redeemTelegramLinkCode',
    'linkTelegramId',
    'getAuthByTelegramId',
    'addCoins',
    'getBalance',
    'spendCoins',
    'claimDailyBonus',
    'getOwnedItemIds',
    'ownsItem',
    'buyItem',
    'getItemLevel',
    'upgradeItem',
    'setEquipped',
    'getEquipped',
    'getAllEquippedTrophies',
    'setHideCustomColors',
    'getAllHiddenCustomColors',
    'setHiddenVip',
    'getAllHiddenVipAuths',
    'addSilence',
    'removeSilence',
    'getAllSilencedPairs',
    'recordHeadToHead',
    'getHeadToHead',
    'getRecord',
    'setRecord',
    'setVipColor',
    'getAllVipColors',
    'getTopPlayers',
    'getCurrentSeason',
    'getSeasonTrophies',
    'getClub',
    'getAllClubs',
    'getAllClubMembers',
    'getClubMembership',
    'createClub',
    'inviteToClub',
    'getClubInvites',
    'joinClub',
    'removeClubMember',
    'disbandClub',
    'setClubColor',
    'unlockClubColor',
    'setClubEmoji',
    'renameClub',
    'setClubAssistant',
    'buyClubSlot',
    'addClubStats',
    'getTopClubs',
    // core/stats/analytics/ + !rating (requested 2026-08-17) — missed on
    // the first pass (real bug, caught live: !me/!rating threw "db.
    // getLatestMatchAnalyticsReport is not a function" in production,
    // because this allowlist — not api/database.js — is what actually
    // decides which db methods the in-page bundle can reach at all).
    'saveMatchAnalyticsReport',
    'getLatestMatchAnalyticsReport',
];

function createBridgedDb() {
    const db = {};
    for (const method of BRIDGED_METHODS) {
        db[method] = (...args) => window.__dbCall(method, args);
    }
    return db;
}

module.exports = { createBridgedDb, BRIDGED_METHODS };
