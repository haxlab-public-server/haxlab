/*
 * Heads-up Texas Hold'em (!minigames poker/покер — see commands/minigames.js's
 * GAME_ALIASES). PvP only, no bot dealer — reuses minigames.js's existing
 * challenge/!play-accept flow for the invite itself, same as blackjack's
 * pvp mode, but everything AFTER acceptance is fully self-contained here:
 * unlike every other minigame, poker's economy isn't "both sides stake the
 * same amount, winner takes 2x" at all — blinds are asymmetric (the
 * challenger posts the SMALL blind, the accepting player posts the BIG
 * blind), and additional betting during the hand is player-driven and
 * variable. minigames.js special-cases any GAMES entry with
 * `customEconomy: true` to skip its own stake-parsing/charging/pot-award
 * logic entirely and just hand off to runPokerPvp below, which manages
 * 100% of its own money movement instead.
 *
 * No coins are actually moved mid-hand — every blind/bet/call is tracked
 * purely in memory (session.stacks/streetContributions/totalContributed),
 * snapshotted once from each player's real balance at the start of the
 * hand. Only ONE real settlement happens, right at the very end (fold or
 * showdown): the loser's total contribution for the whole hand is deducted
 * and credited to the winner — the winner's OWN contribution was never
 * actually removed from the DB in the first place, so there's nothing to
 * refund them. A split pot (a tied showdown) needs no DB calls at all.
 *
 * Betting is capped so a bet can never exceed what the opponent could ever
 * fully call with their entire remaining stack — deliberately avoids
 * "all-in for less"/side-pot bookkeeping entirely, which only matters with
 * 3+ players anyway.
 *
 * activeGames is a plain in-memory Map keyed by player id (both ids point
 * at the SAME session object) — same "ephemeral per-session state"
 * reasoning as minigames.js's pendingInvites.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
const { buildDeck, shuffle: shuffleDeck, cardLabel } = require('../cards');
const { bestHandFromCards, compareScores } = require('../pokerHandRank');

const SMALL_BLIND = 25;
const BIG_BLIND = 50;
const MIN_BET = BIG_BLIND;

module.exports = function createPokerCommands({
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
    // playerId -> session (both players in a hand point at the SAME object)
    const activeGames = new Map();

    function isOnline(playerId) {
        return state.playersAll.some((p) => p.id === playerId);
    }

    function announceError(player, text) {
        room.sendAnnouncement(text, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    function sendToBoth(a, b, text, color) {
        if (isOnline(a.id)) room.sendAnnouncement(text, a.id, color, 'bold', HaxNotification.CHAT);
        if (isOnline(b.id)) room.sendAnnouncement(text, b.id, color, 'bold', HaxNotification.CHAT);
    }

    function shuffle(deck) {
        return shuffleDeck(deck, getRandomInt);
    }

    function handLabel(cards) {
        return cards.map(cardLabel).join(' ');
    }

    function otherKey(key) {
        return key === 'sb' ? 'bb' : 'sb';
    }

    function actorKeyFor(session, player) {
        if (session.players.sb.id === player.id) return 'sb';
        if (session.players.bb.id === player.id) return 'bb';
        return null;
    }

    function toCall(session, key) {
        return session.streetContributions[otherKey(key)] - session.streetContributions[key];
    }

    function potTotal(session) {
        return session.totalContributed.sb + session.totalContributed.bb;
    }

    // Moves real chips from a player's in-memory stack into the pot — the
    // only two places state ever changes are here and blind-posting at
    // hand start.
    function commit(session, key, amount) {
        session.streetContributions[key] += amount;
        session.totalContributed[key] += amount;
        session.stacks[key] -= amount;
    }

    /* ===================== BETTING ACTIONS ===================== */

    function applyBet(session, key, amount) {
        const opp = otherKey(key);
        const stack = session.stacks[key];
        if (!Number.isInteger(amount) || amount <= 0) return { error: 'usage' };
        if (amount > stack) return { error: 'insufficient', max: stack };

        // Never allowed to bet more than the opponent could ever fully
        // call with everything they have left — guarantees a call is
        // ALWAYS a full call, so there's never an "all-in for less"/
        // side-pot case to handle at all (only matters with 3+ players).
        const opponentMaxTotal = session.streetContributions[opp] + session.stacks[opp];
        const myCappedMaxTotal = Math.min(session.streetContributions[key] + stack, opponentMaxTotal);
        const newTotal = session.streetContributions[key] + amount;
        if (newTotal > myCappedMaxTotal) {
            return { error: 'exceedsOpponentStack', max: myCappedMaxTotal - session.streetContributions[key] };
        }
        const isCappedAllIn = newTotal === myCappedMaxTotal;
        if (amount < MIN_BET && !isCappedAllIn) {
            return { error: 'belowMin', min: Math.min(MIN_BET, myCappedMaxTotal - session.streetContributions[key]) };
        }
        if (newTotal <= session.streetContributions[opp]) {
            return { error: 'mustExceed' };
        }

        commit(session, key, amount);
        // A real bet/raise reopens the action — any earlier check this
        // street no longer means anything.
        session.checked = { sb: false, bb: false };
        session.toAct = opp;
        return { ok: true };
    }

    function applyCall(session, key) {
        const need = toCall(session, key);
        if (need <= 0) return { error: 'nothingToCall' };
        // Guaranteed to be a FULL call — applyBet's own cap already
        // ensures the opponent's outstanding bet never exceeds what this
        // player's stack can cover.
        commit(session, key, need);
        return { ok: true, streetOver: true };
    }

    function applyCheck(session, key) {
        const need = toCall(session, key);
        if (need > 0) return { error: 'mustCallOrFold', toCall: need };
        session.checked[key] = true;
        if (session.checked[otherKey(key)]) {
            return { ok: true, streetOver: true };
        }
        session.toAct = otherKey(key);
        return { ok: true, streetOver: false };
    }

    function applyFold(session, key) {
        session.players[key].folded = true;
        return { winnerKey: otherKey(key) };
    }

    function betErrorMessage(result) {
        if (result.error === 'insufficient') return `Недостаточно монет — у вас только ${formatCoins(result.max)}.`;
        if (result.error === 'belowMin') return `Минимальная ставка — ${formatCoins(result.min)} (или ва-банк, если у вас меньше).`;
        if (result.error === 'exceedsOpponentStack') return `Соперник не сможет столько уравнять — максимум ${formatCoins(result.max)}.`;
        if (result.error === 'mustExceed') return `Эта сумма не перекрывает текущую ставку — используйте "!call", чтобы уравнять, или поставьте больше.`;
        return `Использование: !bet <сумма>. Пример: !bet 100.`;
    }

    /* ===================== STREET PROGRESSION ===================== */

    // Deals the next street's card(s) and resets this-street betting state
    // — recurses straight through to showdown with no further betting once
    // either player has nothing left to bet (a real all-in runout).
    function advanceStreet(session) {
        session.streetContributions = { sb: 0, bb: 0 };
        session.checked = { sb: false, bb: false };

        if (session.street === 'preflop') {
            session.community.push(session.deck.pop(), session.deck.pop(), session.deck.pop());
            session.street = 'flop';
        } else if (session.street === 'flop') {
            session.community.push(session.deck.pop());
            session.street = 'turn';
        } else if (session.street === 'turn') {
            session.community.push(session.deck.pop());
            session.street = 'river';
        } else {
            session.street = 'showdown';
            return { showdown: true };
        }

        if (session.stacks.sb === 0 || session.stacks.bb === 0) {
            return advanceStreet(session);
        }
        session.toAct = 'bb'; // postflop, big blind acts first (SB/button acts first only preflop)
        return { showdown: false };
    }

    /* ===================== ANNOUNCEMENTS ===================== */

    function announceHoleCards(player, session, key) {
        if (!isOnline(player.id)) return;
        room.sendAnnouncement(`🂠 Ваши карты: ${handLabel(session.players[key].holeCards)}`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    function boardLine(session) {
        const board = session.community.length > 0 ? handLabel(session.community) : '(пока закрыт)';
        return `🃏 Стол: ${board} | Банк: ${formatCoins(potTotal(session))}`;
    }

    function announceTurn(session) {
        const key = session.toAct;
        const actor = session.players[key];
        const other = session.players[otherKey(key)];
        const need = toCall(session, key);
        const board = boardLine(session);
        const prompt = need > 0
            ? `Ваш ход: до колла ${formatCoins(need)}. "!call" — уравнять, "!bet <сумма>" — повысить, "!pass" — сбросить карты. Ваш стек: ${formatCoins(session.stacks[key])}.`
            : `Ваш ход: "!check" — пропустить, "!bet <сумма>" — поставить, "!pass" — сбросить карты. Ваш стек: ${formatCoins(session.stacks[key])}.`;
        if (isOnline(actor.id)) {
            room.sendAnnouncement(`${board}\n${prompt}`, actor.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
        if (isOnline(other.id)) {
            room.sendAnnouncement(`${board}\n⏳ Ход ${actor.name}...`, other.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
    }

    /* ===================== SETTLEMENT ===================== */

    // `showdownInfo` is null for a fold (cards stay mucked, never revealed
    // — standard poker etiquette), or { winnerHandName } / { tieHandName }
    // once resolveShowdown below has already announced the reveal.
    async function settleHand(session, winnerKey, showdownInfo) {
        activeGames.delete(session.players.sb.id);
        activeGames.delete(session.players.bb.id);
        const pot = potTotal(session);

        if (winnerKey == null) {
            // Split pot — nobody's real balance was ever touched, nothing
            // to move back.
            room.sendAnnouncement(`🤝 Ничья (${showdownInfo.tieHandName}) ! Банк ${formatCoins(pot)} остаётся у каждого при своих.`, null, announcementColor, 'bold', HaxNotification.CHAT);
            session.resolveGame({ winner: null });
            return;
        }

        const winner = session.players[winnerKey];
        const loser = session.players[otherKey(winnerKey)];
        const loserLoss = session.totalContributed[otherKey(winnerKey)];
        if (loserLoss > 0) {
            await db.spendCoins(loser.auth, loser.name, loserLoss);
            await db.addCoins(winner.auth, winner.name, loserLoss);
        }
        const text = showdownInfo
            ? `🏆 ${winner.name} побеждает вскрытием (${showdownInfo.winnerHandName}) и забирает банк ${formatCoins(pot)} !`
            : `🏆 ${winner.name} забирает банк ${formatCoins(pot)} !`;
        room.sendAnnouncement(text, null, successColor, 'bold', HaxNotification.CHAT);
        session.resolveGame({ winner: winner.id, winnerAuth: winner.auth });
    }

    async function resolveShowdown(session) {
        const sbBest = bestHandFromCards([...session.players.sb.holeCards, ...session.community]);
        const bbBest = bestHandFromCards([...session.players.bb.holeCards, ...session.community]);
        room.sendAnnouncement(
            `🃏 Вскрытие ! Стол: ${handLabel(session.community)}\n` +
            `${session.players.sb.name}: ${handLabel(session.players.sb.holeCards)} — ${sbBest.name}\n` +
            `${session.players.bb.name}: ${handLabel(session.players.bb.holeCards)} — ${bbBest.name}`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        const cmp = compareScores(sbBest.score, bbBest.score);
        if (cmp > 0) await settleHand(session, 'sb', { winnerHandName: sbBest.name });
        else if (cmp < 0) await settleHand(session, 'bb', { winnerHandName: bbBest.name });
        else await settleHand(session, null, { tieHandName: sbBest.name });
    }

    async function afterAction(session) {
        const result = advanceStreet(session);
        if (result.showdown) {
            await resolveShowdown(session);
        } else {
            announceTurn(session);
        }
    }

    /* ===================== HAND SETUP ===================== */

    async function setupHand(challenger, target, challengerAuth, targetAuth, resolve) {
        const challengerBalance = await db.getBalance(challengerAuth);
        if (challengerBalance < SMALL_BLIND) {
            sendToBoth(challenger, target, `❌ У ${challenger.name} недостаточно монет на малый блайнд (${formatCoins(SMALL_BLIND)}). Игра отменена.`, errorColor);
            resolve({ cancelled: true });
            return;
        }
        const targetBalance = await db.getBalance(targetAuth);
        if (targetBalance < BIG_BLIND) {
            sendToBoth(challenger, target, `❌ У ${target.name} недостаточно монет на большой блайнд (${formatCoins(BIG_BLIND)}). Игра отменена.`, errorColor);
            resolve({ cancelled: true });
            return;
        }

        const deck = shuffle(buildDeck());
        const session = {
            players: {
                sb: { id: challenger.id, auth: challengerAuth, name: challenger.name, holeCards: [deck.pop(), deck.pop()], folded: false },
                bb: { id: target.id, auth: targetAuth, name: target.name, holeCards: [deck.pop(), deck.pop()], folded: false },
            },
            stacks: { sb: challengerBalance - SMALL_BLIND, bb: targetBalance - BIG_BLIND },
            streetContributions: { sb: SMALL_BLIND, bb: BIG_BLIND },
            totalContributed: { sb: SMALL_BLIND, bb: BIG_BLIND },
            checked: { sb: false, bb: false },
            community: [],
            street: 'preflop',
            toAct: 'sb', // small blind (the button, in heads-up) acts first preflop only
            deck,
            resolveGame: resolve,
        };
        activeGames.set(challenger.id, session);
        activeGames.set(target.id, session);

        room.sendAnnouncement(
            `🃏 Покер: ${challenger.name} (small blind, ${formatCoins(SMALL_BLIND)}) vs ${target.name} (big blind, ${formatCoins(BIG_BLIND)}) !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        announceHoleCards(challenger, session, 'sb');
        announceHoleCards(target, session, 'bb');
        announceTurn(session);
    }

    // The GAMES['poker'] entry's own run() — see minigames.js's
    // `customEconomy` branch for why this isn't awaited for a return value
    // the way coinflip/russianroulette/blackjack's own run() results are;
    // still returns a Promise (resolved once the hand actually concludes,
    // by settleHand below) purely so callers/tests CAN await the whole
    // hand if they want to.
    function runPokerPvp(challenger, target, challengerAuth, targetAuth) {
        return new Promise((resolve) => {
            setupHand(challenger, target, challengerAuth, targetAuth, resolve).catch((err) => {
                console.error('[poker] setupHand failed:', err);
                resolve({ error: true });
            });
        });
    }

    /* ===================== SHARED TURN COMMANDS ===================== */

    async function betCommand(player, message) {
        const session = activeGames.get(player.id);
        if (!session) {
            announceError(player, 'У вас нет активной игры в покер.');
            return;
        }
        const key = actorKeyFor(session, player);
        if (session.toAct !== key) {
            announceError(player, 'Сейчас не ваш ход.');
            return;
        }
        const amount = parseInt(message.split(/ +/)[1]);
        const result = applyBet(session, key, amount);
        if (result.error) {
            announceError(player, betErrorMessage(result));
            return;
        }
        room.sendAnnouncement(`💰 ${session.players[key].name} ставит ${formatCoins(amount)} !`, null, announcementColor, 'bold', HaxNotification.CHAT);
        announceTurn(session);
    }

    async function callCommand(player, message) {
        const session = activeGames.get(player.id);
        if (!session) {
            announceError(player, 'У вас нет активной игры в покер.');
            return;
        }
        const key = actorKeyFor(session, player);
        if (session.toAct !== key) {
            announceError(player, 'Сейчас не ваш ход.');
            return;
        }
        const result = applyCall(session, key);
        if (result.error) {
            announceError(player, 'Уравнивать нечего — используйте "!check".');
            return;
        }
        room.sendAnnouncement(`✅ ${session.players[key].name} уравнивает !`, null, announcementColor, 'bold', HaxNotification.CHAT);
        await afterAction(session);
    }

    async function checkCommand(player, message) {
        const session = activeGames.get(player.id);
        if (!session) {
            announceError(player, 'У вас нет активной игры в покер.');
            return;
        }
        const key = actorKeyFor(session, player);
        if (session.toAct !== key) {
            announceError(player, 'Сейчас не ваш ход.');
            return;
        }
        const result = applyCheck(session, key);
        if (result.error) {
            announceError(player, `Сначала нужно уравнять ${formatCoins(result.toCall)} ("!call") или сбросить карты ("!pass").`);
            return;
        }
        room.sendAnnouncement(`✔️ ${session.players[key].name} пропускает ход !`, null, announcementColor, 'bold', HaxNotification.CHAT);
        if (result.streetOver) {
            await afterAction(session);
        } else {
            announceTurn(session);
        }
    }

    async function passCommand(player, message) {
        const session = activeGames.get(player.id);
        if (!session) {
            announceError(player, 'У вас нет активной игры в покер.');
            return;
        }
        const key = actorKeyFor(session, player);
        if (session.toAct !== key) {
            announceError(player, 'Сейчас не ваш ход.');
            return;
        }
        const { winnerKey } = applyFold(session, key);
        room.sendAnnouncement(`🚫 ${session.players[key].name} сбрасывает карты !`, null, announcementColor, 'bold', HaxNotification.CHAT);
        await settleHand(session, winnerKey, null);
    }

    // Called from events/movement.js's onPlayerLeave — a no-op unless the
    // leaving player actually has a hand in flight. Treated exactly like a
    // fold: the opponent takes the pot, same as any other room's poker
    // client auto-folding a disconnected player instead of leaving the
    // hand stuck (and their opponent's money in limbo) forever.
    function forfeitOnLeave(player) {
        const session = activeGames.get(player.id);
        if (!session) return;
        const key = actorKeyFor(session, player);
        if (!key) return;
        const { winnerKey } = applyFold(session, key);
        settleHand(session, winnerKey, null).catch((err) => console.error('[poker] settleHand on leave failed:', err));
    }

    return {
        SMALL_BLIND,
        BIG_BLIND,
        runPokerPvp,
        betCommand,
        callCommand,
        checkCommand,
        passCommand,
        forfeitOnLeave,
    };
};
