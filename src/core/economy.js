/*
 * Coin economy: coins for wins/losses/playtime, spent in !shop on cosmetics
 * (see core/shopItems.js for the catalog) worn via !equip and shown in
 * !inventory.
 *
 * Three independent equip slots — 'form' (a disc color override), 'size' (a
 * disc radius override — also the real physics collision radius, not purely
 * cosmetic) and 'goalAnimation' (a brief avatar flash on scoring, reverted a
 * few seconds later) — so owning/wearing one never touches the others. An
 * item's `type` is always the same string as its slot name, so no mapping
 * table is needed between the two.
 *
 * Mutable room state is reached through `state`, never captured by value.
 */
module.exports = function createEconomy({
    room,
    state,
    authArray,
    db,
    items,
    Team,
    State,
    HaxNotification,
    announcementColor,
    errorColor,
    formatCoins,
}) {
    const WIN_COINS = 50;
    const LOSS_COINS = 25;
    const PLAYTIME_INTERVAL_SECONDS = 10 * 60;
    const PLAYTIME_COINS = 10;
    const GOAL_ANIMATION_DURATION_MS = 3000;

    const itemsById = new Map(items.map((item) => [item.id, item]));
    const CATEGORY_LABELS = { form: 'Формы', size: 'Размер', goalAnimation: 'Анимации гола' };

    function getAuth(player) {
        return authArray[player.id][0];
    }

    /* COIN AWARDS */

    // Called from endGame() for every match regardless of team size (1v1 up
    // to a full house) — unlike the quals stats/leaderboard, which only ever
    // track a genuine full 4v4 house (see roomStats.js), the economy is
    // meant to reward any play. A draw (Team.SPECTATORS) pays everyone the
    // loss rate — nobody "won", so nobody gets the win rate either.
    async function awardMatchCoins(winner) {
        if (winner === Team.SPECTATORS) {
            await Promise.all(
                [...state.teamRed, ...state.teamBlue].map((player) => db.addCoins(getAuth(player), player.name, LOSS_COINS))
            );
            return;
        }
        const winners = winner === Team.RED ? state.teamRed : state.teamBlue;
        const losers = winner === Team.RED ? state.teamBlue : state.teamRed;
        await Promise.all([
            ...winners.map((player) => db.addCoins(getAuth(player), player.name, WIN_COINS)),
            ...losers.map((player) => db.addCoins(getAuth(player), player.name, LOSS_COINS)),
        ]);
    }

    // Wall-clock playtime, independent of any single match's own clock (which
    // resets every game) — a per-auth running counter of seconds accumulated
    // since their last 10-minute payout. Only counts actually being on a team
    // while the game is live: not spectating, not AFK (state.teamRed/teamBlue
    // already exclude AFK players — see updateTeams() in entry.js), not
    // between rounds. Resetting on a bot restart loses at most a few minutes'
    // partial progress — not persisted, not worth the complexity.
    const playtimeSecondsSinceLastPayout = new Map();
    function tickPlaytime(elapsedSeconds) {
        if (state.gameState !== State.PLAY) return;
        for (const player of [...state.teamRed, ...state.teamBlue]) {
            const auth = getAuth(player);
            const accumulated = (playtimeSecondsSinceLastPayout.get(auth) ?? 0) + elapsedSeconds;
            if (accumulated >= PLAYTIME_INTERVAL_SECONDS) {
                db.addCoins(auth, player.name, PLAYTIME_COINS).catch((err) => console.error('[economy] addCoins (playtime) failed:', err));
                playtimeSecondsSinceLastPayout.set(auth, accumulated - PLAYTIME_INTERVAL_SECONDS);
            } else {
                playtimeSecondsSinceLastPayout.set(auth, accumulated);
            }
        }
    }

    /* COSMETIC APPLICATION */

    // Covers both disc-property slots (form's color, size's radius) in one
    // call — HaxBall resets a disc's custom properties on stadium changes/
    // restarts, so this needs re-calling whenever a player actually lands on
    // a team (join-then-balanced, mid-game swap, a fresh match), not just once.
    async function applyEquippedDiscCosmetics(player) {
        const equipped = await db.getEquipped(getAuth(player));
        const discProperties = {};
        const formItem = equipped.form && itemsById.get(equipped.form);
        if (formItem) discProperties.color = formItem.color;
        const sizeItem = equipped.size && itemsById.get(equipped.size);
        if (sizeItem) discProperties.radius = sizeItem.radius;
        if (Object.keys(discProperties).length > 0) {
            room.setPlayerDiscProperties(player.id, discProperties);
        }
    }

    // Not a persistent look — briefly swaps the scorer's avatar in, then back
    // out, so it reads as a "goal animation" rather than a permanent skin.
    async function playGoalAnimation(player) {
        const equipped = await db.getEquipped(getAuth(player));
        if (!equipped.goalAnimation) return;
        const item = itemsById.get(equipped.goalAnimation);
        if (!item) return;
        room.setPlayerAvatar(player.id, item.avatar);
        setTimeout(() => {
            // The scorer may have left in the meantime — only revert if
            // they're still actually in the room.
            if (state.playersAll.some((p) => p.id === player.id)) {
                room.setPlayerAvatar(player.id, null);
            }
        }, GOAL_ANIMATION_DURATION_MS);
    }

    /* COMMANDS */

    function formatItemLine(item, owned, equippedId) {
        const tag = !owned ? '' : item.id === equippedId ? ' [надето]' : ' [куплено]';
        return `${item.id} — ${item.name} (${formatCoins(item.price)})${tag}`;
    }

    function formatCatalogSection(type, owned, equipped) {
        const lines = items.filter((i) => i.type === type).map((i) => formatItemLine(i, owned.includes(i.id), equipped[type]));
        return `${CATEGORY_LABELS[type]}:\n${lines.join('\n')}`;
    }

    async function shopCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = getAuth(player);

        if (msgArray.length === 0) {
            const [balance, owned, equipped] = await Promise.all([db.getBalance(auth), db.getOwnedItemIds(auth), db.getEquipped(auth)]);
            const sections = ['form', 'size', 'goalAnimation'].map((type) => formatCatalogSection(type, owned, equipped)).join('\n');
            room.sendAnnouncement(
                `🛒 Магазин (баланс: ${formatCoins(balance)})\n${sections}\nКупить: !shop <id>. Надеть: !equip <id>.`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        const item = itemsById.get(msgArray[0]);
        if (!item) {
            room.sendAnnouncement(`Нет такого товара. Введите "!shop" для списка.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const bought = await db.buyItem(auth, player.name, item.id, item.price);
        if (!bought) {
            const [balance, alreadyOwned] = await Promise.all([db.getBalance(auth), db.ownsItem(auth, item.id)]);
            room.sendAnnouncement(
                alreadyOwned
                    ? `У вас уже есть "${item.name}".`
                    : `Недостаточно монет. Нужно ${formatCoins(item.price)}, у вас ${formatCoins(balance)}.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }
        room.sendAnnouncement(`✔️ Куплено: ${item.name} за ${formatCoins(item.price)} !`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    async function inventoryCommand(player, message) {
        const auth = getAuth(player);
        const owned = await db.getOwnedItemIds(auth);
        if (owned.length === 0) {
            room.sendAnnouncement(`У вас пока нет купленных аксессуаров. Загляните в "!shop".`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const equipped = await db.getEquipped(auth);
        const lines = owned
            .map((id) => itemsById.get(id))
            .filter(Boolean)
            .map((item) => formatItemLine(item, true, equipped[item.type]));
        room.sendAnnouncement(`🎒 Ваши аксессуары:\n${lines.join('\n')}`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    async function equipCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const itemId = msgArray[0];
        if (!itemId) {
            room.sendAnnouncement(`Использование: !equip <id>. Список ваших аксессуаров — "!inventory".`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const item = itemsById.get(itemId);
        if (!item) {
            room.sendAnnouncement(`Нет такого аксессуара.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const auth = getAuth(player);
        const owned = await db.ownsItem(auth, item.id);
        if (!owned) {
            room.sendAnnouncement(`Вы еще не купили "${item.name}". Загляните в "!shop".`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        await db.setEquipped(auth, item.type, item.id);
        if (item.type === 'form' || item.type === 'size') await applyEquippedDiscCosmetics(player);
        room.sendAnnouncement(`✔️ Надето: ${item.name} !`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    // Testing/support tool, not a player-facing command — gated to
    // Role.MASTER in commands.js, same as !banauth/!setadmin/etc. Target
    // accepts #<id> (online) or a raw auth (offline), same as !banauth.
    // Amount can be negative too, to test/undo a grant without going
    // through the DB by hand.
    async function addCoinsCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const target = msgArray[0];
        const amount = parseInt(msgArray[1]);
        if (!target || !Number.isInteger(amount)) {
            room.sendAnnouncement(`Использование: !addcoins <#id|auth> <количество>`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }

        let auth, targetName;
        if (target[0] === '#') {
            const id = parseInt(target.substring(1));
            const targetPlayer = state.playersAll.find((p) => p.id === id);
            if (!targetPlayer) {
                room.sendAnnouncement(`Игрока с таким ID нет в комнате.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                return;
            }
            auth = getAuth(targetPlayer);
            targetName = targetPlayer.name;
        } else {
            auth = target;
            const targetPlayer = state.playersAll.find((p) => getAuth(p) === auth);
            targetName = targetPlayer ? targetPlayer.name : auth;
        }

        await db.addCoins(auth, targetName, amount);
        const newBalance = await db.getBalance(auth);
        room.sendAnnouncement(
            `✔️ ${targetName}: ${amount >= 0 ? '+' : ''}${amount} монет. Баланс: ${formatCoins(newBalance)}`,
            player.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    return {
        awardMatchCoins,
        tickPlaytime,
        applyEquippedDiscCosmetics,
        playGoalAnimation,
        shopCommand,
        inventoryCommand,
        equipCommand,
        addCoinsCommand,
    };
};
