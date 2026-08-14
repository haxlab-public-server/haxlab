/*
 * Formats one player's stat block, and the !tops/!top leaderboards, for
 * chat. Both only ever need `db` + `getTimeStats` (no `room`/`state`), which
 * is exactly why this module is shared as-is between the room (see
 * stats/roomStats.js's printRankings/printAllRankings) and the Discord bot's
 * own process (see discordProcess.js), which has no `room`/`state` to give
 * a full stats/roomStats.js factory instantiation.
 */
const STAT_LABELS = { games: 'Игры', wins: 'Победы', goals: 'Голы', assists: 'Ассисты', CS: 'Сухие матчи', playtime: 'Время игры' };
const CLUB_STAT_LABEL = 'Клубы';

// Every category !tops/`/tops` can show, in display order. Exported (not
// just a local const) so core/bff/roomStats.js can build its own combined
// view (player stats + rating, no clubs) without duplicating this list.
const RANKING_STAT_KEYS = ['games', 'wins', 'goals', 'assists', 'CS', 'playtime'];

// One leaderboard's formatted line, or null if fewer than 5 players have any
// stats yet (the same quorum every individual category always required) —
// null rather than throwing, so a combined "show everything" view (see
// buildAllRankingsText below) can just skip whichever categories aren't
// ready instead of erroring the whole thing.
async function buildRankingString(db, getTimeStats, statKey) {
    const key = statKey == 'cs' ? 'CS' : statKey;
    const leaderboard = await db.getLeaderboard(key, 5);
    if (leaderboard.length < 5) return null;
    let rankingString = `${STAT_LABELS[key] ?? key}> `;
    for (let i = 0; i < 5; i++) {
        let playerName = leaderboard[i].playerName;
        let playerStat = leaderboard[i].value;
        if (key == 'playtime') playerStat = getTimeStats(playerStat);
        rankingString += `#${i + 1} ${playerName} : ${playerStat}, `;
    }
    return rankingString.substring(0, rankingString.length - 2);
}

// BFF-only leaderboard (see core/bff/rating.js/dbBridge.js) — the main
// room's db never has any rows in rating_mu/rating_sigma, so
// db.getRatingLeaderboard always comes back empty there and this always
// returns null; harmless, just never shows up in the main room's !tops.
// Same 5-player quorum as buildRankingString, for the same reason (an
// early leaderboard with 1-2 entries looks artificially prestigious).
async function buildRatingRankingString(db) {
    const leaderboard = await db.getRatingLeaderboard(5);
    if (leaderboard.length < 5) return null;
    let rankingString = `Рейтинг> `;
    for (let i = 0; i < 5; i++) {
        rankingString += `#${i + 1} ${leaderboard[i].playerName} : ${Math.round(leaderboard[i].ordinal)}, `;
    }
    return rankingString.substring(0, rankingString.length - 2);
}

// !tops clubs — ranks clubs by combined goals+assists+clean_sheets (each
// weighted equally, see db.getTopClubs), NOT the 5-quorum player
// leaderboards require: clubs are coin-gated and far scarcer than players,
// so demanding 5 of them would make this near-useless in a typical room.
// null only when literally no club has scored anything yet.
async function buildClubRankingString(db) {
    const topClubs = await db.getTopClubs(5);
    if (topClubs.length === 0) return null;
    let rankingString = `${CLUB_STAT_LABEL}> `;
    topClubs.forEach((club, i) => {
        const tag = `${club.emoji ?? ''}${club.prefix}`;
        rankingString += `#${i + 1} [${tag}] ${club.name} : ${club.score} (${club.goals}г/${club.assists}а/${club.cleanSheets}с), `;
    });
    return rankingString.substring(0, rankingString.length - 2);
}

// Every category in one block, skipping any that don't have the 5-player
// quorum yet (or, for clubs, don't have any score at all) — null (not an
// error) if literally none of them do.
async function buildAllRankingsText(db, getTimeStats) {
    const playerLines = await Promise.all(RANKING_STAT_KEYS.map((key) => buildRankingString(db, getTimeStats, key)));
    const clubLine = await buildClubRankingString(db);
    const lines = [...playerLines, clubLine].filter((line) => line != null);
    return lines.length > 0 ? lines.join('\n') : null;
}

module.exports = function createPrintStats({
    getTimeStats,
    db,
}) {
    async function printPlayerStats(stats) {
        const goalsRank = await db.getStatRank('goals', stats.goals);
        const assistsRank = await db.getStatRank('assists', stats.assists);
        const csRank = await db.getStatRank('CS', stats.CS);
        const playtimeRank = await db.getStatRank('playtime', stats.playtime);
        let text = `${stats.playerName} ` +
            `[🏆 ${stats.winrate} побед, 🕹️ ${stats.games} игр] ` +
            `[🏅 Ранг по голам: ${goalsRank.rank}/${goalsRank.total}(${stats.goals}), ` +
            `ассистам: ${assistsRank.rank}/${assistsRank.total}(${stats.assists}), ` +
            `сухим матчам: ${csRank.rank}/${csRank.total}(${stats.CS}), ` +
            `времени игры: ${playtimeRank.rank}/${playtimeRank.total}(${getTimeStats(stats.playtime)})]`;
        // BFF-only (see core/bff/rating.js) — the main room never sets this
        // field on the stats object it passes in, so this stays 100%
        // unchanged there. Rounded for display; the DB keeps the real
        // precision for actual balancing.
        if (stats.ratingOrdinal != null) {
            text += ` [⚔️ Рейтинг: ${Math.round(stats.ratingOrdinal)}]`;
        }
        return text;
    }

    return {
        printPlayerStats,
    };
};

module.exports.buildRankingString = buildRankingString;
module.exports.buildAllRankingsText = buildAllRankingsText;
module.exports.buildClubRankingString = buildClubRankingString;
module.exports.buildRatingRankingString = buildRatingRankingString;
module.exports.RANKING_STAT_KEYS = RANKING_STAT_KEYS;
