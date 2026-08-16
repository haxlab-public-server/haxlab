/*
 * Formats one player's stat block, and the !tops/!top leaderboards, for
 * chat. Both only ever need `db` + `getTimeStats` (no `room`/`state`), which
 * is exactly why this module is shared as-is between the room (see
 * stats/roomStats.js's printRankings/printAllRankings) and the Discord bot's
 * own process (see discordProcess.js), which has no `room`/`state` to give
 * a full stats/roomStats.js factory instantiation.
 */
const { formatRatingDisplay, formatRankPrefix } = require('../utils');

const STAT_LABELS = { games: 'Игры', wins: 'Победы', goals: 'Голы', assists: 'Ассисты', CS: 'Сухие матчи', playtime: 'Время игры', elo: 'ELO' };
const CLUB_STAT_LABEL = 'Клубы';

// Every category !tops/`/tops` can show, in display order. Exported (not
// just a local const) so core/bff/roomStats.js can build its own combined
// view (player stats + rating, no clubs) without duplicating this list.
// 'elo' is deliberately NOT in this list, same reasoning as BFF's rating
// being kept out too (see buildRatingRankingString's own comment below):
// player_stats' elo_rating column is shared schema, but BFF never writes to
// it, so every row would sit at the flat DEFAULT 1000 there — including it
// here would make it show up (meaninglessly) in BFF's own combined !tops
// view too, since that view iterates this exact same shared list against
// its own db. buildEloRankingString/buildEloLeaderLine below are the
// main-room-only equivalent of buildRatingRankingString/buildRatingLeaderLine.
const RANKING_STAT_KEYS = ['games', 'wins', 'goals', 'assists', 'CS', 'playtime'];

// One leaderboard's formatted line, or null if fewer than 5 players have any
// stats yet (the same quorum every individual category always required) —
// null rather than throwing, so a combined "show everything" view (see
// buildAllRankingsText below) can just skip whichever categories aren't
// ready instead of erroring the whole thing. Top-3 positions get a medal
// (formatRankPrefix) instead of a bare "#1"/"#2"/"#3" (requested
// 2026-08-16, same medal set !trophy already uses).
//
// `auth`, if given, is the asking player's own — when they're not already
// in the shown top-5, a second line reports their real position (also
// requested 2026-08-16: the leaderboard used to be a dead end for anyone
// not already on it). Silently skipped if they have no player_stats row at
// all yet (nothing to rank).
async function buildRankingString(db, getTimeStats, statKey, auth) {
    const key = statKey == 'cs' ? 'CS' : statKey;
    const leaderboard = await db.getLeaderboard(key, 5);
    if (leaderboard.length < 5) return null;
    // ⭐ next to a currently-VIP entry's name (requested 2026-08-16) — one
    // extra getVips() round trip per render, same "cheap enough for a
    // chat command" tradeoff as the getStatRank/getPlayerStats calls below.
    // getVips() itself sweeps expired grants, so this is always live, never
    // a stale badge on a grant that already lapsed.
    const vipAuths = new Set((await db.getVips()).map((v) => v.auth));
    let rankingString = `${STAT_LABELS[key] ?? key}> `;
    for (let i = 0; i < 5; i++) {
        let playerName = leaderboard[i].playerName;
        let playerStat = leaderboard[i].value;
        if (key == 'playtime') playerStat = getTimeStats(playerStat);
        const vipBadge = vipAuths.has(leaderboard[i].auth) ? '⭐' : '';
        rankingString += `${formatRankPrefix(i + 1)} ${vipBadge}${playerName} : ${playerStat}, `;
    }
    rankingString = rankingString.substring(0, rankingString.length - 2);
    if (auth && !leaderboard.some((row) => row.auth === auth)) {
        const stats = await db.getPlayerStats(auth);
        if (stats) {
            const rankInfo = await db.getStatRank(key, stats[key]);
            if (rankInfo.total > 0) {
                rankingString += `\nТы: #${rankInfo.rank} из ${rankInfo.total}`;
            }
        }
    }
    return rankingString;
}

// BFF-only leaderboard (see core/bff/rating.js/dbBridge.js) — the main
// room's db never has any rows in rating_mu/rating_sigma, so
// db.getRatingLeaderboard always comes back empty there and this always
// returns null; harmless, just never shows up in the main room's !tops.
// Same 5-player quorum as buildRankingString, for the same reason (an
// early leaderboard with 1-2 entries looks artificially prestigious). Same
// medal/self-position treatment as buildRankingString above — no dedicated
// "rating rank" SQL query exists, so this fetches the WHOLE rated
// leaderboard and finds the caller's own index instead; fine at BFF's
// actual scale (room cap is 14 concurrent players, see roomConstants.js).
async function buildRatingRankingString(db, auth) {
    const leaderboard = await db.getRatingLeaderboard(5);
    if (leaderboard.length < 5) return null;
    const vipAuths = new Set((await db.getVips()).map((v) => v.auth));
    let rankingString = `Рейтинг> `;
    for (let i = 0; i < 5; i++) {
        const vipBadge = vipAuths.has(leaderboard[i].auth) ? '⭐' : '';
        rankingString += `${formatRankPrefix(i + 1)} ${vipBadge}${leaderboard[i].playerName} : ${formatRatingDisplay(leaderboard[i].ordinal)}, `;
    }
    rankingString = rankingString.substring(0, rankingString.length - 2);
    if (auth) {
        const fullLeaderboard = await db.getRatingLeaderboard(9999);
        const index = fullLeaderboard.findIndex((row) => row.auth === auth);
        if (index >= 5) {
            rankingString += `\nТы: #${index + 1} из ${fullLeaderboard.length}`;
        }
    }
    return rankingString;
}

// Condensed, leader-only versions of the three builders above — real bug
// fixed 2026-08-15 ("!tops страдает той же болезнью полотна текста, что и
// магазин"): the combined "!tops" (no argument) view used to join EVERY
// category's full top-5 line together, easily 6-7 lines each five names
// wide — unreadable in HaxBall's small chat window. The combined view now
// shows just the #1 leader per category (one line each); the full top-5
// per category is still exactly one `!tops <category>` away, via
// buildRankingString/buildRatingRankingString/buildClubRankingString
// above, completely unchanged. Same 5-player (or, for clubs, "any score at
// all") quorum as their full counterparts, so a category with too little
// data still gets skipped the same way.
async function buildTopLeaderLine(db, getTimeStats, statKey) {
    const key = statKey == 'cs' ? 'CS' : statKey;
    const leaderboard = await db.getLeaderboard(key, 5);
    if (leaderboard.length < 5) return null;
    let value = leaderboard[0].value;
    if (key == 'playtime') value = getTimeStats(value);
    return `${STAT_LABELS[key] ?? key}: ${leaderboard[0].playerName} (${value})`;
}

async function buildRatingLeaderLine(db) {
    const leaderboard = await db.getRatingLeaderboard(5);
    if (leaderboard.length < 5) return null;
    return `Рейтинг: ${leaderboard[0].playerName} (${formatRatingDisplay(leaderboard[0].ordinal)})`;
}

// Main-room-only ELO leaderboard (see stats/elo.js) — kept OUT of
// RANKING_STAT_KEYS for the exact reason buildRatingRankingString above is:
// the underlying column is shared schema but only meaningfully populated on
// one side, so a generic inclusion would leak a flat, meaningless "everyone
// is 1000" leaderboard into the other room's own combined !tops view. Same
// 5-player quorum and medal/self-position treatment as every other
// leaderboard builder here — no rescale needed (classic ELO is already in
// human-readable ~1000-point units, unlike BFF's openskill ordinal).
async function buildEloRankingString(db, auth) {
    const leaderboard = await db.getLeaderboard('elo', 5);
    if (leaderboard.length < 5) return null;
    const vipAuths = new Set((await db.getVips()).map((v) => v.auth));
    let rankingString = `ELO> `;
    for (let i = 0; i < 5; i++) {
        const vipBadge = vipAuths.has(leaderboard[i].auth) ? '⭐' : '';
        rankingString += `${formatRankPrefix(i + 1)} ${vipBadge}${leaderboard[i].playerName} : ${leaderboard[i].value}, `;
    }
    rankingString = rankingString.substring(0, rankingString.length - 2);
    if (auth && !leaderboard.some((row) => row.auth === auth)) {
        const rankInfo = await db.getStatRank('elo', (await db.getPlayerStats(auth))?.elo ?? 1000);
        if (rankInfo.total > 0) {
            rankingString += `\nТы: #${rankInfo.rank} из ${rankInfo.total}`;
        }
    }
    return rankingString;
}

async function buildEloLeaderLine(db) {
    const leaderboard = await db.getLeaderboard('elo', 5);
    if (leaderboard.length < 5) return null;
    return `ELO: ${leaderboard[0].playerName} (${leaderboard[0].value})`;
}

async function buildClubLeaderLine(db) {
    const topClubs = await db.getTopClubs(1);
    if (topClubs.length === 0) return null;
    const club = topClubs[0];
    const tag = `${club.emoji ?? ''}${club.prefix}`;
    return `${CLUB_STAT_LABEL}: [${tag}] ${club.name} (${club.score})`;
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
        rankingString += `${formatRankPrefix(i + 1)} [${tag}] ${club.name} : ${club.score} (${club.goals}г/${club.assists}а/${club.cleanSheets}с), `;
    });
    return rankingString.substring(0, rankingString.length - 2);
}

// Every category in one block, skipping any that don't have the 5-player
// quorum yet (or, for clubs, don't have any score at all) — null (not an
// error) if literally none of them do. Leader-only per category (see
// buildTopLeaderLine's own comment) — the full top-5 for any one category
// is a `!tops <category>` away, pointed at explicitly in the trailing hint
// line so it isn't a dead end.
//
// `extraLines`/`extraCategories` let a caller (main room's roomStats.js —
// see printAllRankings) fold in a room-specific leader line (ELO) BEFORE
// the hint, not after the whole block — real bug fixed 2026-08-17: the
// caller used to just append its own eloLine after this function's already-
// complete return value, which put the "full table" hint ABOVE the ELO
// line instead of below it. BFF's own printAllRankings (core/bff/roomStats.js)
// never had this bug — it builds its rating line into the SAME lines array
// before adding the hint, which is exactly the pattern this now matches.
async function buildAllRankingsText(db, getTimeStats, { extraLines = [], extraCategories = [] } = {}) {
    const playerLines = await Promise.all(RANKING_STAT_KEYS.map((key) => buildTopLeaderLine(db, getTimeStats, key)));
    const clubLine = await buildClubLeaderLine(db);
    const lines = [...playerLines, clubLine, ...extraLines].filter((line) => line != null);
    if (lines.length === 0) return null;
    const categories = [...RANKING_STAT_KEYS.map((k) => k.toLowerCase()), 'clubs', ...extraCategories];
    return `${lines.join('\n')}\nПолная таблица по категории: !tops <${categories.join('|')}>`;
}

module.exports = function createPrintStats({
    getTimeStats,
    db,
}) {
    // getStatRank's own SQL (db/sqlite.js) computes rank as COUNT(rows
    // exceeding this value) + 1 — when the whole table has zero rows
    // (total === 0), that COUNT can only ever be 0 too, so rank always
    // comes back exactly 1. Displaying that raw as "1/0" reads as a real
    // rank ("1st of 0") instead of what it actually means: nobody in this
    // room has any qualifying data yet. Real bug fixed 2026-08-14 — first
    // hit in BFF (a brand new room, so player_stats starts genuinely
    // empty), but the underlying getStatRank behavior is shared with the
    // main room too, just never empty enough there to show it.
    function formatRank(rankInfo) {
        return rankInfo.total === 0 ? '—' : `${rankInfo.rank}/${rankInfo.total}`;
    }

    // Multi-line layout (requested 2026-08-17 — the original single "Name
    // [bracket] [bracket] [bracket]" line read as one dense run-on
    // sentence). Same substrings as before (rank/value pairs, labels),
    // just grouped onto their own lines instead of comma-joined inside
    // brackets — identity, then volume, then per-category ranks, then
    // room-specific rating lines (BFF's ratingOrdinal / main room's ELO),
    // each opt-in field still only appearing when the caller actually set it.
    async function printPlayerStats(stats) {
        const goalsRank = await db.getStatRank('goals', stats.goals);
        const assistsRank = await db.getStatRank('assists', stats.assists);
        const csRank = await db.getStatRank('CS', stats.CS);
        const playtimeRank = await db.getStatRank('playtime', stats.playtime);
        // ⭐ prefix for a current VIP (requested 2026-08-16) — same idea as
        // ratingOrdinal below: an optional field the caller attaches to the
        // stats object right before calling this, not derived here (this
        // module deliberately has no `getRole`/`room` access at all — see
        // this file's own header comment).
        const vipBadge = stats.isVip ? '⭐ ' : '';
        const lines = [
            `${vipBadge}${stats.playerName}`,
            `🏆 ${stats.winrate} побед · 🕹️ ${stats.games} игр`,
            `🏅 Голы ${formatRank(goalsRank)}(${stats.goals}) · ` +
            `Ассисты ${formatRank(assistsRank)}(${stats.assists}) · ` +
            `Сухие ${formatRank(csRank)}(${stats.CS}) · ` +
            `Время ${formatRank(playtimeRank)}(${getTimeStats(stats.playtime)})`,
        ];
        // BFF-only (see core/bff/rating.js) — the main room never sets this
        // field on the stats object it passes in, so this stays 100%
        // unchanged there. Rounded for display; the DB keeps the real
        // precision for actual balancing.
        if (stats.ratingOrdinal != null) {
            lines.push(`⚔️ Рейтинг: ${formatRatingDisplay(stats.ratingOrdinal)}`);
        }
        // Main-room-only ELO (see stats/elo.js), same ad-hoc opt-in pattern
        // as ratingOrdinal above — deliberately a SEPARATE field from
        // stats.elo itself, which the shared player_stats row always
        // carries (a BFF player's row has it too, flat at the DEFAULT 1000,
        // never written there): using presence of stats.elo directly as the
        // "show this" signal would leak a meaningless "ELO: 1000" line into
        // BFF's own !me. Only commands/player.js's globalStatsCommand ever
        // sets eloDisplay.
        if (stats.eloDisplay != null) {
            const eloRank = await db.getStatRank('elo', stats.eloDisplay);
            // lastMatchRating (core/stats/analytics/'s 0-10 per-match score,
            // requested 2026-08-17) rides along in parentheses right after
            // ELO — null when they've never had a match analyzed yet, so it
            // just doesn't show rather than printing "(null)".
            const ratingSuffix = stats.lastMatchRating != null ? ` (${stats.lastMatchRating.toFixed(1)})` : '';
            lines.push(`🎯 ELO ${stats.eloDisplay}${ratingSuffix} · ранг ${formatRank(eloRank)}`);
        }
        return lines.join('\n');
    }

    return {
        printPlayerStats,
    };
};

module.exports.buildRankingString = buildRankingString;
module.exports.buildTopLeaderLine = buildTopLeaderLine;
module.exports.buildAllRankingsText = buildAllRankingsText;
module.exports.buildClubRankingString = buildClubRankingString;
module.exports.buildRatingRankingString = buildRatingRankingString;
module.exports.buildRatingLeaderLine = buildRatingLeaderLine;
module.exports.buildEloRankingString = buildEloRankingString;
module.exports.buildEloLeaderLine = buildEloLeaderLine;
module.exports.RANKING_STAT_KEYS = RANKING_STAT_KEYS;
module.exports.STAT_LABELS = STAT_LABELS;
