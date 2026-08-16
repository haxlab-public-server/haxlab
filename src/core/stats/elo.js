/*
 * Classic ELO math for the main room's informational rating (see
 * stats/roomStats.js's updateStats — this module has no room/state/DB
 * access, same "pure, independently testable" convention as
 * goalAttribution.js). NOT used for matchmaking/team-balancing; that stays
 * team/balance.js's job untouched. Distinct from BFF's openskill-based
 * rating (core/bff/rating.js), which does drive real matchmaking there.
 */
const K_FACTOR = 32;
const INITIAL_ELO = 1000;

function expectedScore(ratingA, ratingB) {
    return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

// actualA: 1 win / 0 loss / 0.5 draw, from A's perspective. B's delta is
// always the exact negation of A's — a symmetric zero-sum exchange, true
// for a binary win/loss AND a draw (expectedB = 1-expectedA, actualB =
// 1-actualA, so K*(actualB-expectedB) = K*(expectedA-actualA) = -deltaA).
function computeEloDelta(ratingA, ratingB, actualA) {
    return Math.round(K_FACTOR * (actualA - expectedScore(ratingA, ratingB)));
}

module.exports = { K_FACTOR, INITIAL_ELO, expectedScore, computeEloDelta };
