/*
 * BFF talks to TWO separate database files (see the haxchill-second-room-plan
 * project memory): its OWN file (stats, rating, bans, settings — anything
 * room-specific) and the MAIN room's file (masters/admins/vips ONLY — those
 * three lists are explicitly shared across both rooms; everything else,
 * including auth-bans, is explicitly NOT).
 *
 * This wraps both behind one object using the same method names
 * commands/master.js, entry.js's role-loading, etc. already expect from a
 * `db` dependency — nothing downstream needs to know which physical file
 * backs which call. Deliberately exposes only what BFF actually needs
 * (no economy/shop/club/season methods — those don't exist on this room at
 * all, per the confirmed "no economy, no mini-games" scope).
 */
module.exports = function createBffDatabaseBridge({ roomDb, sharedDb }) {
    return {
        init() {
            roomDb.init();
            sharedDb.init();
            return true;
        },

        // --- room-specific: this BFF room's own file ---
        getPlayerStats: (auth) => roomDb.getPlayerStats(auth),
        getPlayerStatsByName: (name) => roomDb.getPlayerStatsByName(name),
        getStatRank: (statKey, value) => roomDb.getStatRank(statKey, value),
        savePlayerStats: (auth, stats) => roomDb.savePlayerStats(auth, stats),
        getLeaderboard: (statKey, limit) => roomDb.getLeaderboard(statKey, limit),
        getRating: (auth) => roomDb.getRating(auth),
        saveRating: (auth, playerName, mu, sigma) => roomDb.saveRating(auth, playerName, mu, sigma),
        getRatingLeaderboard: (limit) => roomDb.getRatingLeaderboard(limit),
        saveRatingHistory: (auth, delta) => roomDb.saveRatingHistory(auth, delta),
        getRecentRatingDelta: (auth, limit) => roomDb.getRecentRatingDelta(auth, limit),
        getSetting: (key) => roomDb.getSetting(key),
        setSetting: (key, value) => roomDb.setSetting(key, value),
        backup: (destPath) => roomDb.backup(destPath),

        // !viphide (bff/commands.js) — own file, own independent preference
        // (see haxchill-second-room-plan: hiddenVipSet is already a
        // separate in-memory Set per room, this just persists that same
        // per-room split). BFF has no !silence at all, so no addSilence/
        // removeSilence/getAllSilencedPairs here.
        setHiddenVip: (auth, hidden) => roomDb.setHiddenVip(auth, hidden),
        getAllHiddenVipAuths: () => roomDb.getAllHiddenVipAuths(),

        // !vipcolor (bff/commands.js) — own file, own independent color map,
        // same reasoning as setHiddenVip/getAllHiddenVipAuths above.
        setVipColor: (auth, color) => roomDb.setVipColor(auth, color),
        getAllVipColors: () => roomDb.getAllVipColors(),

        // Explicitly NOT shared — confirmed 2026-08-14: each room keeps its
        // own independent ban list, a player banned in the main room is
        // not automatically blocked here.
        banAuth: (auth, playerName, reason, durationMinutes) => roomDb.banAuth(auth, playerName, reason, durationMinutes),
        unbanAuth: (auth) => roomDb.unbanAuth(auth),
        getAuthBan: (auth) => roomDb.getAuthBan(auth),
        getAuthBans: () => roomDb.getAuthBans(),

        // Same "own file, not shared" reasoning as bans above. voteBan.js
        // (reused as-is — see haxchill-second-room-plan memory) calls
        // getCommandRestriction unconditionally on every !voteban attempt;
        // the other three exist for parity with commands/master.js (also
        // reused as-is), which references all four — without these, a
        // future !restrict/!unrestrict/!cmdrestrictions wiring attempt
        // would throw on the first call.
        restrictCommand: (auth, command, playerName, reason, durationMinutes) => roomDb.restrictCommand(auth, command, playerName, reason, durationMinutes),
        unrestrictCommand: (auth, command) => roomDb.unrestrictCommand(auth, command),
        getCommandRestriction: (auth, command) => roomDb.getCommandRestriction(auth, command),
        getCommandRestrictions: () => roomDb.getCommandRestrictions(),

        // --- shared: the MAIN room's file, masters/admins/vips only ---
        getMasters: () => sharedDb.getMasters(),
        addMaster: (auth) => sharedDb.addMaster(auth),
        getAdmins: () => sharedDb.getAdmins(),
        addAdmin: (auth, playerName) => sharedDb.addAdmin(auth, playerName),
        removeAdmin: (auth) => sharedDb.removeAdmin(auth),
        getVips: () => sharedDb.getVips(),
        addVip: (auth, playerName, expiresAt) => sharedDb.addVip(auth, playerName, expiresAt),
        removeVip: (auth) => sharedDb.removeVip(auth),

        // Overflow password unification (requested 2026-08-17) — separate
        // names from getSetting/setSetting above (which stay routed to this
        // room's OWN file for everything else) so core/overflowPassword.js
        // can be handed a db-shaped object whose getSetting/setSetting land
        // here instead, without touching what "getSetting" means for any
        // other BFF caller.
        getSharedSetting: (key) => sharedDb.getSetting(key),
        setSharedSetting: (key, value) => sharedDb.setSetting(key, value),

        // Telegram account linking (requested 2026-08-17) — identity-level,
        // same tier as masters/admins/vips above: one linked account should
        // work regardless of which room a VIP actually plays.
        createTelegramLinkCode: (code, target, expiresAt) => sharedDb.createTelegramLinkCode(code, target, expiresAt),
        redeemTelegramLinkCode: (code) => sharedDb.redeemTelegramLinkCode(code),
        linkTelegramId: (auth, telegramChatId) => sharedDb.linkTelegramId(auth, telegramChatId),
        getAuthByTelegramId: (telegramChatId) => sharedDb.getAuthByTelegramId(telegramChatId),

        close() {
            roomDb.close();
            sharedDb.close();
        },
    };
};
