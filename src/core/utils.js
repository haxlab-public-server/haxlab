function getDate() {
    let d = new Date();
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
}

function getRandomInt(max) {
    return Math.floor(Math.random() * Math.floor(max));
}

function pointDistance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

function getHoursStats(time) {
    return Math.floor(time / 3600);
}

function getMinutesGame(time) {
    const t = Math.floor(time / 60);
    return `${Math.floor(t / 10)}${Math.floor(t % 10)}`;
}

function getMinutesReport(time) {
    return Math.floor(Math.round(time) / 60);
}

function getMinutesEmbed(time) {
    const t = Math.floor(Math.round(time) / 60);
    return `${Math.floor(t / 10)}${Math.floor(t % 10)}`;
}

function getMinutesStats(time) {
    return Math.floor(time / 60) - getHoursStats(time) * 60;
}

function getSecondsGame(time) {
    const t = Math.floor(time - Math.floor(time / 60) * 60);
    return `${Math.floor(t / 10)}${Math.floor(t % 10)}`;
}

function getSecondsReport(time) {
    const t = Math.round(time);
    return Math.floor(t - getMinutesReport(t) * 60);
}

function getSecondsEmbed(time) {
    const t = Math.round(time);
    const t2 = Math.floor(t - Math.floor(t / 60) * 60);
    return `${Math.floor(t2 / 10)}${Math.floor(t2 % 10)}`;
}

function getTimeGame(time) {
    return `[${getMinutesGame(time)}:${getSecondsGame(time)}]`;
}

function getTimeEmbed(time) {
    return `[${getMinutesEmbed(time)}:${getSecondsEmbed(time)}]`;
}

function getTimeStats(time) {
    if (getHoursStats(time) > 0) {
        return `${getHoursStats(time)}h${getMinutesStats(time)}m`;
    }
    return `${getMinutesStats(time)}m`;
}

function findFirstNumberCharString(str) {
    let strNumber = str[str.search(/[0-9]/g)];
    return strNumber === undefined ? '0' : strNumber;
}

// Not meant to be cryptographically strong — just short, easy to type/share
// in Discord, and not literally guessable. ~8 base36 characters (digits + lowercase).
function generateRoomPassword() {
    return Math.random().toString(36).slice(2, 10);
}

// Shared by the room-side (!banauth/!ban/!authbans) and Discord-side
// (!banauth//banauth//authbans) ban commands so both report remaining time
// the same way. Rounds up so "1 minute left" never reads as "0 минут".
function formatBanRemaining(expiresAt) {
    if (!expiresAt) return 'навсегда';
    const minutesLeft = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60000));
    return `${minutesLeft} мин.`;
}

// Same rounding-up reasoning as formatBanRemaining, but in days — used by
// !setvip/!vips (see commands/master.js), which grant VIP for a number of
// days rather than minutes.
function formatVipRemaining(expiresAt) {
    if (!expiresAt) return 'навсегда';
    const daysLeft = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60000)));
    return `${daysLeft} дн.`;
}

// Russian noun pluralization for the coin economy (!shop/!inventory/etc.) —
// монетка (1, 21, 31...), монетки (2-4, 22-24...), монеток (0, 5-20, 25-30...).
function formatCoins(amount) {
    const mod10 = amount % 10;
    const mod100 = amount % 100;
    let word;
    if (mod10 === 1 && mod100 !== 11) word = 'монетка';
    else if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) word = 'монетки';
    else word = 'монеток';
    return `${amount} ${word}`;
}

const TROPHY_MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

// `trophies` is constants.js's Trophies map (category -> stat-name
// fragment, e.g. { goals: 'голов', ... }); `rank` is the player's ACTUAL
// current position (1-3) in that category. `season` is always shown (see
// commands/trophies.js) — S0, S1, ... — so a frozen past-season title (see
// resolveTrophyRank below) reads distinctly from a live current-season one
// even when the category/rank happen to match.
function formatTrophyLabel(trophies, category, rank, season) {
    return `${TROPHY_MEDALS[rank]}Топ-${rank} ${trophies[category]} S${season}`;
}

// commands/trophies.js stores a player's !trophy pick as either a bare
// category ("goals" — the LIVE current-season standing, re-checked every
// render against state.topPlayers) or "legacy:<season>:<category>" (a
// specific already-CLOSED season's frozen result, read from
// state.seasonTrophies instead — see db.closeSeason/getSeasonTrophies).
// Returns null for an empty/missing key.
function parseEquippedTrophy(key) {
    if (!key) return null;
    const match = /^legacy:(\d+):(.+)$/.exec(key);
    return match ? { legacy: true, season: Number(match[1]), category: match[2] } : { legacy: false, category: key };
}

function encodeLegacyTrophyKey(season, category) {
    return `legacy:${season}:${category}`;
}

// Resolves a stored !trophy pick (see parseEquippedTrophy) to the actual
// { season, category, rank } to display right now — or null if it no longer
// applies (a live pick the player has since fallen out of top-3 for) or
// never applied (a legacy pick for a season/category/auth combo with no
// matching row at all). Shared by commands/trophies.js (the !trophy summary)
// and events/activity.js (the per-message chat prefix) so the two can never
// disagree on what a given equipped_trophy value currently means.
function resolveTrophyRank(key, auth, currentSeason, topPlayers, seasonTrophies) {
    const parsed = parseEquippedTrophy(key);
    if (!parsed) return null;
    if (!parsed.legacy) {
        const index = (topPlayers[parsed.category] ?? []).findIndex((e) => e.auth === auth);
        return index === -1 ? null : { season: currentSeason, category: parsed.category, rank: index + 1 };
    }
    const row = seasonTrophies.find((t) => t.season === parsed.season && t.category === parsed.category && t.auth === auth);
    return row ? { season: row.season, category: row.category, rank: row.rank } : null;
}

module.exports = {
    getDate,
    getRandomInt,
    pointDistance,
    getHoursStats,
    getMinutesGame,
    getMinutesReport,
    getMinutesEmbed,
    getMinutesStats,
    getSecondsGame,
    getSecondsReport,
    getSecondsEmbed,
    getTimeGame,
    getTimeEmbed,
    getTimeStats,
    findFirstNumberCharString,
    generateRoomPassword,
    formatBanRemaining,
    formatVipRemaining,
    formatCoins,
    formatTrophyLabel,
    parseEquippedTrophy,
    encodeLegacyTrophyKey,
    resolveTrophyRank,
};
