/*
 * One-time migration for the !shop size upgrade rework (small/big, see
 * shopItems.js): the per-level radius step went from 2 to 1, with maxLevel
 * doubling from 5 to 10 to match — same total radius range (±10 at max
 * level either way), just twice the granularity, and 10 price tiers of
 * 1000/2000/.../10000 instead of the old 200/300/.../600.
 *
 * Without this, an existing owner's stored level would suddenly mean half
 * the radius change it used to (old level 2 -> old radius diff 4, but under
 * the new step that same level 2 is only diff 2). Doubling every existing
 * small/big owner's level (old level 2 -> new level 4) keeps their actual
 * disc radius identical across the change.
 *
 * Guarded by a bot_settings flag so running this twice (after a restart, or
 * by mistake) can't double everyone's level a second time.
 *
 * Usage: node scripts/migrate-size-levels.js
 */
const { createDatabaseApi } = require('../api/database');

const MIGRATION_FLAG = 'sizeLevelsMigratedV2';

const db = createDatabaseApi();
db.init();

if (db.getSetting(MIGRATION_FLAG)) {
    console.log(`Already migrated (bot_settings.${MIGRATION_FLAG} is set) — nothing to do.`);
    db.close();
    process.exit(0);
}

let migrated = 0;
for (const itemId of ['small', 'big']) {
    for (const { auth, level } of db.getItemOwners(itemId)) {
        db.setItemLevel(auth, itemId, Math.min(level * 2, 10));
        migrated++;
    }
}

db.setSetting(MIGRATION_FLAG, '1');
console.log(`Migrated ${migrated} small/big owner(s) to the new 10-level scale. Restart the bot for it to take effect.`);
db.close();
