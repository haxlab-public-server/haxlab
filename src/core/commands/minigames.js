/*
 * Spectator-only coin minigames: !minigames coinflip/russianroulette
 * #<id> <ставка> challenges another spectator to a wager; the invited
 * player accepts with !play. Both commands are registered at Role.PLAYER
 * in commands.js — the actual "must be a spectator" restriction is
 * enforced here instead, since it's about live game state (player.team),
 * not a role.
 *
 * Pending invites are kept in a plain in-memory Map, keyed by the invited
 * player's id — there's at most one live invite per target at a time, and
 * none of this needs to survive a bot restart (same reasoning as
 * AFKSet/muteArray elsewhere: ephemeral per-session state, not routed
 * through `state` or the DB).
 *
 * Stakes move through db.spendCoins — an atomic check-and-deduct (see
 * db/sqlite.js), so two concurrent !play accepts can never both succeed
 * off a balance that only covered one of them.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createMinigameCommands({
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
    getRandomInt,
    startBlackjackBotGame,
    runPvpBlackjack,
}) {
    const INVITE_DURATION_MS = 30 * 1000;
    const CHAMBERS = 6;
    const SUSPENSE_DELAY_MS = 1200;

    function getAuth(player) {
        return authArray[player.id][0];
    }

    function isOnline(playerId) {
        return state.playersAll.some((p) => p.id === playerId);
    }

    function announceError(player, text) {
        room.sendAnnouncement(text, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Everything about a match in progress (suspense beats, per-turn
    // results) is private to the two players in it — only the initial
    // challenge and the final winner announcement go to the whole room (see
    // minigamesCommand/playCommand below). room.sendAnnouncement has no
    // multi-target form, so this is two targeted sends rather than one
    // null (broadcast) one; skips whichever side has since disconnected,
    // same as every other targeted send in this file.
    function sendToMatch(challenger, target, text, color) {
        if (isOnline(challenger.id)) room.sendAnnouncement(text, challenger.id, color, 'bold', HaxNotification.CHAT);
        if (isOnline(target.id)) room.sendAnnouncement(text, target.id, color, 'bold', HaxNotification.CHAT);
    }

    async function runCoinflip(challenger, target, challengerAuth, targetAuth) {
        sendToMatch(challenger, target, `🪙 Монетка подброшена...`, announcementColor);
        await sleep(SUSPENSE_DELAY_MS);
        const challengerWins = getRandomInt(2) === 0;
        return challengerWins
            ? { winner: challenger, winnerAuth: challengerAuth }
            : { winner: target, winnerAuth: targetAuth };
    }

    // 6 chambers, 1 bullet, alternating trigger pulls starting with the
    // challenger — turns 0/2/4 are the challenger's, 1/3/5 the target's, an
    // even 3-3 split of a uniformly random bullet position, so this is a
    // fair 50/50 regardless of turn order despite "going first".
    async function runRussianRoulette(challenger, target, challengerAuth, targetAuth) {
        sendToMatch(challenger, target, `🔫 Барабан заряжается...`, announcementColor);
        await sleep(SUSPENSE_DELAY_MS);
        const bulletChamber = getRandomInt(CHAMBERS);
        for (let turn = 0; turn <= bulletChamber; turn++) {
            const shooter = turn % 2 === 0 ? challenger : target;
            await sleep(SUSPENSE_DELAY_MS);
            if (turn === bulletChamber) {
                sendToMatch(challenger, target, `🔫 ${shooter.name} жмет на курок... 💥 БАХ !`, errorColor);
                return shooter.id === challenger.id
                    ? { winner: target, winnerAuth: targetAuth }
                    : { winner: challenger, winnerAuth: challengerAuth };
            }
            sendToMatch(challenger, target, `🔫 ${shooter.name} жмет на курок... щёлк.`, announcementColor);
        }
        // Unreachable (bulletChamber is always hit by the loop above), kept
        // only so this never silently returns undefined if CHAMBERS/the
        // random range is ever changed.
        throw new Error('russianroulette: no shot resolved the bullet chamber');
    }

    const GAMES = {
        coinflip: { label: 'Монетка', run: runCoinflip },
        russianroulette: { label: 'Русская рулетка', run: runRussianRoulette },
        blackjack: { label: 'Блэкджек', run: runPvpBlackjack },
    };

    // Short aliases for the GAMES keys above ("!mg cf"/"!mg rr"/"!mg bj"
    // instead of the full name) — resolved to the canonical key
    // immediately, in minigamesCommand, so pendingInvites/playCommand/GAMES
    // itself only ever see the canonical key and never need to know an
    // alias was typed at all.
    const GAME_ALIASES = { cf: 'coinflip', rr: 'russianroulette', bj: 'blackjack' };
    function resolveGameKey(input) {
        return GAME_ALIASES[input] ?? input;
    }

    // target player id -> { challengerId, challengerAuth, gameKey, stake, timeoutHandle }
    const pendingInvites = new Map();

    function clearInvite(targetId) {
        const invite = pendingInvites.get(targetId);
        if (invite) {
            clearTimeout(invite.timeoutHandle);
            pendingInvites.delete(targetId);
        }
    }

    async function minigamesCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const gameKey = resolveGameKey((msgArray[0] ?? '').toLowerCase());
        const game = GAMES[gameKey];
        if (!game) {
            announceError(player, `Использование: !minigames <coinflip(cf)|russianroulette(rr)|blackjack(bj)> [#<id>] <ставка>. Доступно только зрителям.`);
            return;
        }
        if (player.team !== Team.SPECTATORS) {
            announceError(player, `Мини-игры доступны только зрителям (тем, кто сейчас не играет в матче).`);
            return;
        }
        const targetToken = msgArray[1];
        const targetLooksLikeId = targetToken != null && targetToken[0] === '#';

        // Blackjack alone supports a target-less form — play against the
        // bot dealer instead of another spectator. Every other game still
        // requires the usual #<id> challenge.
        if (gameKey === 'blackjack' && !targetLooksLikeId) {
            const stake = parseInt(targetToken);
            if (!Number.isInteger(stake) || stake <= 0) {
                announceError(player, `Использование: !minigames blackjack <ставка> — игра с ботом. Или !minigames blackjack #<id> <ставка> — игра с игроком. Пример: !minigames blackjack 100.`);
                return;
            }
            const auth = getAuth(player);
            const balance = await db.getBalance(auth);
            if (balance < stake) {
                announceError(player, `Недостаточно монет. У вас ${formatCoins(balance)}, нужно ${formatCoins(stake)}.`);
                return;
            }
            await startBlackjackBotGame(player, auth, stake);
            return;
        }

        const stake = parseInt(msgArray[2]);
        if (!targetLooksLikeId || !Number.isInteger(stake) || stake <= 0) {
            announceError(player, `Использование: !minigames ${gameKey} #<id> <ставка>. Пример: !minigames ${gameKey} #3 100.`);
            return;
        }
        const targetId = parseInt(targetToken.substring(1));
        const target = state.playersAll.find((p) => p.id === targetId);
        if (!target) {
            announceError(player, `Такого игрока нет в комнате.`);
            return;
        }
        if (target.id === player.id) {
            announceError(player, `Нельзя пригласить самого себя !`);
            return;
        }
        if (target.team !== Team.SPECTATORS) {
            announceError(player, `${target.name} сейчас не зритель.`);
            return;
        }
        const auth = getAuth(player);
        const balance = await db.getBalance(auth);
        if (balance < stake) {
            announceError(player, `Недостаточно монет. У вас ${formatCoins(balance)}, нужно ${formatCoins(stake)}.`);
            return;
        }
        if (pendingInvites.has(target.id)) {
            announceError(player, `У ${target.name} уже есть активное приглашение — подождите.`);
            return;
        }

        const timeoutHandle = setTimeout(() => {
            pendingInvites.delete(target.id);
            if (isOnline(target.id)) {
                room.sendAnnouncement(`⌛ Приглашение от ${player.name} истекло.`, target.id, errorColor, 'bold', HaxNotification.CHAT);
            }
            if (isOnline(player.id)) {
                room.sendAnnouncement(`⌛ ${target.name} не принял(а) приглашение вовремя.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            }
        }, INVITE_DURATION_MS);
        pendingInvites.set(target.id, { challengerId: player.id, challengerAuth: auth, gameKey, stake, timeoutHandle });

        room.sendAnnouncement(
            `🎲 ${player.name} вызывает ${target.name} на "${game.label}" на ${formatCoins(stake)} !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        room.sendAnnouncement(
            `Вы приглашены в "${game.label}" от ${player.name} на ${formatCoins(stake)}. Введите "!play" в течение ${INVITE_DURATION_MS / 1000} секунд, чтобы принять.`,
            target.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function playCommand(player, message) {
        const invite = pendingInvites.get(player.id);
        if (!invite) {
            announceError(player, `У вас нет активных приглашений в мини-игры.`);
            return;
        }
        const challenger = state.playersAll.find((p) => p.id === invite.challengerId);
        if (!challenger) {
            clearInvite(player.id);
            announceError(player, `Игрок, который вас пригласил, уже покинул комнату.`);
            return;
        }
        if (player.team !== Team.SPECTATORS || challenger.team !== Team.SPECTATORS) {
            clearInvite(player.id);
            announceError(player, `Один из вас больше не зритель — приглашение отменено.`);
            return;
        }
        clearInvite(player.id);

        const { stake, gameKey, challengerAuth } = invite;
        const targetAuth = getAuth(player);

        const challengerCharged = await db.spendCoins(challengerAuth, challenger.name, stake);
        if (!challengerCharged) {
            sendToMatch(challenger, player, `У ${challenger.name} больше не хватает монет на ставку — игра отменена.`, errorColor);
            return;
        }
        const targetCharged = await db.spendCoins(targetAuth, player.name, stake);
        if (!targetCharged) {
            await db.addCoins(challengerAuth, challenger.name, stake);
            announceError(player, `Недостаточно монет для ставки ${formatCoins(stake)}.`);
            return;
        }

        const pot = stake * 2;
        const game = GAMES[gameKey];
        sendToMatch(challenger, player, `${game.label}: ${challenger.name} vs ${player.name}, банк ${formatCoins(pot)} !`, announcementColor);
        const { winner, winnerAuth } = await game.run(challenger, player, challengerAuth, targetAuth);

        // Only blackjack can ever produce this (both bust, or an equal
        // total) — coinflip/russianroulette always name a winner.
        if (winner == null) {
            await db.addCoins(challengerAuth, challenger.name, stake);
            await db.addCoins(targetAuth, player.name, stake);
            sendToMatch(challenger, player, `🤝 Ничья ! Ставки возвращены.`, announcementColor);
            return;
        }

        await db.addCoins(winnerAuth, winner.name, pot);
        const newBalance = await db.getBalance(winnerAuth);
        room.sendAnnouncement(`🏆 ${winner.name} побеждает и забирает ${formatCoins(pot)} !`, null, successColor, 'bold', HaxNotification.CHAT);
        if (isOnline(winner.id)) {
            room.sendAnnouncement(`💰 Баланс: ${formatCoins(newBalance)}`, winner.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
    }

    return {
        minigamesCommand,
        playCommand,
    };
};
