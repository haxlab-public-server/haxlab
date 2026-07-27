const { createSqliteDatabase } = require('../db/sqlite');

function createDatabaseApi(options = {}) {
    const sqlite = options.sqlite ?? createSqliteDatabase(options.filePath);

    return {
        init() {
            return sqlite.init();
        },
        getPlayerStats(auth) {
            return sqlite.getPlayerStats(auth);
        },
        getPlayerStatsByName(playerName) {
            return sqlite.getPlayerStatsByName(playerName);
        },
        savePlayerStats(auth, stats) {
            return sqlite.savePlayerStats(auth, stats);
        },
        getLeaderboard(statKey, limit) {
            return sqlite.getLeaderboard(statKey, limit);
        },
        getMasters() {
            return sqlite.getMasters();
        },
        addMaster(auth) {
            return sqlite.addMaster(auth);
        },
        getAdmins() {
            return sqlite.getAdmins();
        },
        addAdmin(auth, playerName) {
            return sqlite.addAdmin(auth, playerName);
        },
        removeAdmin(auth) {
            return sqlite.removeAdmin(auth);
        },
        getVips() {
            return sqlite.getVips();
        },
        addVip(auth, playerName) {
            return sqlite.addVip(auth, playerName);
        },
        removeVip(auth) {
            return sqlite.removeVip(auth);
        },
        linkDiscordId(auth, discordId) {
            return sqlite.linkDiscordId(auth, discordId);
        },
        getDiscordIdByAuth(auth) {
            return sqlite.getDiscordIdByAuth(auth);
        },
        getAuthByDiscordId(discordId) {
            return sqlite.getAuthByDiscordId(discordId);
        },
        banAuth(auth, playerName, reason, durationMinutes) {
            return sqlite.banAuth(auth, playerName, reason, durationMinutes);
        },
        unbanAuth(auth) {
            return sqlite.unbanAuth(auth);
        },
        getAuthBan(auth) {
            return sqlite.getAuthBan(auth);
        },
        getAuthBans() {
            return sqlite.getAuthBans();
        },
        backup(destPath) {
            return sqlite.backup(destPath);
        },
        getSetting(key) {
            return sqlite.getSetting(key);
        },
        setSetting(key, value) {
            return sqlite.setSetting(key, value);
        },
        saveGameReport(report) {
            return sqlite.saveGameReport(report);
        },
        addCoins(auth, playerName, amount) {
            return sqlite.addCoins(auth, playerName, amount);
        },
        getBalance(auth) {
            return sqlite.getBalance(auth);
        },
        getOwnedItemIds(auth) {
            return sqlite.getOwnedItemIds(auth);
        },
        ownsItem(auth, itemId) {
            return sqlite.ownsItem(auth, itemId);
        },
        buyItem(auth, playerName, itemId, price) {
            return sqlite.buyItem(auth, playerName, itemId, price);
        },
        setEquipped(auth, slot, itemId) {
            return sqlite.setEquipped(auth, slot, itemId);
        },
        getEquipped(auth) {
            return sqlite.getEquipped(auth);
        },
        close() {
            return sqlite.close();
        },
    };
}

module.exports = {
    createDatabaseApi,
};
