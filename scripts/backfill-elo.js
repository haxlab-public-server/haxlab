/*
 * One-off seed for the main room's new ELO column (see core/stats/elo.js) —
 * without this, every existing player would start flat at the DEFAULT 1000
 * regardless of how established they already are. Computes a plausible
 * starting rating from each player's EXISTING stats (winrate, goals/game,
 * assists/game, clean-sheets/game) instead.
 *
 * Only touches players with enough games for a trustworthy per-game rate
 * (MIN_GAMES, same threshold as matchHistory.js's RIVALRY_MIN_GAMES, kept
 * for consistency) — everyone below that is left at the column's own
 * DEFAULT 1000, same as a genuinely brand-new player.
 *
 * Idempotent but NOT additive: re-running it recomputes and overwrites, it
 * doesn't stack. Meant to run exactly once, right before this ships — every
 * later game correctly moves ratings the normal way (roomStats.js's
 * updateStats), so running this again after real matches have been played
 * would wipe that real progress back to a fresh backfill guess.
 *
 * Usage: node scripts/backfill-elo.js [--dry-run]
 */
const { createDatabaseApi } = require('../api/database');

const MIN_GAMES = 5;
const BASELINE = 1000;
const SPREAD = 200;
const MIN_ELO = 700;
const MAX_ELO = 1400;
const WINRATE_WEIGHT = 0.6;
const SKILL_WEIGHT = 0.4;

function mean(values) {
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values, avg) {
    const variance = mean(values.map((v) => (v - avg) ** 2));
    return Math.sqrt(variance) || 1; // avoid a divide-by-zero when everyone's identical
}

function zScore(value, avg, sd) {
    return (value - avg) / sd;
}

// Exported for tests — pure, no DB access. `rows` is the shape
// db.getPlayerStatsForSeed returns (auth, playerName, games, wins, goals,
// assists, CS).
function computeSeedRatings(rows) {
    const withRates = rows.map((r) => ({
        auth: r.auth,
        playerName: r.playerName,
        games: r.games,
        winrate: r.wins / r.games,
        goalsPerGame: r.goals / r.games,
        assistsPerGame: r.assists / r.games,
        csPerGame: r.CS / r.games,
    }));

    const winrateAvg = mean(withRates.map((r) => r.winrate));
    const winrateSd = stddev(withRates.map((r) => r.winrate), winrateAvg);
    const goalsAvg = mean(withRates.map((r) => r.goalsPerGame));
    const goalsSd = stddev(withRates.map((r) => r.goalsPerGame), goalsAvg);
    const assistsAvg = mean(withRates.map((r) => r.assistsPerGame));
    const assistsSd = stddev(withRates.map((r) => r.assistsPerGame), assistsAvg);
    const csAvg = mean(withRates.map((r) => r.csPerGame));
    const csSd = stddev(withRates.map((r) => r.csPerGame), csAvg);

    return withRates.map((r) => {
        const winrateZ = zScore(r.winrate, winrateAvg, winrateSd);
        const skillZ = mean([
            zScore(r.goalsPerGame, goalsAvg, goalsSd),
            zScore(r.assistsPerGame, assistsAvg, assistsSd),
            zScore(r.csPerGame, csAvg, csSd),
        ]);
        const composite = WINRATE_WEIGHT * winrateZ + SKILL_WEIGHT * skillZ;
        const elo = Math.min(MAX_ELO, Math.max(MIN_ELO, Math.round(BASELINE + composite * SPREAD)));
        return { auth: r.auth, playerName: r.playerName, games: r.games, winrate: r.winrate, elo };
    });
}

async function run({ db, dryRun }) {
    const rows = await db.getPlayerStatsForSeed(MIN_GAMES);
    if (rows.length === 0) {
        console.log(`No players with >= ${MIN_GAMES} games yet — nothing to seed.`);
        return [];
    }
    const seeded = computeSeedRatings(rows);
    for (const p of seeded) {
        console.log(`${p.playerName.padEnd(20)} games=${p.games} winrate=${(p.winrate * 100).toFixed(1)}% -> ELO ${p.elo}`);
        if (!dryRun) await db.setEloRating(p.auth, p.elo);
    }
    console.log(dryRun
        ? `\n--dry-run: ${seeded.length} player(s) computed, nothing written.`
        : `\n${seeded.length} player(s) seeded. Everyone else stays at the default ${BASELINE}.`);
    return seeded;
}

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    const db = createDatabaseApi();
    db.init();
    run({ db, dryRun }).finally(() => db.close());
}

module.exports = { computeSeedRatings, run, MIN_GAMES, BASELINE, SPREAD, MIN_ELO, MAX_ELO };
