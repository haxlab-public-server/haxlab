const { rating, rate, ordinal, predictDraw } = require('openskill');

function defaultRating() {
    return rating();
}

function computeOrdinal(playerRating) {
    return ordinal(playerRating);
}

// BFF plays flexible sizes (1v1 up to 4v4, same philosophy as the main
// room — see [[haxchill-choose-mode-threshold]]/[[haxchill-fixed-match-size]]
// in project memory), so this has to balance ANY player count, not just a
// fixed 8. All distinct ways to split `n` players into a ceil(n/2)-side and
// a floor(n/2)-side — fixing index 0 into the first team avoids counting
// each split twice under both labelings. An odd `n` deliberately produces
// one team one player bigger rather than benching someone — same "uneven
// is fine, don't sideline someone just for parity" policy the main room
// settled on, just decided by rating instead of raw headcount.
function generateSplits(n) {
    const teamASize = Math.ceil(n / 2);
    const rest = [];
    for (let i = 1; i < n; i++) rest.push(i);
    const splits = [];
    function choose(start, chosen) {
        if (chosen.length === teamASize - 1) {
            const teamAIndices = [0, ...chosen];
            const teamBIndices = rest.filter((i) => !chosen.includes(i));
            splits.push({ teamAIndices, teamBIndices });
            return;
        }
        for (let i = start; i < rest.length; i++) {
            choose(i + 1, [...chosen, rest[i]]);
        }
    }
    choose(0, []);
    return splits;
}

// `players` must be at least 2 entries, each shaped { auth, playerName,
// rating: {mu, sigma} }. Tries every possible split and returns whichever
// one openskill's predictDraw() rates as closest to a coin-flip — the most
// evenly-matched game obtainable from exactly this set of players' current
// ratings. Regenerating the split list per call (rather than caching one
// global set like the old fixed-8 version) is cheap at BFF's room-size
// scale (n<=14 -> at most C(14,7)=3432 splits) and keeps this correct for
// every size the room can actually be in. Does not mutate `players`;
// ratings are only ever updated afterward, via updateRatingsAfterMatch,
// once the match actually finishes.
function assignBalancedTeams(players) {
    if (players.length < 2) {
        throw new Error(`assignBalancedTeams: need at least 2 players, got ${players.length}`);
    }
    const splits = generateSplits(players.length);
    let bestSplit = null;
    let bestDrawChance = -1;
    for (const split of splits) {
        const teamARatings = split.teamAIndices.map((i) => players[i].rating);
        const teamBRatings = split.teamBIndices.map((i) => players[i].rating);
        const drawChance = predictDraw([teamARatings, teamBRatings]);
        if (drawChance > bestDrawChance) {
            bestDrawChance = drawChance;
            bestSplit = split;
        }
    }
    return {
        teamA: bestSplit.teamAIndices.map((i) => players[i]),
        teamB: bestSplit.teamBIndices.map((i) => players[i]),
    };
}

// teamARatings/teamBRatings are plain {mu, sigma} arrays (4 each), in the
// same player order the caller wants the result back in. `outcome` is
// 'teamA' | 'teamB' | 'draw'. openskill's rank convention is LOWER = better
// placement, with equal ranks meaning a tie — confirmed directly against
// the library's own source (src/util.ts's rankings()), not just its types.
function updateRatingsAfterMatch(teamARatings, teamBRatings, outcome) {
    const rank = outcome === 'draw' ? [1, 1] : outcome === 'teamA' ? [1, 2] : [2, 1];
    const [updatedTeamA, updatedTeamB] = rate([teamARatings, teamBRatings], { rank });
    return { teamA: updatedTeamA, teamB: updatedTeamB };
}

module.exports = {
    defaultRating,
    computeOrdinal,
    assignBalancedTeams,
    updateRatingsAfterMatch,
};
