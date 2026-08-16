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
// The amount itself is grouped with 'ru-RU' thousands separators (requested
// 2026-08-16 — some shop items price into the tens of thousands, e.g.
// shopItems.js's smoke/fireworks/blackhole, hard to read as one long run of
// digits). Uses a real non-breaking space (U+00A0, what 'ru-RU' actually
// produces), not a plain ASCII one — matters if anything ever regex-matches
// this output looking for a literal " ".
function formatCoins(amount) {
    const mod10 = amount % 10;
    const mod100 = amount % 100;
    let word;
    if (mod10 === 1 && mod100 !== 11) word = 'монетка';
    else if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) word = 'монетки';
    else word = 'монеток';
    return `${amount.toLocaleString('ru-RU')} ${word}`;
}

// Medal for a top-3 leaderboard position, "#N" otherwise — same 🥇🥈🥉 set
// formatTrophyLabel's own TROPHY_MEDALS already uses, reused here (not
// re-defined) so a rank-1 medal always means the same thing everywhere it
// appears. Requested 2026-08-16 for !tops' own leaderboard lines, which
// used to be bare "#1"/"#2"/etc. for every position, top-3 included.
function formatRankPrefix(rank) {
    return TROPHY_MEDALS[rank] ?? `#${rank}`;
}

// BFF's rating (core/bff/rating.js's computeOrdinal) is openskill's own
// ordinal = mu - 3*sigma, using the library's default constants (mu=25,
// sigma=25/3) — so a brand new player's ordinal is EXACTLY 0, and it only
// creeps into single digits over the first few games as sigma shrinks.
// Mathematically correct (it's a deliberately pessimistic mu-minus-3-sigma
// estimate, not a bug), but reads as broken next to the "starts around
// 1000" ELO/chess-rating convention everyone actually expects (reported
// live 2026-08-16: "у людей по 5-3 ело"). Purely a DISPLAY rescale — never
// touches the stored mu/sigma, matchmaking (assignBalancedTeams runs on the
// raw rating objects), or rating updates (updateRatingsAfterMatch likewise)
// — just where an ordinal value is about to be shown to a player. Linear,
// so a delta computed by subtracting two already-transformed values is
// still exactly right (see matchFlow.js's own post-match delta message).
const RATING_DISPLAY_BASELINE = 1000;
const RATING_DISPLAY_SCALE = 20;
function formatRatingDisplay(ordinal) {
    return Math.round(RATING_DISPLAY_BASELINE + ordinal * RATING_DISPLAY_SCALE);
}

// Small progress indicator for a bounded counter (e.g. !up's daily-use cap
// — requested 2026-08-16). Filled/hollow circles rather than the block
// characters (▓░) this originally used — those rendered badly in HaxBall's
// own chat font; ●/○ is the much more standard, widely-supported choice for
// this exact kind of indicator. `max` doubles as the bar's width in
// characters, so this is only meant for small, human-scale limits (single
// digits) — not a general-purpose N-of-M renderer for arbitrary large M.
function renderProgressBar(current, max) {
    const filled = '●'.repeat(Math.max(0, Math.min(current, max)));
    const empty = '○'.repeat(Math.max(0, max - current));
    return `${filled}${empty} ${current}/${max}`;
}

// Win-streak display (requested 2026-08-16) — below 3 it's just the plain
// "Текущая серия: N" wording both rooms already used; from 3 up it gets a
// 🔥 escalation instead, since a 2-game "streak" barely means anything but a
// long one is worth calling out visually.
function formatStreakText(streak) {
    if (streak < 3) return `Текущая серия: ${streak}`;
    const fire = streak >= 10 ? '🔥🔥🔥' : streak >= 5 ? '🔥🔥' : '🔥';
    return `${fire} Серия: ${streak}`;
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
    formatRatingDisplay,
    formatRankPrefix,
    renderProgressBar,
    formatStreakText,
    formatTrophyLabel,
    parseEquippedTrophy,
    encodeLegacyTrophyKey,
    resolveTrophyRank,
};
