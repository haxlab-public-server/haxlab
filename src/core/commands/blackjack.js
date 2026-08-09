/*
 * Blackjack (!minigames blackjack/bj — see commands/minigames.js's
 * GAME_ALIASES). Two very different modes share this one file because they
 * share a card engine and the same `!hit`/`!stand`/`!split` turn commands:
 *
 *  - No #<id> given ("!mg bj <ставка>"): the player plays against the bot
 *    dealer, full canonical rules — dealer shows one card and hides the
 *    other, hits below 17 and stands on 17+, a natural 21 pays 2.5x, and a
 *    pair can be split into two independent hands (each needing its own
 *    stake, charged at split time).
 *
 *  - #<id> given ("!mg bj #3 <ставка>"): reuses minigames.js's existing
 *    challenge/!play-accept flow — this file's runPvpBlackjack is just
 *    another GAMES[key].run, same shape as coinflip/russianroulette. No
 *    dealer, no split: both players just play out hit/stand in turn and
 *    whoever ends closer to 21 without busting takes the pot. run() awaits
 *    a Promise that only resolves once !hit/!stand (below) actually finish
 *    the hand — nothing here needs setTimeout-driven "suspense", the wait
 *    IS the players taking their turns.
 *
 * activeGames is a plain in-memory Map keyed by player id (both ids point
 * at the SAME session object for a pvp match) — same "ephemeral per-session
 * state" reasoning as minigames.js's pendingInvites.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createBlackjackCommands({
    room,
    state,
    db,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatCoins,
    getRandomInt,
}) {
    const DEALER_STANDS_AT = 17;
    const BLACKJACK_PAYOUT_MULTIPLIER = 2.5;
    const WIN_PAYOUT_MULTIPLIER = 2;
    const HIDDEN_CARD_LABEL = '🎴';

    const SUITS = ['♠', '♥', '♦', '♣'];
    const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

    // playerId -> session (a pvp session is registered under BOTH player ids)
    const activeGames = new Map();

    function isOnline(playerId) {
        return state.playersAll.some((p) => p.id === playerId);
    }

    function announceError(player, text) {
        room.sendAnnouncement(text, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    function buildDeck() {
        const deck = [];
        for (const suit of SUITS) {
            for (const rank of RANKS) {
                deck.push({ rank, suit });
            }
        }
        return deck;
    }

    // Fisher-Yates, using the same injected getRandomInt as the rest of the
    // economy (coinflip's coin toss, russianroulette's chamber) rather than
    // a raw Math.random() call — keeps every source of randomness in this
    // codebase swappable the same way.
    function shuffle(deck) {
        for (let i = deck.length - 1; i > 0; i--) {
            const j = getRandomInt(i + 1);
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    function cardLabel(card) {
        return `${card.rank}${card.suit}`;
    }

    function handLabel(cards, { hideSecond = false } = {}) {
        if (hideSecond) return `${cardLabel(cards[0])} ${HIDDEN_CARD_LABEL}`;
        return cards.map(cardLabel).join(' ');
    }

    function handValue(cards) {
        let total = 0;
        let aces = 0;
        for (const c of cards) {
            if (c.rank === 'A') {
                total += 11;
                aces++;
            } else if (c.rank === 'J' || c.rank === 'Q' || c.rank === 'K') {
                total += 10;
            } else {
                total += parseInt(c.rank, 10);
            }
        }
        while (total > 21 && aces > 0) {
            total -= 10;
            aces--;
        }
        return total;
    }

    function isNaturalBlackjack(cards) {
        return cards.length === 2 && handValue(cards) === 21;
    }

    function canSplit(hand) {
        return hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank;
    }

    /* ===================== BOT MODE ===================== */

    async function startBlackjackBotGame(player, auth, stake) {
        if (activeGames.has(player.id)) {
            announceError(player, `У вас уже есть активная игра в блэкджек — закончите её ("!hit"/"!stand").`);
            return;
        }
        const charged = await db.spendCoins(auth, player.name, stake);
        if (!charged) {
            announceError(player, `Недостаточно монет.`);
            return;
        }
        const deck = shuffle(buildDeck());
        const session = {
            mode: 'bot',
            playerId: player.id,
            playerAuth: auth,
            playerName: player.name,
            stake,
            deck,
            hands: [{ cards: [deck.pop(), deck.pop()], done: false }],
            activeHand: 0,
            dealerCards: [deck.pop(), deck.pop()],
        };
        activeGames.set(player.id, session);

        if (isNaturalBlackjack(session.hands[0].cards) || isNaturalBlackjack(session.dealerCards)) {
            await finishBotGameOnNatural(player, session);
            return;
        }
        announceBotHand(player, session);
    }

    function announceBotHand(player, session) {
        const hand = session.hands[session.activeHand];
        const total = handValue(hand.cards);
        const stakeNote = session.hands.length > 1 ? ` (${session.activeHand + 1}/${session.hands.length})` : '';
        let text = `🃏 Ваша рука${stakeNote}: ${handLabel(hand.cards)} (${total})\n`;
        text += `${HIDDEN_CARD_LABEL} Дилер: ${handLabel(session.dealerCards, { hideSecond: true })}\n`;
        const actions = ['"!hit" — взять карту', '"!stand" — остановиться'];
        if (session.hands.length === 1 && canSplit(hand)) actions.push('"!split" — разделить пару');
        text += actions.join(', ') + '.';
        room.sendAnnouncement(text, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    async function finishBotGameOnNatural(player, session) {
        activeGames.delete(player.id);
        const playerBJ = isNaturalBlackjack(session.hands[0].cards);
        const dealerBJ = isNaturalBlackjack(session.dealerCards);
        room.sendAnnouncement(
            `🃏 Ваша рука: ${handLabel(session.hands[0].cards)} (21)\n${HIDDEN_CARD_LABEL} Дилер: ${handLabel(session.dealerCards)} (${handValue(session.dealerCards)})`,
            player.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        if (playerBJ && dealerBJ) {
            await db.addCoins(session.playerAuth, session.playerName, session.stake);
            room.sendAnnouncement(`🤝 Ничья — у обоих блэкджек, ставка возвращена.`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
        } else if (playerBJ) {
            const payout = Math.round(session.stake * BLACKJACK_PAYOUT_MULTIPLIER);
            await db.addCoins(session.playerAuth, session.playerName, payout);
            room.sendAnnouncement(`🏆 Блэкджек ! Выигрыш: ${formatCoins(payout)} !`, player.id, successColor, 'bold', HaxNotification.CHAT);
        } else {
            room.sendAnnouncement(`❌ У дилера блэкджек. Потеряно: ${formatCoins(session.stake)}.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
        }
    }

    async function advanceBotHandOrFinish(player, session) {
        if (session.activeHand < session.hands.length - 1) {
            session.activeHand++;
            announceBotHand(player, session);
            return;
        }
        await finishBotGame(player, session);
    }

    async function finishBotGame(player, session) {
        activeGames.delete(player.id);
        const allBusted = session.hands.every((h) => handValue(h.cards) > 21);
        if (!allBusted) {
            while (handValue(session.dealerCards) < DEALER_STANDS_AT) {
                session.dealerCards.push(session.deck.pop());
            }
        }
        const dealerTotal = handValue(session.dealerCards);
        const dealerBusted = dealerTotal > 21;
        room.sendAnnouncement(
            `${HIDDEN_CARD_LABEL} Дилер открывает: ${handLabel(session.dealerCards)} (${dealerTotal})${dealerBusted ? ' — перебор !' : ''}`,
            player.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );

        let totalPayout = 0;
        for (let i = 0; i < session.hands.length; i++) {
            const hand = session.hands[i];
            const total = handValue(hand.cards);
            const label = session.hands.length > 1 ? `Рука ${i + 1} (${handLabel(hand.cards)}, ${total})` : `Ваша рука (${total})`;
            if (total > 21) {
                room.sendAnnouncement(`❌ ${label}: перебор, потеряно ${formatCoins(session.stake)}.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            } else if (dealerBusted || total > dealerTotal) {
                const payout = session.stake * WIN_PAYOUT_MULTIPLIER;
                totalPayout += payout;
                room.sendAnnouncement(`✅ ${label}: победа, выигрыш ${formatCoins(payout)}.`, player.id, successColor, 'bold', HaxNotification.CHAT);
            } else if (total === dealerTotal) {
                totalPayout += session.stake;
                room.sendAnnouncement(`🤝 ${label}: ничья, ставка возвращена.`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
            } else {
                room.sendAnnouncement(`❌ ${label}: проигрыш, потеряно ${formatCoins(session.stake)}.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            }
        }
        if (totalPayout > 0) {
            await db.addCoins(session.playerAuth, session.playerName, totalPayout);
        }
    }

    async function botHit(player, session) {
        const hand = session.hands[session.activeHand];
        hand.cards.push(session.deck.pop());
        const total = handValue(hand.cards);
        if (total > 21) {
            hand.done = true;
            room.sendAnnouncement(`💥 Перебор ! ${handLabel(hand.cards)} (${total})`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            await advanceBotHandOrFinish(player, session);
            return;
        }
        if (total === 21) {
            hand.done = true;
            room.sendAnnouncement(`✅ 21 ! ${handLabel(hand.cards)}`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
            await advanceBotHandOrFinish(player, session);
            return;
        }
        announceBotHand(player, session);
    }

    async function botStand(player, session) {
        session.hands[session.activeHand].done = true;
        await advanceBotHandOrFinish(player, session);
    }

    async function botSplit(player, session) {
        const hand = session.hands[session.activeHand];
        if (session.hands.length > 1) {
            announceError(player, `Разделить руку можно только один раз.`);
            return;
        }
        if (!canSplit(hand)) {
            announceError(player, `Разделить можно только пару одинаковых карт.`);
            return;
        }
        const charged = await db.spendCoins(session.playerAuth, session.playerName, session.stake);
        if (!charged) {
            announceError(player, `Недостаточно монет для сплита — нужна еще ${formatCoins(session.stake)}.`);
            return;
        }
        const [c1, c2] = hand.cards;
        session.hands = [
            { cards: [c1, session.deck.pop()], done: false },
            { cards: [c2, session.deck.pop()], done: false },
        ];
        session.activeHand = 0;
        room.sendAnnouncement(`✂️ Рука разделена на две !`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
        announceBotHand(player, session);
    }

    /* ===================== PVP MODE ===================== */

    function sendToBoth(a, b, text, color) {
        if (isOnline(a.id)) room.sendAnnouncement(text, a.id, color, 'bold', HaxNotification.CHAT);
        if (isOnline(b.id)) room.sendAnnouncement(text, b.id, color, 'bold', HaxNotification.CHAT);
    }

    function announcePvpTurn(session) {
        const current = session.players[session.turnIndex];
        const other = session.players[1 - session.turnIndex];
        const total = handValue(current.cards);
        if (isOnline(current.id)) {
            room.sendAnnouncement(
                `🃏 Ваша рука: ${handLabel(current.cards)} (${total})\nВаш ход: "!hit" — взять карту, "!stand" — остановиться.`,
                current.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
        }
        if (isOnline(other.id)) {
            room.sendAnnouncement(`⏳ Ход ${current.name} в блэкджеке...`, other.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
    }

    function advancePvpTurn(session) {
        if (session.turnIndex < session.players.length - 1) {
            session.turnIndex++;
            announcePvpTurn(session);
            return;
        }
        finishPvpGame(session);
    }

    function finishPvpGame(session) {
        const [a, b] = session.players;
        activeGames.delete(a.id);
        activeGames.delete(b.id);
        const totalA = handValue(a.cards);
        const totalB = handValue(b.cards);
        const bustedA = totalA > 21;
        const bustedB = totalB > 21;

        sendToBoth(
            a, b,
            `🃏 ${a.name}: ${handLabel(a.cards)} (${totalA})${bustedA ? ' — перебор' : ''}\n` +
            `🃏 ${b.name}: ${handLabel(b.cards)} (${totalB})${bustedB ? ' — перебор' : ''}`,
            announcementColor
        );

        let winner = null;
        if (bustedA && bustedB) {
            winner = null;
        } else if (bustedA) {
            winner = b;
        } else if (bustedB) {
            winner = a;
        } else if (totalA > totalB) {
            winner = a;
        } else if (totalB > totalA) {
            winner = b;
        }

        if (winner == null) {
            session.resolveGame({ winner: null });
        } else {
            session.resolveGame({ winner: { id: winner.id, name: winner.name }, winnerAuth: winner.auth });
        }
    }

    // The GAMES[key].run signature minigames.js's playCommand calls —
    // resolves once the hand is actually finished, not on a fixed timer.
    // Returning { winner: null } tells playCommand it's a push (both
    // stakes refunded) rather than a normal win — the ONLY GAMES entry
    // that can, since coinflip/russianroulette always produce a winner.
    function runPvpBlackjack(challenger, target, challengerAuth, targetAuth) {
        return new Promise((resolve) => {
            const deck = shuffle(buildDeck());
            const session = {
                mode: 'pvp',
                deck,
                resolveGame: resolve,
                turnIndex: 0,
                players: [
                    { id: challenger.id, auth: challengerAuth, name: challenger.name, cards: [deck.pop(), deck.pop()] },
                    { id: target.id, auth: targetAuth, name: target.name, cards: [deck.pop(), deck.pop()] },
                ],
            };
            activeGames.set(challenger.id, session);
            activeGames.set(target.id, session);
            announcePvpTurn(session);
        });
    }

    /* ===================== SHARED TURN COMMANDS ===================== */

    async function hitCommand(player, message) {
        const session = activeGames.get(player.id);
        if (!session) {
            announceError(player, `У вас нет активной игры в блэкджек.`);
            return;
        }
        if (session.mode === 'bot') {
            await botHit(player, session);
            return;
        }
        if (session.players[session.turnIndex].id !== player.id) {
            announceError(player, `Сейчас не ваш ход.`);
            return;
        }
        const current = session.players[session.turnIndex];
        current.cards.push(session.deck.pop());
        const total = handValue(current.cards);
        if (total >= 21) {
            if (isOnline(player.id)) {
                room.sendAnnouncement(
                    `🃏 ${handLabel(current.cards)} (${total})${total > 21 ? ' — перебор !' : ' — 21 !'}`,
                    player.id,
                    total > 21 ? errorColor : announcementColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
            advancePvpTurn(session);
            return;
        }
        if (isOnline(player.id)) {
            room.sendAnnouncement(`🃏 Ваша рука: ${handLabel(current.cards)} (${total})\n"!hit" — взять карту, "!stand" — остановиться.`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
    }

    async function standCommand(player, message) {
        const session = activeGames.get(player.id);
        if (!session) {
            announceError(player, `У вас нет активной игры в блэкджек.`);
            return;
        }
        if (session.mode === 'bot') {
            await botStand(player, session);
            return;
        }
        if (session.players[session.turnIndex].id !== player.id) {
            announceError(player, `Сейчас не ваш ход.`);
            return;
        }
        advancePvpTurn(session);
    }

    async function splitCommand(player, message) {
        const session = activeGames.get(player.id);
        if (!session) {
            announceError(player, `У вас нет активной игры в блэкджек.`);
            return;
        }
        if (session.mode !== 'bot') {
            announceError(player, `Разделение руки доступно только в игре с ботом.`);
            return;
        }
        await botSplit(player, session);
    }

    // Called from events/movement.js's onPlayerLeave — a no-op unless the
    // leaving player actually has a game in flight. Bot mode: the stake is
    // simply forfeit (already spent, no refund) — same "disconnecting
    // doesn't save you" reasoning as any other wager. Pvp mode: resolves
    // the pending run() Promise as a push so minigames.js's playCommand
    // refunds BOTH stakes through its normal draw-handling path instead of
    // leaving the other player's game (and money) stuck forever.
    function forfeitOnLeave(player) {
        const session = activeGames.get(player.id);
        if (!session) return;
        if (session.mode === 'bot') {
            activeGames.delete(player.id);
            return;
        }
        const [a, b] = session.players;
        activeGames.delete(a.id);
        activeGames.delete(b.id);
        session.resolveGame({ winner: null });
    }

    return {
        startBlackjackBotGame,
        runPvpBlackjack,
        hitCommand,
        standCommand,
        splitCommand,
        forfeitOnLeave,
    };
};
