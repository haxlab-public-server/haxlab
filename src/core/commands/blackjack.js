/*
 * Blackjack (!minigames blackjack/bj — see commands/minigames.js's
 * GAME_ALIASES). PvP only — reuses minigames.js's existing challenge/!play-
 * accept flow, same as coinflip/russianroulette: both players just play out
 * hit/stand in turn and whoever ends closer to 21 without busting takes the
 * pot. run() awaits a Promise that only resolves once !hit/!stand (below)
 * actually finish the hand — nothing here needs setTimeout-driven
 * "suspense", the wait IS the players taking their turns.
 *
 * There used to also be a bot-dealer mode (no #<id> given, play against the
 * house). Removed 2026-08-10 — real players were grinding it for a steady
 * edge (an always-available, zero-rake dealer with fixed, predictable
 * play rewards patient basic-strategy grinding at effectively no risk).
 * PvP has no such angle: both sides risk real coins against another human.
 *
 * activeGames is a plain in-memory Map keyed by player id (both ids point
 * at the SAME session object) — same "ephemeral per-session state"
 * reasoning as minigames.js's pendingInvites.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
const { buildDeck, shuffle: shuffleDeck, cardLabel } = require('../cards');

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
    // playerId -> session (registered under BOTH player ids)
    const activeGames = new Map();

    function isOnline(playerId) {
        return state.playersAll.some((p) => p.id === playerId);
    }

    function announceError(player, text) {
        room.sendAnnouncement(text, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    // Bound to this file's own injected getRandomInt — every call site below
    // just says shuffle(deck), same shape as before the cards.js extraction.
    function shuffle(deck) {
        return shuffleDeck(deck, getRandomInt);
    }

    function handLabel(cards) {
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

    async function hitCommand(player, message) {
        const session = activeGames.get(player.id);
        if (!session) {
            announceError(player, `У вас нет активной игры в блэкджек.`);
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
        if (session.players[session.turnIndex].id !== player.id) {
            announceError(player, `Сейчас не ваш ход.`);
            return;
        }
        advancePvpTurn(session);
    }

    // Called from events/movement.js's onPlayerLeave — a no-op unless the
    // leaving player actually has a game in flight. Resolves the pending
    // run() Promise as a push so minigames.js's playCommand refunds BOTH
    // stakes through its normal draw-handling path instead of leaving the
    // other player's game (and money) stuck forever.
    function forfeitOnLeave(player) {
        const session = activeGames.get(player.id);
        if (!session) return;
        const [a, b] = session.players;
        activeGames.delete(a.id);
        activeGames.delete(b.id);
        session.resolveGame({ winner: null });
    }

    return {
        runPvpBlackjack,
        hitCommand,
        standCommand,
        forfeitOnLeave,
    };
};
