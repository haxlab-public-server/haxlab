/*
 * Pure Texas Hold'em hand evaluation — no room/state/DB dependencies at all,
 * just cards in, a comparable score out. commands/poker.js is the only
 * caller; kept separate because this part is genuinely independent logic
 * (and by far the easiest part of the whole feature to get subtly wrong),
 * worth testing in complete isolation from the game engine around it.
 *
 * A "hand" here is always a plain array of {rank, suit} objects — the same
 * shape core/cards.js's buildDeck() produces.
 */
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };

// Higher category number always wins, regardless of tiebreakers — checked
// first in every comparison (see toScore/compareScores below).
const CATEGORY = {
    HIGH_CARD: 0,
    PAIR: 1,
    TWO_PAIR: 2,
    THREE_OF_A_KIND: 3,
    STRAIGHT: 4,
    FLUSH: 5,
    FULL_HOUSE: 6,
    FOUR_OF_A_KIND: 7,
    STRAIGHT_FLUSH: 8,
};

const CATEGORY_NAMES = {
    [CATEGORY.HIGH_CARD]: 'Старшая карта',
    [CATEGORY.PAIR]: 'Пара',
    [CATEGORY.TWO_PAIR]: 'Две пары',
    [CATEGORY.THREE_OF_A_KIND]: 'Тройка',
    [CATEGORY.STRAIGHT]: 'Стрит',
    [CATEGORY.FLUSH]: 'Флеш',
    [CATEGORY.FULL_HOUSE]: 'Фул-хаус',
    [CATEGORY.FOUR_OF_A_KIND]: 'Каре',
    [CATEGORY.STRAIGHT_FLUSH]: 'Стрит-флеш',
};

function rankValue(card) {
    return RANK_VALUES[card.rank];
}

// Exactly 5 cards in, one evaluated hand out — the 21 5-card subsets of a
// 7-card (2 hole + 5 community) showdown hand are each scored through this,
// see bestHandFromCards below for picking the winner among them.
function evaluateFiveCardHand(cards) {
    const ranksDesc = cards.map(rankValue).sort((a, b) => b - a);
    const isFlush = cards.every((c) => c.suit === cards[0].suit);

    const uniqueRanksDesc = [...new Set(ranksDesc)].sort((a, b) => b - a);
    let straightHigh = null;
    if (uniqueRanksDesc.length === 5) {
        if (uniqueRanksDesc[0] - uniqueRanksDesc[4] === 4) {
            straightHigh = uniqueRanksDesc[0];
        } else if (uniqueRanksDesc.join(',') === '14,5,4,3,2') {
            // The wheel (A-2-3-4-5) — the one case the ace plays LOW. Still
            // the worst possible straight (5-high), just a real one.
            straightHigh = 5;
        }
    }
    const isStraight = straightHigh !== null;

    const countByRank = new Map();
    for (const r of ranksDesc) countByRank.set(r, (countByRank.get(r) ?? 0) + 1);
    // Ties in count broken by rank (descending) — e.g. two different pairs
    // always sorts the HIGHER pair first, matching how two-pair/full-house
    // tiebreakers below expect groups[0]/groups[1] to already be ordered.
    const groups = [...countByRank.entries()]
        .map(([rank, count]) => ({ rank, count }))
        .sort((a, b) => b.count - a.count || b.rank - a.rank);
    const pattern = groups.map((g) => g.count);

    if (isStraight && isFlush) {
        return { category: CATEGORY.STRAIGHT_FLUSH, tiebreakers: [straightHigh] };
    }
    if (pattern[0] === 4) {
        return { category: CATEGORY.FOUR_OF_A_KIND, tiebreakers: [groups[0].rank, groups[1].rank] };
    }
    if (pattern[0] === 3 && pattern[1] === 2) {
        return { category: CATEGORY.FULL_HOUSE, tiebreakers: [groups[0].rank, groups[1].rank] };
    }
    if (isFlush) {
        return { category: CATEGORY.FLUSH, tiebreakers: ranksDesc };
    }
    if (isStraight) {
        return { category: CATEGORY.STRAIGHT, tiebreakers: [straightHigh] };
    }
    if (pattern[0] === 3) {
        return { category: CATEGORY.THREE_OF_A_KIND, tiebreakers: [groups[0].rank, groups[1].rank, groups[2].rank] };
    }
    if (pattern[0] === 2 && pattern[1] === 2) {
        return { category: CATEGORY.TWO_PAIR, tiebreakers: [groups[0].rank, groups[1].rank, groups[2].rank] };
    }
    if (pattern[0] === 2) {
        return { category: CATEGORY.PAIR, tiebreakers: [groups[0].rank, groups[1].rank, groups[2].rank, groups[3].rank] };
    }
    return { category: CATEGORY.HIGH_CARD, tiebreakers: ranksDesc };
}

// Every category's tiebreaker list is a different length (a straight needs
// only its own high card, high-card/flush need all 5) — padded to a fixed
// 6-element [category, ...5 tiebreakers] shape so ANY two evaluated hands,
// same category or not, compare correctly with one plain lexicographic
// array walk (compareScores below), never needing to know which category
// either one actually is.
function toScore(evaluated) {
    const padded = evaluated.tiebreakers.slice(0, 5);
    while (padded.length < 5) padded.push(0);
    return [evaluated.category, ...padded];
}

function compareScores(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

// Every way to leave exactly 2 of the 7 cards out — C(7,2) = C(7,5) = 21,
// just a cheaper way to enumerate the same 21 five-card subsets.
function fiveCardSubsets(sevenCards) {
    const subsets = [];
    for (let i = 0; i < sevenCards.length; i++) {
        for (let j = i + 1; j < sevenCards.length; j++) {
            subsets.push(sevenCards.filter((_, idx) => idx !== i && idx !== j));
        }
    }
    return subsets;
}

// `cards` is 2 hole + up to 5 community (5, 6, or 7 total — showdown always
// has exactly 7, but this works for any count >= 5, which the tests lean
// on to check evaluateFiveCardHand's own math directly without a full
// 7-card showdown around it every time).
function bestHandFromCards(cards) {
    const candidates = cards.length === 5 ? [cards] : fiveCardSubsets(cards);
    let best = null;
    for (const combo of candidates) {
        const evaluated = evaluateFiveCardHand(combo);
        const score = toScore(evaluated);
        if (!best || compareScores(score, best.score) > 0) {
            best = { category: evaluated.category, name: CATEGORY_NAMES[evaluated.category], score, cards: combo };
        }
    }
    return best;
}

module.exports = {
    CATEGORY,
    CATEGORY_NAMES,
    RANK_VALUES,
    evaluateFiveCardHand,
    toScore,
    compareScores,
    bestHandFromCards,
};
