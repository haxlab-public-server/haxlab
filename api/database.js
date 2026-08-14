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
        getStatRank(statKey, value) {
            return sqlite.getStatRank(statKey, value);
        },
        savePlayerStats(auth, stats) {
            return sqlite.savePlayerStats(auth, stats);
        },
        getLeaderboard(statKey, limit) {
            return sqlite.getLeaderboard(statKey, limit);
        },
        getRating(auth) {
            return sqlite.getRating(auth);
        },
        saveRating(auth, playerName, mu, sigma) {
            return sqlite.saveRating(auth, playerName, mu, sigma);
        },
        getRatingLeaderboard(limit) {
            return sqlite.getRatingLeaderboard(limit);
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
        addVip(auth, playerName, expiresAt) {
            return sqlite.addVip(auth, playerName, expiresAt);
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
        restrictCommand(auth, command, playerName, reason, durationMinutes) {
            return sqlite.restrictCommand(auth, command, playerName, reason, durationMinutes);
        },
        unrestrictCommand(auth, command) {
            return sqlite.unrestrictCommand(auth, command);
        },
        getCommandRestriction(auth, command) {
            return sqlite.getCommandRestriction(auth, command);
        },
        getCommandRestrictions() {
            return sqlite.getCommandRestrictions();
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
        spendCoins(auth, playerName, amount) {
            return sqlite.spendCoins(auth, playerName, amount);
        },
        claimDailyBonus(auth, playerName, coinsPerStreak, maxStreak) {
            return sqlite.claimDailyBonus(auth, playerName, coinsPerStreak, maxStreak);
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
        getItemLevel(auth, itemId) {
            return sqlite.getItemLevel(auth, itemId);
        },
        getItemOwners(itemId) {
            return sqlite.getItemOwners(itemId);
        },
        setItemLevel(auth, itemId, level) {
            return sqlite.setItemLevel(auth, itemId, level);
        },
        upgradeItem(auth, playerName, itemId, cost, expectedCurrentLevel) {
            return sqlite.upgradeItem(auth, playerName, itemId, cost, expectedCurrentLevel);
        },
        setEquipped(auth, slot, itemId) {
            return sqlite.setEquipped(auth, slot, itemId);
        },
        getEquipped(auth) {
            return sqlite.getEquipped(auth);
        },
        getAllEquippedTrophies() {
            return sqlite.getAllEquippedTrophies();
        },
        setHideCustomColors(auth, hidden) {
            return sqlite.setHideCustomColors(auth, hidden);
        },
        getAllHiddenCustomColors() {
            return sqlite.getAllHiddenCustomColors();
        },
        setVipColor(auth, color) {
            return sqlite.setVipColor(auth, color);
        },
        getAllVipColors() {
            return sqlite.getAllVipColors();
        },
        getTopPlayers() {
            return sqlite.getTopPlayers();
        },
        getCurrentSeason() {
            return sqlite.getCurrentSeason();
        },
        getSeasonTrophies() {
            return sqlite.getSeasonTrophies();
        },
        closeSeason() {
            return sqlite.closeSeason();
        },
        getClub(clubId) {
            return sqlite.getClub(clubId);
        },
        getAllClubs() {
            return sqlite.getAllClubs();
        },
        getAllClubMembers() {
            return sqlite.getAllClubMembers();
        },
        getClubMembership(auth) {
            return sqlite.getClubMembership(auth);
        },
        createClub(ownerAuth, ownerName, name, prefix, cost) {
            return sqlite.createClub(ownerAuth, ownerName, name, prefix, cost);
        },
        inviteToClub(clubId, auth, durationSeconds) {
            return sqlite.inviteToClub(clubId, auth, durationSeconds);
        },
        getClubInvites(auth) {
            return sqlite.getClubInvites(auth);
        },
        joinClub(auth, playerName, clubId) {
            return sqlite.joinClub(auth, playerName, clubId);
        },
        removeClubMember(auth) {
            return sqlite.removeClubMember(auth);
        },
        disbandClub(clubId) {
            return sqlite.disbandClub(clubId);
        },
        setClubColor(clubId, color) {
            return sqlite.setClubColor(clubId, color);
        },
        unlockClubColor(auth, clubId, cost) {
            return sqlite.unlockClubColor(auth, clubId, cost);
        },
        setClubEmoji(clubId, emoji) {
            return sqlite.setClubEmoji(clubId, emoji);
        },
        renameClub(auth, clubId, name, prefix, cost) {
            return sqlite.renameClub(auth, clubId, name, prefix, cost);
        },
        setClubAssistant(clubId, auth) {
            return sqlite.setClubAssistant(clubId, auth);
        },
        buyClubSlot(auth, clubId, cost) {
            return sqlite.buyClubSlot(auth, clubId, cost);
        },
        addClubStats(clubId, deltas) {
            return sqlite.addClubStats(clubId, deltas);
        },
        getTopClubs(limit) {
            return sqlite.getTopClubs(limit);
        },
        close() {
            return sqlite.close();
        },
    };
}

module.exports = {
    createDatabaseApi,
};
