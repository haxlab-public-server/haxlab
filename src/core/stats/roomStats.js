/*
 * Persists per-player stats to the database after a game and prints leaderboards.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
const { buildRankingString, buildAllRankingsText, buildClubRankingString, buildEloRankingString, buildEloLeaderLine, STAT_LABELS } = require('./print');
const { INITIAL_ELO, computeEloDelta } = require('./elo');
// Only the neutral fallback constant, not any class — keeps a player with
// no computed rating this match (e.g. analyzeMatch failed) landing at
// exactly the "no individual adjustment" value MatchRatingDetector itself
// centers a solid, unremarkable game on, rather than a second hardcoded 6.5.
const { RATING_BASELINE } = require('./analytics/detectors/MatchRatingDetector');

// How much a player's OWN per-match rating (core/stats/analytics/'s 0-10
// score, requested 2026-08-17) pulls their ELO delta away from their team's
// flat share of the team-level exchange below — see updateStats()'s own doc
// comment for the full reasoning. A player 2 rating points above their
// team's own match average (a big, genuinely notable spread) gets +/-8 ELO
// on top of the team's shared delta — a meaningful but not dominant swing
// next to K_FACTOR=32's own max per-match range.
const RATING_INFLUENCE = 4;

// !tops categories a fresh top-5 entry is worth privately pinging a player
// about (requested 2026-08-16) — same 6 columns !tops/voteBan.js's own
// protected-top-3 already use (db/sqlite.js's LEADERBOARD_COLUMNS).
const RANK_PING_CATEGORIES = ['games', 'wins', 'goals', 'assists', 'CS', 'playtime'];
// Same 5-player quorum buildRankingString's own top-5 tables require before
// showing anything real — a ping before that many players even have a stats
// row would be meaningless ("congrats, you're #1 of 2").
const RANK_PING_QUORUM = 5;

// Compares each changed stat's rank BEFORE this match's increment against
// AFTER, and privately pings the player the moment one of them crosses from
// outside the top 5 into it. `before`/`after` are the same 6 columns, read
// straight off the HaxStatistics object pre/post-increment — no separate
// DB round trip needed for the "did it even change" check.
async function announceTopFiveEntries(room, db, HaxNotification, achievementColor, player, before, after) {
    for (const key of RANK_PING_CATEGORIES) {
        if (before[key] === after[key]) continue;
        const { rank: oldRank, total } = await db.getStatRank(key, before[key]);
        if (total < RANK_PING_QUORUM || oldRank <= 5) continue;
        const { rank: newRank } = await db.getStatRank(key, after[key]);
        if (newRank > 5) continue;
        room.sendAnnouncement(
            `📈 Ты теперь в топ-5 по категории «${STAT_LABELS[key]}» !`,
            player.id,
            achievementColor,
            'bold',
            // MENTION (requested 2026-08-16), not the usual CHAT — a rare
            // personal achievement deserves the louder ping, same reasoning
            // as achievementColor's own distinct color.
            HaxNotification.MENTION
        );
    }
}

module.exports = function createRoomStats({
    room,
    state,
    Team,
    authArray,
    db,
    HaxStatistics,
    HaxNotification,
    errorColor,
    infoColor,
    announcementColor,
    achievementColor,
    teamSize,
    getAssistsPlayer,
    getCSPlayer,
    getGametimePlayer,
    getGoalsPlayer,
    getOwnGoalsPlayer,
    getPlayerComp,
    getTimeStats,
    applyVipGrant,
    random,
}) {
    const GAMES_MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000];

    // Each player on the WINNING side of a genuine full 4v4 quals match
    // (same gate updateStats() already requires below) gets an independent
    // 0.5% roll at a week of VIP — a fun rare bonus, not a grind reward like
    // the coin economy. Draws never roll at all (nobody "won"). A player
    // who's already VIP just quietly doesn't win again (see rollVipLottery)
    // rather than stacking or extending — same "already VIP" no-op every
    // other grant path (commands/master.js's setVipCommand/grantVipByAuth)
    // already treats as a dead end, not an error.
    //
    // `random` is injected (entry.js passes Math.random) rather than called
    // directly, specifically so tests can substitute a deterministic
    // function instead of monkey-patching the actual global Math.random —
    // this file's own tests run as interleaved, unawaited async blocks (see
    // tools/smoke-test.js), so temporarily replacing a REAL global here
    // would risk leaking into some other, unrelated test's randomness
    // mid-await.
    const VIP_LOTTERY_CHANCE = 0.005;
    const VIP_LOTTERY_DAYS = 3;

    // Russian day-count pluralization (день/дня/дней) — was hardcoded
    // "дней" before, which only ever happened to be correct because 7
    // (the old VIP_LOTTERY_DAYS) needs "дней" too; 3 needs "дня" instead,
    // so this stopped being a coincidence-proof shortcut the moment the
    // duration changed. Same mod10/mod100 shape as utils.js's own
    // formatCoins pluralization.
    function pluralizeDays(n) {
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11) return 'день';
        if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'дня';
        return 'дней';
    }

    async function rollVipLottery(player) {
        if (random() >= VIP_LOTTERY_CHANCE) return;
        const auth = authArray[player.id][0];
        if (state.vipList.some((v) => v[0] === auth)) return;
        const expiresAt = new Date(Date.now() + VIP_LOTTERY_DAYS * 24 * 60 * 60000).toISOString();
        await applyVipGrant(auth, player.name, expiresAt);
        room.sendAnnouncement(
            `🎰 ${player.name} выиграл(а) VIP на ${VIP_LOTTERY_DAYS} ${pluralizeDays(VIP_LOTTERY_DAYS)} по счастливому билету за победу в матче 4х4 !`,
            null,
            achievementColor,
            'bold',
            HaxNotification.MENTION
        );
    }
    async function updatePlayerStats(player, teamStats, eloDelta = 0) {
        const auth = authArray[player.id][0];
        const pComp = getPlayerComp(player);
        const stats = (await db.getPlayerStats(auth)) ?? new HaxStatistics(player.name);
        const before = { games: stats.games, wins: stats.wins, goals: stats.goals, assists: stats.assists, CS: stats.CS, playtime: stats.playtime };
        stats.games++;
        if (state.lastWinner == teamStats) stats.wins++;
        stats.winrate = ((100 * stats.wins) / (stats.games || 1)).toFixed(1) + `%`;
        const goals = getGoalsPlayer(pComp);
        const assists = getAssistsPlayer(pComp);
        const CS = getCSPlayer(pComp);
        stats.goals += goals;
        stats.assists += assists;
        stats.ownGoals += getOwnGoalsPlayer(pComp);
        stats.CS += CS;
        stats.playtime += getGametimePlayer(pComp);
        stats.elo = (stats.elo ?? INITIAL_ELO) + eloDelta;

        // Must run BEFORE the save below: both getStatRank queries it makes
        // (one for `before[key]`, one for `after[key]`) rely on this
        // player's OWN row in the DB still holding the OLD value (or not
        // existing at all yet) at query time — a stat only ever goes UP in
        // a single match, so that old/absent row is guaranteed <= both
        // thresholds and never miscounts itself as "another player ahead of
        // me". Querying after the save would let a player's own freshly-
        // written new value inflate their own "how many people are ahead of
        // me" count by one.
        await announceTopFiveEntries(room, db, HaxNotification, achievementColor, player, before, stats);

        await db.savePlayerStats(auth, stats);

        // Private post-match ELO feedback — mirrors bff/matchFlow.js's own
        // rating-delta DM (`📊 Рейтинг: ... (+N)`). Skipped for a genuine
        // zero delta (the default `updatePlayerStats` is called with
        // outside updateStats()'s real match-end path, e.g. direct test
        // calls) — a "+0" message would just be noise, not feedback.
        if (eloDelta !== 0) {
            const sign = eloDelta > 0 ? '+' : '';
            room.sendAnnouncement(
                `🎯 ELO: ${stats.elo} (${sign}${eloDelta})`,
                player.id, infoColor, 'bold', HaxNotification.CHAT
            );
        }

        // Round-number games-played milestone (item #24) — deliberately
        // narrow scope (see haxchill-ux-reliability-backlog project memory:
        // flagged as the lower-confidence item of the batch, "more feature
        // than fix"): just a one-line public congratulation on a fixed set
        // of round numbers, nothing stateful beyond the games count
        // player_stats already tracks — no new table, no streak/achievement
        // system. stats.games is POST-increment here, so this fires exactly
        // once, on the exact match that crosses the milestone.
        if (GAMES_MILESTONES.includes(stats.games)) {
            room.sendAnnouncement(
                `🎉 ${stats.playerName} сыграл(а) ${stats.games}-й матч в этой комнате !`,
                null, achievementColor, 'bold', HaxNotification.MENTION
            );
        }

        // !tops clubs (see db.addClubStats) — credited at this same
        // per-match granularity, keyed off CURRENT club membership
        // (state.clubMembers) right now: a player who has since left their
        // club stops contributing to it going forward, but whatever they
        // already earned while a member stays on the club's record — there's
        // no retroactive removal, only no further additions.
        const membership = state.clubMembers.find((m) => m.auth === auth);
        if (membership && (goals > 0 || assists > 0 || CS > 0)) {
            await db.addClubStats(membership.clubId, { goals, assists, cleanSheets: CS });
        }
    }

    // matchRatingsByAuth: Map<auth, 0-10 rating> for THIS match (entry.js's
    // endGame() now runs analyzeMatch() before this and passes its result
    // straight through) — defaults to empty so a caller that never computed
    // ratings (e.g. a test) still gets the old flat-per-team behavior, since
    // every lookup below falls back to RATING_BASELINE (a neutral "no
    // adjustment") when a player's auth isn't in the map.
    async function updateStats(matchRatingsByAuth = new Map()) {
        if (
            state.players.length >= 2 * teamSize &&
            (
                state.game.scores.time >= (5 / 6) * state.game.scores.timeLimit ||
                state.game.scores.red == state.game.scores.scoreLimit ||
                state.game.scores.blue == state.game.scores.scoreLimit
            ) &&
            state.teamRedStats.length >= teamSize && state.teamBlueStats.length >= teamSize
        ) {
            // Team-average ELO exchange, computed ONCE up front from both
            // teams' PRE-match ratings. Must happen before either loop below
            // starts saving — reading Blue's average after Red's loop had
            // already written new values would pick up Red's POST-match ELO
            // instead, silently corrupting the exchange. actualRed uses 0.5
            // for a draw (see state.lastWinner's own "sits outside RED/BLUE
            // on a draw" comment above); computeEloDelta's negation is exact
            // for a draw too, not just a decisive result.
            const redElos = await Promise.all(state.teamRedStats.map(async (p) =>
                (await db.getPlayerStats(authArray[p.id][0]))?.elo ?? INITIAL_ELO));
            const blueElos = await Promise.all(state.teamBlueStats.map(async (p) =>
                (await db.getPlayerStats(authArray[p.id][0]))?.elo ?? INITIAL_ELO));
            const avgRed = redElos.reduce((a, b) => a + b, 0) / redElos.length;
            const avgBlue = blueElos.reduce((a, b) => a + b, 0) / blueElos.length;
            const actualRed = state.lastWinner === Team.RED ? 1 : state.lastWinner === Team.BLUE ? 0 : 0.5;
            const eloDeltaRed = computeEloDelta(avgRed, avgBlue, actualRed);
            const eloDeltaBlue = -eloDeltaRed;

            // Redistributes each TEAM's own total delta by rating deviation
            // from that team's own match-average rating (requested
            // 2026-08-17 — the earlier design conversation's "ELO ~=
            // winrate in a different wrapper" problem: a flat per-team
            // delta means every player on a side gains/loses the exact same
            // ELO no matter how they personally played). Deviations from a
            // group's own mean always sum to zero, so redDeltas/blueDeltas
            // still average out to EXACTLY eloDeltaRed/eloDeltaBlue across
            // each team — the team-level (and therefore population-level)
            // zero-sum exchange computed above is untouched, only WHO within
            // a team gets how much of it changes. A standout individual
            // performance can outweigh RATING_INFLUENCE*(own team's spread)
            // and flip the sign entirely — a poor game in a win can
            // net-lose ELO, a great game in a loss can net-gain it. That's
            // intentional, not a bug.
            function individualDeltas(players, teamDelta) {
                const ratings = players.map((p) => matchRatingsByAuth.get(authArray[p.id][0]) ?? RATING_BASELINE);
                const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;
                return players.map((_, i) => Math.round(teamDelta + RATING_INFLUENCE * (ratings[i] - avgRating)));
            }
            const redDeltas = individualDeltas(state.teamRedStats, eloDeltaRed);
            const blueDeltas = individualDeltas(state.teamBlueStats, eloDeltaBlue);

            for (let i = 0; i < state.teamRedStats.length; i++) {
                await updatePlayerStats(state.teamRedStats[i], Team.RED, redDeltas[i]);
            }
            for (let i = 0; i < state.teamBlueStats.length; i++) {
                await updatePlayerStats(state.teamBlueStats[i], Team.BLUE, blueDeltas[i]);
            }
            // Refreshes the "who currently holds #1" snapshot trophies
            // (commands/trophies.js) and the chat prefix read off of —
            // once per completed match, since that's the only time these
            // stats actually change, not per chat message.
            state.topPlayers = await db.getTopPlayers();

            // VIP lottery (see rollVipLottery above) — only the WINNING
            // side rolls, and only on a genuine decisive result;
            // state.lastWinner sits outside Team.RED/Team.BLUE on a draw
            // (see economy.js's awardMatchCoins), so a draw never rolls.
            if (state.lastWinner === Team.RED || state.lastWinner === Team.BLUE) {
                const winners = state.lastWinner === Team.RED ? state.teamRedStats : state.teamBlueStats;
                for (const player of winners) {
                    await rollVipLottery(player);
                }
            }
        }
    }

    async function printRankings(statKey, id = 0) {
        // Item #2 (requested 2026-08-16) — only resolved for a real asking
        // player (id=0 is the "no specific asker" sentinel default), so
        // buildRankingString's own self-position line only ever shows up
        // for someone who actually asked.
        const auth = id !== 0 ? authArray[id]?.[0] : undefined;
        // 'elo' isn't in RANKING_STAT_KEYS/LEADERBOARD_COLUMNS' generic path
        // on purpose (see buildEloRankingString's own comment — kept out so
        // it never leaks into BFF's combined !tops view, which iterates the
        // same shared list against its own always-1000 rows).
        const rankingString = statKey === 'elo'
            ? await buildEloRankingString(db, auth)
            : await buildRankingString(db, getTimeStats, statKey, auth);
        if (rankingString == null) {
            if (id != 0) {
                room.sendAnnouncement(
                    'Недостаточно игр сыграно !',
                    id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            return;
        }
        room.sendAnnouncement(
            rankingString,
            id,
            null,
            'bold',
            HaxNotification.CHAT
        );
    }

    // !tops with no argument — every category in one message, skipping any
    // that don't have the 5-player quorum yet rather than erroring. The ELO
    // leader line is appended on top of the generic text (same pattern
    // BFF's own printAllRankings uses for its rating line) rather than
    // folded into buildAllRankingsText itself, since 'elo' deliberately
    // isn't in the shared RANKING_STAT_KEYS list.
    async function printAllRankings(id = 0) {
        const genericText = await buildAllRankingsText(db, getTimeStats);
        const eloLine = await buildEloLeaderLine(db);
        const text = [genericText, eloLine].filter((line) => line != null).join('\n') || null;
        if (text == null) {
            room.sendAnnouncement(
                'Недостаточно игр сыграно !',
                id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        room.sendAnnouncement(
            text,
            id,
            null,
            'bold',
            HaxNotification.CHAT
        );
    }

    // !tops clubs — separate from printRankings since clubs rank by a
    // combined goals+assists+clean_sheets score (see db.getTopClubs), not a
    // single player_stats column, and have no 5-quorum gate (see
    // buildClubRankingString).
    async function printClubRankings(id = 0) {
        const rankingString = await buildClubRankingString(db);
        if (rankingString == null) {
            if (id != 0) {
                room.sendAnnouncement(
                    'Ни один клуб еще не заработал очков !',
                    id,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            return;
        }
        room.sendAnnouncement(
            rankingString,
            id,
            null,
            'bold',
            HaxNotification.CHAT
        );
    }

    return {
        updatePlayerStats,
        updateStats,
        printRankings,
        printAllRankings,
        printClubRankings,
    };
};
