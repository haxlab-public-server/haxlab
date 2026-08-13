/*
 * Texas Hold'em (!minigames poker/покер — see commands/minigames.js's
 * GAME_ALIASES). PvP only, no bot dealer. Two shapes share this one engine:
 *
 *  - Regular ("!mg poker #3"): exactly the challenger + the accepting
 *    player, one hand, table closes the moment it resolves — same as
 *    heads-up always worked here.
 *  - Open ("!mg poker #3 open"): a real multi-way table, 2-4 seats. Once
 *    the initially-invited player accepts, any OTHER spectator can sit down
 *    too via "!play #<id>" (id = anyone CURRENTLY seated — see
 *    joinOpenTable), queued in `waitingToJoin` and seated at the START of
 *    the NEXT hand (never mid-hand — a fair deal needs the deck/blinds
 *    decided before any cards go out). The table keeps dealing hands,
 *    rotating the button each time, for as long as >=2 seats remain.
 *
 * A `table` is the thing that persists across hands (seats, button
 * position, open/closed); a `hand` is one deal, discarded once it settles.
 * `seatedAt` maps every seated player id (mid-hand or just waiting for the
 * next one) to their table — this is what !bet/!call/!check/!pass and the
 * leave/team-change hooks look a player up by.
 *
 * No coins are actually moved mid-hand — every blind/bet/call is tracked
 * purely in memory (session.stacks/streetContributed/totalContributed),
 * snapshotted once from each player's real balance at the start of each
 * hand. Settlement happens once, at the very end of each hand: for every
 * seat, net = payout - totalContributed; positive nets are credited,
 * negative nets are debited, zero nets touch nothing. This one formula
 * covers a single winner, a fold-out, AND a split pot (including an
 * uneven split among a subset of a 3-4 player table) without needing a
 * separate no-op case for ties the way a heads-up-only engine could get
 * away with.
 *
 * A player who leaves mid-hand (quits the room, or switches from
 * spectators onto an actual team to go play) has their current-hand
 * contribution zeroed out — folded out AND excluded from the pot, as if
 * they'd never been dealt in. Since nothing was ever really deducted from
 * their balance to begin with, this needs no real refund transaction: their
 * balance already reflects "never bet" at that point, and the pot's own
 * total naturally shrinks by their contribution for whoever's left.
 *
 * Betting is capped so nobody can ever bet/raise past the shortest
 * remaining stack among every still-live player in the hand (including
 * themselves) — guarantees a call is always a full call, avoiding
 * side-pot bookkeeping entirely for this casual a minigame, generalized
 * from the original heads-up-only "cap at what the opponent could ever
 * fully call".
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
const { buildDeck, shuffle: shuffleDeck, cardLabel } = require('../cards');
const { bestHandFromCards, compareScores } = require('../pokerHandRank');

const SMALL_BLIND = 25;
const BIG_BLIND = 50;
const MIN_BET = BIG_BLIND;
const MAX_SEATS_OPEN = 4;

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
    // playerId -> table, for every seated player (mid-hand or just waiting
    // for the next deal) — how !bet/!call/!check/!pass and the leave/
    // team-change hooks find "my current game".
    const seatedAt = new Map();

    function isOnline(playerId) {
        return state.playersAll.some((p) => p.id === playerId);
    }

    function announceError(player, text) {
        room.sendAnnouncement(text, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    // Only used before a table exists at all (the insufficient-balance
    // cancellation path) — everything after that goes through
    // announceToHandPlayers below instead.
    function sendToPair(a, b, text, color) {
        if (isOnline(a.id)) room.sendAnnouncement(text, a.id, color, 'bold', HaxNotification.CHAT);
        if (isOnline(b.id)) room.sendAnnouncement(text, b.id, color, 'bold', HaxNotification.CHAT);
    }

    function announceToHandPlayers(hand, text, color = announcementColor) {
        for (const p of hand.players) {
            if (isOnline(p.id)) room.sendAnnouncement(text, p.id, color, 'bold', HaxNotification.CHAT);
        }
    }

    function shuffle(deck) {
        return shuffleDeck(deck, getRandomInt);
    }

    function handLabel(cards) {
        return cards.map(cardLabel).join(' ');
    }

    function findSeat(hand, playerId) {
        return hand.players.findIndex((p) => p.id === playerId);
    }

    /* ===================== SEATING / TABLE STRUCTURE ===================== */

    // Heads-up: button IS the small blind (real poker convention). 3-4
    // players: button posts nothing, the next two seats post SB/BB.
    function blindSeats(hand) {
        const n = hand.players.length;
        if (n === 2) return { sb: hand.buttonIndex, bb: (hand.buttonIndex + 1) % n };
        return { sb: (hand.buttonIndex + 1) % n, bb: (hand.buttonIndex + 2) % n };
    }

    function nextLiveSeat(hand, fromIndex, { includeFrom = false } = {}) {
        const n = hand.players.length;
        for (let step = includeFrom ? 0 : 1; step <= n; step++) {
            const idx = (fromIndex + step) % n;
            if (!hand.players[idx].folded) return idx;
        }
        return -1;
    }

    // Heads-up: SB/button acts first preflop (unchanged from before this
    // rewrite). 3-4 players: action starts left of the big blind (UTG),
    // comes back around to the big blind last.
    function firstToActPreflop(hand) {
        const { sb, bb } = blindSeats(hand);
        if (hand.players.length === 2) return sb;
        return nextLiveSeat(hand, bb, { includeFrom: false });
    }

    // Heads-up: big blind acts first postflop (unchanged). 3-4 players:
    // the small blind acts first (or the next live seat after the button,
    // if the small blind already folded).
    function firstToActPostflop(hand) {
        const { sb, bb } = blindSeats(hand);
        if (hand.players.length === 2) return bb;
        return nextLiveSeat(hand, sb, { includeFrom: true });
    }

    // Called at hand-start, and again (recursively — bounded, seats only
    // ever shrink) after dropping anyone who can't cover their blind.
    // `resolve` is only ever passed for the very first hand of a table
    // (see setupTable) — the Promise runPokerPvp hands back settles once
    // THAT hand concludes, even if the table (an open one) keeps dealing
    // further hands afterward.
    async function startHand(table, resolve = null) {
        while (table.waitingToJoin.length > 0 && table.seats.length < table.maxSeats) {
            table.seats.push(table.waitingToJoin.shift());
        }
        if (table.seats.length < 2) {
            closeTable(table);
            if (resolve) resolve({ cancelled: true });
            return;
        }
        table.buttonIndex = table.buttonIndex % table.seats.length;

        const n = table.seats.length;
        const sbIdx = n === 2 ? table.buttonIndex : (table.buttonIndex + 1) % n;
        const bbIdx = n === 2 ? (table.buttonIndex + 1) % n : (table.buttonIndex + 2) % n;
        const balances = await Promise.all(table.seats.map((s) => db.getBalance(s.auth)));
        const dropped = [];
        for (let i = 0; i < table.seats.length; i++) {
            const requiredBlind = i === sbIdx ? SMALL_BLIND : i === bbIdx ? BIG_BLIND : 0;
            if (balances[i] < requiredBlind) dropped.push(i);
        }
        if (dropped.length > 0) {
            for (const i of [...dropped].sort((a, b) => b - a)) {
                const seat = table.seats[i];
                seatedAt.delete(seat.id);
                table.seats.splice(i, 1);
                if (isOnline(seat.id)) {
                    room.sendAnnouncement(`❌ Недостаточно монет на блайнд — вы выбываете из-за покерного стола.`, seat.id, errorColor, 'bold', HaxNotification.CHAT);
                }
            }
            await startHand(table, resolve);
            return;
        }

        const deck = shuffle(buildDeck());
        const players = table.seats.map((s, i) => ({
            id: s.id,
            auth: s.auth,
            name: s.name,
            holeCards: [deck.pop(), deck.pop()],
            folded: false,
            left: false,
            stack: balances[i],
            streetContributed: 0,
            totalContributed: 0,
        }));
        const hand = {
            table,
            deck,
            community: [],
            street: 'preflop',
            players,
            buttonIndex: table.buttonIndex,
            toAct: null,
            actedThisStreet: new Set(),
            resolve,
        };
        table.hand = hand;

        commit(hand, sbIdx, SMALL_BLIND);
        commit(hand, bbIdx, BIG_BLIND);
        hand.actedThisStreet = new Set(); // posting a blind isn't "acting" — SB/BB still get a real turn (or the option) this street
        hand.toAct = firstToActPreflop(hand);

        announceHandStart(hand);
        // announceTurn already embeds every (non-folded) player's own hand
        // line above the board for whoever it sends to — including this
        // very first call, right after dealing — so there's no separate
        // "here are your hole cards" message to send on top of it.
        announceTurn(hand);
    }

    function closeTable(table) {
        if (table.open) {
            for (const s of table.seats) {
                seatedAt.delete(s.id);
                if (isOnline(s.id)) {
                    room.sendAnnouncement(`🚪 Покерный стол закрыт — недостаточно игроков для продолжения.`, s.id, announcementColor, 'bold', HaxNotification.CHAT);
                }
            }
        } else {
            for (const s of table.seats) seatedAt.delete(s.id);
        }
        for (const s of table.waitingToJoin) seatedAt.delete(s.id);
        table.seats = [];
        table.waitingToJoin = [];
        table.hand = null;
    }

    async function maybeStartNextHand(table) {
        if (!table.open) {
            closeTable(table);
            return;
        }
        table.buttonIndex = (table.buttonIndex + 1) % Math.max(table.seats.length, 1);
        if (table.seats.length + table.waitingToJoin.length < 2) {
            closeTable(table);
            return;
        }
        await startHand(table);
    }

    // The GAMES['poker'] entry's own run() — customEconomy in minigames.js
    // means it manages 100% of its own money movement, and it's the only
    // one whose invite carries an `open` flag through to here.
    function runPokerPvp(challenger, target, challengerAuth, targetAuth, { open = false } = {}) {
        return new Promise((resolve) => {
            setupTable(challenger, target, challengerAuth, targetAuth, open, resolve).catch((err) => {
                console.error('[poker] setupTable failed:', err);
                resolve({ error: true });
            });
        });
    }

    async function setupTable(challenger, target, challengerAuth, targetAuth, open, resolve) {
        const challengerBalance = await db.getBalance(challengerAuth);
        if (challengerBalance < SMALL_BLIND) {
            sendToPair(challenger, target, `❌ У ${challenger.name} недостаточно монет на малый блайнд (${formatCoins(SMALL_BLIND)}). Игра отменена.`, errorColor);
            resolve({ cancelled: true });
            return;
        }
        const targetBalance = await db.getBalance(targetAuth);
        if (targetBalance < BIG_BLIND) {
            sendToPair(challenger, target, `❌ У ${target.name} недостаточно монет на большой блайнд (${formatCoins(BIG_BLIND)}). Игра отменена.`, errorColor);
            resolve({ cancelled: true });
            return;
        }
        const table = {
            open,
            maxSeats: open ? MAX_SEATS_OPEN : 2,
            seats: [
                { id: challenger.id, auth: challengerAuth, name: challenger.name },
                { id: target.id, auth: targetAuth, name: target.name },
            ],
            waitingToJoin: [],
            buttonIndex: 0,
            hand: null,
        };
        seatedAt.set(challenger.id, table);
        seatedAt.set(target.id, table);
        await startHand(table, resolve);
    }

    // commands/minigames.js's playCommand, when given "!play #<id>" instead
    // of a bare "!play" — id is any player CURRENTLY seated at the table
    // (not necessarily the original challenger, who might have left since).
    // Queued rather than dealt in immediately: a fair deal needs the deck
    // and blinds decided before any cards go out, so joining only ever
    // takes effect at the start of the NEXT hand.
    function joinOpenTable(player, auth, seatedPlayerId) {
        if (seatedAt.has(player.id)) return { ok: false, reason: 'alreadySeated' };
        const table = seatedAt.get(seatedPlayerId);
        if (!table) return { ok: false, reason: 'notFound' };
        if (!table.open) return { ok: false, reason: 'notOpen' };
        if (table.seats.length + table.waitingToJoin.length >= table.maxSeats) return { ok: false, reason: 'full' };
        table.waitingToJoin.push({ id: player.id, auth, name: player.name });
        seatedAt.set(player.id, table);
        return { ok: true };
    }

    // commands/minigames.js's own busy-player guard (see there) — unlike
    // coinflip/russianroulette/blackjack, which are only ever "busy" for the
    // duration of one game.run() call, an open table keeps a player seated
    // (and thus busy) across many hands, well past when its own FIRST
    // hand's run() promise already resolved — this is what lets that guard
    // still catch it.
    function isSeated(playerId) {
        return seatedAt.has(playerId);
    }

    /* ===================== BETTING ACTIONS ===================== */

    function commit(hand, seatIndex, amount) {
        const p = hand.players[seatIndex];
        p.streetContributed += amount;
        p.totalContributed += amount;
        p.stack -= amount;
    }

    function currentMaxContribution(hand) {
        return Math.max(...hand.players.filter((p) => !p.folded).map((p) => p.streetContributed));
    }

    function toCallFor(hand, seatIndex) {
        return currentMaxContribution(hand) - hand.players[seatIndex].streetContributed;
    }

    // Never allowed to bring a live player's total for this street past the
    // shortest remaining stack among every still-live player (including
    // themselves) — see the file header for why this avoids side pots.
    function maxAllowedTotal(hand) {
        const live = hand.players.filter((p) => !p.folded);
        return Math.min(...live.map((p) => p.streetContributed + p.stack));
    }

    function applyBet(hand, seatIndex, amount) {
        const player = hand.players[seatIndex];
        if (!Number.isInteger(amount) || amount <= 0) return { error: 'usage' };
        if (amount > player.stack) return { error: 'insufficient', max: player.stack };

        const cap = maxAllowedTotal(hand);
        const newTotal = player.streetContributed + amount;
        if (newTotal > cap) return { error: 'exceedsOpponentStack', max: cap - player.streetContributed };
        const isCappedAllIn = newTotal === cap;
        if (amount < MIN_BET && !isCappedAllIn) {
            return { error: 'belowMin', min: Math.min(MIN_BET, cap - player.streetContributed) };
        }
        if (newTotal <= currentMaxContribution(hand)) return { error: 'mustExceed' };

        commit(hand, seatIndex, amount);
        // A real bet/raise reopens the action for everyone else, even
        // someone who'd already acted this street.
        hand.actedThisStreet = new Set([seatIndex]);
        return { ok: true };
    }

    function applyCall(hand, seatIndex) {
        const need = toCallFor(hand, seatIndex);
        if (need <= 0) return { error: 'nothingToCall' };
        // Guaranteed to be a FULL call — applyBet's own cap already
        // ensures nobody's outstanding bet exceeds what every live
        // player's stack can cover.
        commit(hand, seatIndex, need);
        hand.actedThisStreet.add(seatIndex);
        return { ok: true };
    }

    function applyCheck(hand, seatIndex) {
        const need = toCallFor(hand, seatIndex);
        if (need > 0) return { error: 'mustCallOrFold', toCall: need };
        hand.actedThisStreet.add(seatIndex);
        return { ok: true };
    }

    function applyFold(hand, seatIndex) {
        hand.players[seatIndex].folded = true;
        hand.actedThisStreet.add(seatIndex);
    }

    function betErrorMessage(result) {
        if (result.error === 'insufficient') return `Недостаточно монет — у вас только ${formatCoins(result.max)}.`;
        if (result.error === 'belowMin') return `Минимальная ставка — ${formatCoins(result.min)} (или ва-банк, если у вас меньше).`;
        if (result.error === 'exceedsOpponentStack') return `Кто-то за столом не сможет столько уравнять — максимум ${formatCoins(result.max)}.`;
        if (result.error === 'mustExceed') return `Эта сумма не перекрывает текущую ставку — используйте "!call", чтобы уравнять, или поставьте больше.`;
        return `Использование: !bet <сумма>. Пример: !bet 100.`;
    }

    /* ===================== STREET PROGRESSION ===================== */

    function isStreetOver(hand) {
        const live = hand.players.filter((p) => !p.folded);
        if (live.length <= 1) return true;
        const activeWithChips = live.filter((p) => p.stack > 0);
        if (activeWithChips.length === 0) return true; // everyone left is already all-in
        const maxContrib = currentMaxContribution(hand);
        return activeWithChips.every((p) => p.streetContributed === maxContrib && hand.actedThisStreet.has(hand.players.indexOf(p)));
    }

    // Deals the next street's card(s) and resets this-street betting state
    // — recurses straight through to showdown with no further betting once
    // nobody live has any chips left to bet (a real all-in runout).
    async function advanceStreet(hand) {
        hand.players.forEach((p) => { p.streetContributed = 0; });
        hand.actedThisStreet = new Set();

        if (hand.street === 'preflop') {
            hand.community.push(hand.deck.pop(), hand.deck.pop(), hand.deck.pop());
            hand.street = 'flop';
        } else if (hand.street === 'flop') {
            hand.community.push(hand.deck.pop());
            hand.street = 'turn';
        } else if (hand.street === 'turn') {
            hand.community.push(hand.deck.pop());
            hand.street = 'river';
        } else {
            hand.street = 'showdown';
            await resolveShowdown(hand);
            return;
        }

        const live = hand.players.filter((p) => !p.folded);
        const activeWithChips = live.filter((p) => p.stack > 0);
        if (activeWithChips.length <= 1) {
            await advanceStreet(hand);
            return;
        }
        hand.toAct = firstToActPostflop(hand);
        announceTurn(hand);
    }

    /* ===================== ANNOUNCEMENTS ===================== */

    // Only shown once total cards reach 5 (2 hole + at least 3 community) —
    // nothing to name before the flop.
    function handComboSuffix(hand, seatIndex) {
        const p = hand.players[seatIndex];
        if (p.holeCards.length + hand.community.length < 5) return '';
        const best = bestHandFromCards([...p.holeCards, ...hand.community]);
        return ` (${best.name})`;
    }

    function myHandLine(hand, seatIndex) {
        const p = hand.players[seatIndex];
        return `🂠 Ваши карты: ${handLabel(p.holeCards)}${handComboSuffix(hand, seatIndex)}`;
    }

    function potTotal(hand) {
        return hand.players.reduce((sum, p) => sum + p.totalContributed, 0);
    }

    function boardLine(hand) {
        const board = hand.community.length > 0 ? handLabel(hand.community) : '(пока закрыт)';
        return `🃏 Стол: ${board} | Банк: ${formatCoins(potTotal(hand))}`;
    }

    // Re-sends every (non-folded) player their OWN hand — with the combo
    // name once one applies — alongside the board every single time it's
    // this function's turn to announce something, so the cards never
    // scroll out of view mid-hand.
    function announceTurn(hand) {
        const board = boardLine(hand);
        const actorName = hand.players[hand.toAct].name;
        const need = toCallFor(hand, hand.toAct);
        const actorStack = hand.players[hand.toAct].stack;
        const prompt = need > 0
            ? `Ваш ход: до колла ${formatCoins(need)}. "!call" — уравнять, "!bet <сумма>" — повысить, "!pass" — сбросить карты. Ваш стек: ${formatCoins(actorStack)}.`
            : `Ваш ход: "!check" — пропустить, "!bet <сумма>" — поставить, "!pass" — сбросить карты. Ваш стек: ${formatCoins(actorStack)}.`;
        for (let i = 0; i < hand.players.length; i++) {
            const p = hand.players[i];
            if (p.folded || !isOnline(p.id)) continue;
            const myHand = myHandLine(hand, i);
            const text = i === hand.toAct
                ? `${myHand}\n${board}\n${prompt}`
                : `${myHand}\n${board}\n⏳ Ход ${actorName}...`;
            room.sendAnnouncement(text, p.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
    }

    function announceHandStart(hand) {
        const { sb, bb } = blindSeats(hand);
        const names = hand.players.map((p) => p.name).join(', ');
        room.sendAnnouncement(
            `🃏 Покер: ${names} играют ! (${hand.players[sb].name} — small blind ${formatCoins(SMALL_BLIND)}, ${hand.players[bb].name} — big blind ${formatCoins(BIG_BLIND)})`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    /* ===================== SETTLEMENT ===================== */

    // net = payout - totalContributed for every seat, in one pass — covers
    // a single winner, a fold-out, and an uneven split among a SUBSET of a
    // 3-4 player table without needing a separate no-op case for ties (see
    // the file header): a heads-up tie is just the special case where both
    // nets land on exactly zero.
    async function settleHand(hand, winnerIdxs, info) {
        const table = hand.table;
        table.hand = null;
        const pot = potTotal(hand);
        const baseShare = Math.floor(pot / winnerIdxs.length);
        let remainder = pot - baseShare * winnerIdxs.length;
        const payout = new Map();
        for (const idx of winnerIdxs) {
            payout.set(idx, baseShare + (remainder > 0 ? 1 : 0));
            if (remainder > 0) remainder--;
        }
        for (let i = 0; i < hand.players.length; i++) {
            const p = hand.players[i];
            const net = (payout.get(i) ?? 0) - p.totalContributed;
            if (net > 0) await db.addCoins(p.auth, p.name, net);
            else if (net < 0) await db.spendCoins(p.auth, p.name, -net);
        }

        // Only "the end, who won" is ever public — every action and the
        // showdown reveal itself stay private to the table (see
        // announceToHandPlayers call sites elsewhere in this file).
        const winnerNames = winnerIdxs.map((i) => hand.players[i].name).join(' и ');
        let text;
        if (winnerIdxs.length > 1) {
            text = `🤝 ${winnerNames} делят банк ${formatCoins(pot)} (${info.winnerHandName}) !`;
        } else if (info.revealedShowdown) {
            text = `🏆 ${winnerNames} побеждает вскрытием (${info.winnerHandName}) и забирает банк ${formatCoins(pot)} !`;
        } else {
            text = `🏆 ${winnerNames} забирает банк ${formatCoins(pot)} !`;
        }
        room.sendAnnouncement(text, null, successColor, 'bold', HaxNotification.CHAT);

        if (hand.resolve) hand.resolve({ winners: winnerIdxs.map((i) => hand.players[i].id) });
        await maybeStartNextHand(table);
    }

    async function resolveShowdown(hand) {
        const live = hand.players.filter((p) => !p.folded);
        const scored = live.map((p) => ({ p, best: bestHandFromCards([...p.holeCards, ...hand.community]) }));
        let bestScore = null;
        for (const s of scored) {
            if (!bestScore || compareScores(s.best.score, bestScore) > 0) bestScore = s.best.score;
        }
        const winners = scored.filter((s) => compareScores(s.best.score, bestScore) === 0);

        const revealLines = scored.map((s) => `${s.p.name}: ${handLabel(s.p.holeCards)} — ${s.best.name}`);
        announceToHandPlayers(hand, `🃏 Вскрытие ! Стол: ${handLabel(hand.community)}\n${revealLines.join('\n')}`);

        const winnerIdxs = winners.map((w) => hand.players.indexOf(w.p));
        await settleHand(hand, winnerIdxs, { revealedShowdown: true, winnerHandName: winners[0].best.name });
    }

    async function afterAction(hand) {
        const live = hand.players.filter((p) => !p.folded);
        if (live.length === 1) {
            await settleHand(hand, [hand.players.indexOf(live[0])], { revealedShowdown: false });
            return;
        }
        if (isStreetOver(hand)) {
            await advanceStreet(hand);
            return;
        }
        hand.toAct = nextLiveSeat(hand, hand.toAct);
        announceTurn(hand);
    }

    /* ===================== TURN COMMANDS ===================== */

    async function betCommand(player, message) {
        const table = seatedAt.get(player.id);
        if (!table || !table.hand) {
            announceError(player, 'У вас нет активной игры в покер.');
            return;
        }
        const hand = table.hand;
        const seatIndex = findSeat(hand, player.id);
        if (seatIndex === -1 || hand.toAct !== seatIndex) {
            announceError(player, 'Сейчас не ваш ход.');
            return;
        }
        const amount = parseInt(message.split(/ +/)[1]);
        const result = applyBet(hand, seatIndex, amount);
        if (result.error) {
            announceError(player, betErrorMessage(result));
            return;
        }
        announceToHandPlayers(hand, `💰 ${hand.players[seatIndex].name} ставит ${formatCoins(amount)} !`);
        await afterAction(hand);
    }

    async function callCommand(player, message) {
        const table = seatedAt.get(player.id);
        if (!table || !table.hand) {
            announceError(player, 'У вас нет активной игры в покер.');
            return;
        }
        const hand = table.hand;
        const seatIndex = findSeat(hand, player.id);
        if (seatIndex === -1 || hand.toAct !== seatIndex) {
            announceError(player, 'Сейчас не ваш ход.');
            return;
        }
        const result = applyCall(hand, seatIndex);
        if (result.error) {
            announceError(player, 'Уравнивать нечего — используйте "!check".');
            return;
        }
        announceToHandPlayers(hand, `✅ ${hand.players[seatIndex].name} уравнивает !`);
        await afterAction(hand);
    }

    async function checkCommand(player, message) {
        const table = seatedAt.get(player.id);
        if (!table || !table.hand) {
            announceError(player, 'У вас нет активной игры в покер.');
            return;
        }
        const hand = table.hand;
        const seatIndex = findSeat(hand, player.id);
        if (seatIndex === -1 || hand.toAct !== seatIndex) {
            announceError(player, 'Сейчас не ваш ход.');
            return;
        }
        const result = applyCheck(hand, seatIndex);
        if (result.error) {
            announceError(player, `Сначала нужно уравнять ${formatCoins(result.toCall)} ("!call") или сбросить карты ("!pass").`);
            return;
        }
        announceToHandPlayers(hand, `✔️ ${hand.players[seatIndex].name} пропускает ход !`);
        await afterAction(hand);
    }

    async function passCommand(player, message) {
        const table = seatedAt.get(player.id);
        if (!table || !table.hand) {
            announceError(player, 'У вас нет активной игры в покер.');
            return;
        }
        const hand = table.hand;
        const seatIndex = findSeat(hand, player.id);
        if (seatIndex === -1 || hand.toAct !== seatIndex) {
            announceError(player, 'Сейчас не ваш ход.');
            return;
        }
        applyFold(hand, seatIndex);
        announceToHandPlayers(hand, `🚫 ${hand.players[seatIndex].name} сбрасывает карты !`);
        await afterAction(hand);
    }

    /* ===================== LEAVING (room-leave AND team-change) ===================== */

    // Shared by forfeitOnLeave (quitting the room) and forfeitOnTeamChange
    // (switching from spectators onto an actual team to go play) — both
    // remove the player from the table outright (no future hands either),
    // and let the current hand continue among whoever's left (or settle/
    // cancel it if that drops live players to 1 or 0). They differ in only
    // one way, which is the whole point of having both: `refund` decides
    // whether the player's current-hand contribution is zeroed out (money
    // "returned" — see the file header for why that needs no real
    // transaction) or left in the pot for the others to win, same as an
    // ordinary fold. Quitting the room forfeits it, same as it always has;
    // only heading onto an actual team to go play refunds it, per the
    // explicit ask this was built for.
    async function removePlayerFromTable(playerId, { refund }) {
        const table = seatedAt.get(playerId);
        if (!table) return;
        seatedAt.delete(playerId);
        table.waitingToJoin = table.waitingToJoin.filter((s) => s.id !== playerId);
        const seatInTable = table.seats.findIndex((s) => s.id === playerId);
        if (seatInTable !== -1) table.seats.splice(seatInTable, 1);

        const hand = table.hand;
        if (!hand) return;
        const seatIndex = findSeat(hand, playerId);
        if (seatIndex === -1 || hand.players[seatIndex].folded) return;

        const leaver = hand.players[seatIndex];
        const contributed = leaver.totalContributed;
        leaver.folded = true;
        leaver.left = true;
        if (refund) {
            leaver.streetContributed = 0;
            leaver.totalContributed = 0;
        }
        if (isOnline(leaver.id)) {
            const text = refund
                ? `🚪 Вы покинули покерный стол — ваша ставка (${formatCoins(contributed)}) возвращена, деньги вычтены из банка.`
                : `🚪 Вы покинули покерный стол — ваша ставка (${formatCoins(contributed)}) остаётся в банке.`;
            room.sendAnnouncement(text, leaver.id, announcementColor, 'bold', HaxNotification.CHAT);
        }

        const live = hand.players.filter((p) => !p.folded);
        if (live.length === 0) {
            table.hand = null;
            if (hand.resolve) hand.resolve({ cancelled: true });
            await maybeStartNextHand(table);
            return;
        }
        if (live.length === 1) {
            await settleHand(hand, [hand.players.indexOf(live[0])], { revealedShowdown: false });
            return;
        }
        if (hand.toAct === seatIndex) hand.toAct = nextLiveSeat(hand, seatIndex);
        if (isStreetOver(hand)) {
            await advanceStreet(hand);
        } else {
            announceTurn(hand);
        }
    }

    function forfeitOnLeave(player) {
        removePlayerFromTable(player.id, { refund: false }).catch((err) => console.error('[poker] forfeitOnLeave failed:', err));
    }

    function forfeitOnTeamChange(player) {
        removePlayerFromTable(player.id, { refund: true }).catch((err) => console.error('[poker] forfeitOnTeamChange failed:', err));
    }

    // !leavetable — a deliberate, voluntary exit while staying online as a
    // spectator (as opposed to forfeitOnLeave/forfeitOnTeamChange above,
    // which are triggered by room events, not typed commands). Refunds like
    // forfeitOnTeamChange, not forfeitOnLeave: standing up cleanly while
    // still around is a lot closer to "heading off to do something else in
    // the room" than to disappearing mid-hand.
    async function leaveTableCommand(player, message) {
        if (!seatedAt.has(player.id)) {
            announceError(player, 'Вы не сидите ни за одним покерным столом.');
            return;
        }
        await removePlayerFromTable(player.id, { refund: true });
        if (isOnline(player.id)) {
            room.sendAnnouncement(`🚪 Вы вышли из-за покерного стола.`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
    }

    // !table [#<id>] — who's actually sitting where, privately to whoever
    // asks. With no argument, shows the caller's OWN table (if they're
    // seated at one); with #<id>, shows whichever table THAT player is
    // seated at — useful to check who's playing before "!play #<id>"-ing
    // your way into an open one.
    function tablePlayersCommand(player, message) {
        const targetToken = message.split(/ +/)[1];
        const table = targetToken && targetToken[0] === '#'
            ? seatedAt.get(parseInt(targetToken.substring(1)))
            : seatedAt.get(player.id);
        if (!table) {
            announceError(player, targetToken ? 'За этим игроком нет покерного стола.' : 'Вы не сидите ни за одним покерным столом.');
            return;
        }
        let text = `🃏 За столом: ${table.seats.map((s) => s.name).join(', ')}`;
        if (table.waitingToJoin.length > 0) {
            text += `\nПодсядут со следующей раздачи: ${table.waitingToJoin.map((s) => s.name).join(', ')}`;
        }
        room.sendAnnouncement(text, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    return {
        SMALL_BLIND,
        BIG_BLIND,
        runPokerPvp,
        joinOpenTable,
        isSeated,
        betCommand,
        callCommand,
        checkCommand,
        passCommand,
        leaveTableCommand,
        tablePlayersCommand,
        forfeitOnLeave,
        forfeitOnTeamChange,
    };
};
