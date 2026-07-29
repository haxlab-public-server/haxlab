/*
 * Clears every club's custom chat color back to the default — leaves
 * everything else (the !clubcolors buy unlock, prefix, emoji, members,
 * slots) untouched, so a club that already paid to unlock custom colors
 * can just set a new one with !clubcolor rather than buying the unlock
 * again. No in-game command for this on purpose: it's a blunt, all-clubs
 * reset, not something a single club owner should be able to trigger for
 * everyone else's club too.
 *
 * Usage: node scripts/clear-club-colors.js
 */
const { createDatabaseApi } = require('../api/database');

const db = createDatabaseApi();
db.init();

const clubs = db.getAllClubs();
let cleared = 0;
for (const club of clubs) {
    if (club.color != null) {
        db.setClubColor(club.id, null);
        cleared++;
    }
}

console.log(`Cleared the custom color from ${cleared} of ${clubs.length} club(s). Restart the bot for it to take effect.`);
db.close();
