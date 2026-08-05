/*
 * Closes the current season (see db.closeSeason, db/sqlite.js):
 *   - Freezes the current top-3 in every category into season_trophies
 *     forever — a player who held rank 1-3 can keep displaying that exact
 *     title afterward via "!trophy <category> <season>" even after their
 *     live stats reset (see commands/trophies.js).
 *   - Resets every player's games/wins/goals/assists/own_goals/clean_sheets/
 *     playtime to 0.
 *   - Leaves balance, owned shop items (player_items), equipped cosmetics
 *     and daily_streak completely untouched.
 *   - Advances bot_settings.currentSeason by one.
 *
 * Guarded by a 'seasonClosed:<N>' bot_settings flag inside closeSeason()
 * itself, same idempotency pattern as scripts/migrate-size-levels.js — safe
 * to re-run after a restart mid-run or by mistake.
 *
 * Usage: node scripts/close-season.js
 */
const { createDatabaseApi } = require('../api/database');

const db = createDatabaseApi();
db.init();

const result = db.closeSeason();

if (result.alreadyClosed) {
    console.log(`Season ${result.season} was already closed — nothing to do.`);
} else {
    console.log(
        `Closed season ${result.season}: froze ${result.trophiesSaved} trophy spot(s), reset every player's stats. ` +
        `Now on season ${result.nextSeason}. Restart the bot for it to take effect.`
    );
}

db.close();
