/*
 * Shared 52-card deck primitives — extracted out of commands/blackjack.js
 * once commands/poker.js needed the exact same deck/shuffle/label logic.
 * Both games take `getRandomInt` injected at shuffle time rather than
 * calling Math.random() directly, same "every source of randomness in this
 * codebase stays swappable/testable" reasoning blackjack.js's own coinflip/
 * russianroulette siblings already established.
 */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function buildDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ rank, suit });
        }
    }
    return deck;
}

// Fisher-Yates.
function shuffle(deck, getRandomInt) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = getRandomInt(i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function cardLabel(card) {
    return `${card.rank}${card.suit}`;
}

module.exports = {
    SUITS,
    RANKS,
    buildDeck,
    shuffle,
    cardLabel,
};
