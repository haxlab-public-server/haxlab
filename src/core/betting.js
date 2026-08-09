/*
 * Spectator betting on match outcome, open only during the pre-match
 * captain-swap window (state.swapMode — see team/swap.js). Odds (кэф) are
 * computed from each team's current roster's average personal winrate: the
 * stronger team gets the lower coefficient, same "favorite pays less"
 * convention as real sportsbooks. A bettor who's later swapped IN by a
 * captain during that same window gets their stake refunded automatically
 * (see refundIfSubbedIn, called from events/movement.js's
 * onPlayerTeamChange) — betting on a match you're now playing in makes no
 * sense anymore.
 *
 * Bets resolve once the match actually ends (see entry.js's endGame, which
 * calls resolveBets(winner) right alongside awardMatchCoins). A draw
 * refunds every stake instead of confiscating it — nobody's bet was
 * actually wrong, there's just no winning side to have backed.
 *
 * Stakes move through db.spendCoins/db.addCoins, same atomic
 * check-and-deduct pattern as commands/minigames.js.
 *
 * pendingBets is a plain in-memory Map, keyed by the bettor's auth — same
 * "ephemeral per-session state, not routed through `state` or the DB"
 * reasoning as minigames.js's pendingInvites.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createBettingSystem({
    room,
    state,
    authArray,
    db,
    Team,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatCoins,
}) {
    const MIN_BET = 10;
    const MIN_ODDS = 1.2;
    const MAX_ODDS = 4.0;
    const DEFAULT_WINRATE = 0.5;

    const TEAM_ALIASES = { red: Team.RED, r: Team.RED, blue: Team.BLUE, b: Team.BLUE };

    // auth -> { playerId, playerName, team, amount, odds }
    const pendingBets = new Map();

    function getAuth(player) {
        return authArray[player.id][0];
    }

    function isOnline(playerId) {
        return state.playersAll.some((p) => p.id === playerId);
    }

    function announceError(player, text) {
        room.sendAnnouncement(text, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    function teamName(team) {
        return team === Team.RED ? 'красных' : 'синих';
    }

    function clamp(value, lo, hi) {
        return Math.max(lo, Math.min(hi, value));
    }

    async function playerWinrate(player) {
        const stats = await db.getPlayerStats(getAuth(player));
        if (!stats || !stats.games) return DEFAULT_WINRATE;
        return stats.wins / stats.games;
    }

    async function teamWinrate(roster) {
        if (roster.length === 0) return DEFAULT_WINRATE;
        const rates = await Promise.all(roster.map(playerWinrate));
        return rates.reduce((a, b) => a + b, 0) / rates.length;
    }

    // Fair 2-outcome split (pRed + pBlue == 1 by construction, when there's
    // any winrate signal at all) inverted into decimal odds, then clamped
    // into a sane band — a lopsided roster (an all-rookie team vs an
    // all-veteran one) would otherwise produce an absurd coefficient like
    // x50 that would never actually get paid out in practice.
    async function computeOdds() {
        const [redWr, blueWr] = await Promise.all([teamWinrate(state.teamRed), teamWinrate(state.teamBlue)]);
        const total = redWr + blueWr;
        const pRed = total > 0 ? redWr / total : 0.5;
        const pBlue = total > 0 ? blueWr / total : 0.5;
        return {
            [Team.RED]: clamp(1 / pRed, MIN_ODDS, MAX_ODDS),
            [Team.BLUE]: clamp(1 / pBlue, MIN_ODDS, MAX_ODDS),
        };
    }

    // Called from team/swap.js's beginCaptainTurn — fires once per captain
    // turn (blue, then red), so bettors watching mid-window see odds that
    // reflect whatever the previous captain just swapped.
    async function announceOdds() {
        if (state.teamRed.length === 0 && state.teamBlue.length === 0) return;
        const odds = await computeOdds();
        room.sendAnnouncement(
            `📊 Коэффициенты на матч: 🔴 Красные x${odds[Team.RED].toFixed(2)} — 🔵 Синие x${odds[Team.BLUE].toFixed(2)}. ` +
            `Зрители могут поставить командой "!bet red(r)|blue(b) <ставка>" (от ${formatCoins(MIN_BET)}), пока капитаны делают замены.`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function betCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const teamToken = (msgArray[0] ?? '').toLowerCase();
        const team = TEAM_ALIASES[teamToken];
        const amount = parseInt(msgArray[1]);
        if (!team || !Number.isInteger(amount)) {
            announceError(player, `Использование: !bet <red(r)|blue(b)> <ставка>. Ставки принимаются только во время замен капитанов перед началом матча. Пример: !bet red 50.`);
            return;
        }
        if (!state.swapMode) {
            announceError(player, `Ставки принимаются только во время замен капитанов перед началом матча.`);
            return;
        }
        if (player.team !== Team.SPECTATORS) {
            announceError(player, `Ставки может делать только зритель.`);
            return;
        }
        if (amount < MIN_BET) {
            announceError(player, `Минимальная ставка — ${formatCoins(MIN_BET)}.`);
            return;
        }
        const auth = getAuth(player);
        if (pendingBets.has(auth)) {
            announceError(player, `У вас уже есть активная ставка на этот матч.`);
            return;
        }
        const balance = await db.getBalance(auth);
        if (balance < amount) {
            announceError(player, `Недостаточно монет. У вас ${formatCoins(balance)}, нужно ${formatCoins(amount)}.`);
            return;
        }
        // Re-check swapMode after the awaits above — the window could have
        // closed (or the bettor could have been subbed in) while this bet
        // was in flight.
        if (!state.swapMode || player.team !== Team.SPECTATORS) {
            announceError(player, `Ставки принимаются только во время замен капитанов перед началом матча.`);
            return;
        }
        const charged = await db.spendCoins(auth, player.name, amount);
        if (!charged) {
            announceError(player, `Недостаточно монет.`);
            return;
        }
        const odds = (await computeOdds())[team];
        pendingBets.set(auth, { playerId: player.id, playerName: player.name, team, amount, odds });
        room.sendAnnouncement(
            `💰 ${player.name} ставит ${formatCoins(amount)} на ${teamName(team)} (кэф x${odds.toFixed(2)}) !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    // Called from events/movement.js's onPlayerTeamChange on EVERY team
    // change — a no-op unless this player actually has a pending bet and
    // has just landed on a real team (a captain subbing them in mid-swap,
    // see team/swap.js's swapModeFunction). Betting on a match you're now
    // PLAYING in makes no sense, so the stake comes straight back.
    async function refundIfSubbedIn(player) {
        const auth = getAuth(player);
        const bet = pendingBets.get(auth);
        if (!bet || player.team === Team.SPECTATORS) return;
        pendingBets.delete(auth);
        await db.addCoins(auth, player.name, bet.amount);
        room.sendAnnouncement(
            `🔄 ${player.name} был выставлен на матч капитаном — ставка ${formatCoins(bet.amount)} возвращена.`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    // Called from entry.js's endGame(winner) alongside awardMatchCoins — a
    // draw (winner outside Team.RED/Team.BLUE, same convention as
    // roomStats.js's own state.lastWinner handling) refunds every stake
    // instead of confiscating it: nobody's bet was actually wrong.
    async function resolveBets(winner) {
        if (pendingBets.size === 0) return;
        const bets = [...pendingBets.entries()];
        pendingBets.clear();
        const isDraw = winner !== Team.RED && winner !== Team.BLUE;
        for (const [auth, bet] of bets) {
            if (isDraw) {
                await db.addCoins(auth, bet.playerName, bet.amount);
                if (isOnline(bet.playerId)) {
                    room.sendAnnouncement(
                        `🔁 Матч завершился вничью — ваша ставка ${formatCoins(bet.amount)} возвращена.`,
                        bet.playerId,
                        announcementColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
                continue;
            }
            if (bet.team === winner) {
                const payout = Math.round(bet.amount * bet.odds);
                await db.addCoins(auth, bet.playerName, payout);
                if (isOnline(bet.playerId)) {
                    room.sendAnnouncement(
                        `🏆 Ваша ставка на ${teamName(winner)} сыграла ! Выигрыш: ${formatCoins(payout)} (кэф x${bet.odds.toFixed(2)}).`,
                        bet.playerId,
                        successColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                }
            } else if (isOnline(bet.playerId)) {
                room.sendAnnouncement(
                    `❌ Ваша ставка на ${teamName(bet.team)} не сыграла. Потеряно: ${formatCoins(bet.amount)}.`,
                    bet.playerId,
                    errorColor,
                    'bold',
                    HaxNotification.CHAT
                );
            }
        }
    }

    return {
        betCommand,
        announceOdds,
        refundIfSubbedIn,
        resolveBets,
    };
};
