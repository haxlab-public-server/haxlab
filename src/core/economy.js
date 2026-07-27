/*
 * Coin economy: coins for wins/losses/playtime, spent in !shop on cosmetics
 * (see core/shopItems.js for the catalog) worn via !equip and shown in
 * !inventory.
 *
 * Three independent equip slots — 'form', 'size' and 'goalAnimation' — so
 * owning/wearing one never touches the others. An item's `type` is always
 * the same string as its slot name, so no mapping table is needed between
 * the two.
 *
 * 'size' and 'goalAnimation' are both personal, per-player, POST-GOAL-ONLY
 * effects — a radius bump and an avatar flash respectively, triggered on the
 * scorer at the moment they score and reverted a few seconds later. Neither
 * is ever applied while a match is actually being played, on purpose: 'size'
 * changes the real physics collision radius, so making it a standing equip
 * would mean spending coins to change the game's balance. Confined to the
 * celebration window, it never affects ongoing play (see playGoalSizeEffect).
 *
 * 'form' is NOT personal — it's a whole-SIDE decision, applied with a single
 * room.setTeamColors(team, angle, textColor, colors) call per side rather
 * than touching individual players' discs. A side wears whichever form its
 * captain (state.teamRed[0]/state.teamBlue[0]) has equipped, or a random
 * pick among teammates who have one if the captain doesn't (see
 * determineSideForm). If both sides land on the same form, red wears its
 * home color and blue switches to its away color so they're never identical
 * (see applyTeamForms).
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
    getRandomInt,
}) {
    const WIN_COINS = 50;
    const LOSS_COINS = 25;
    const PLAYTIME_INTERVAL_SECONDS = 10 * 60;
    const PLAYTIME_COINS = 10;
    const GOAL_CELEBRATION_DURATION_MS = 3000;

    const itemsById = new Map(items.map((item) => [item.id, item]));
    const CATEGORY_LABELS = { form: 'Формы', size: 'Размер', goalAnimation: 'Анимации гола' };

    function getAuth(player) {
        return authArray[player.id][0];
    }

    // Private to the player only (id, not null) — nobody else needs to see
    // every payout scroll past in the room chat. "Баланс: X (+Y монеток)"
    // per the requested format: new total first, the just-earned delta after.
    function notifyCoinsEarned(player, amount, newBalance) {
        room.sendAnnouncement(
            `💰 Баланс: ${newBalance} (+${formatCoins(amount)})`,
            player.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    /* COIN AWARDS */

    // Called from endGame() for every match regardless of team size (1v1 up
    // to a full house) — unlike the quals stats/leaderboard, which only ever
    // track a genuine full 4v4 house (see roomStats.js), the economy is
    // meant to reward any play. A draw (Team.SPECTATORS) pays everyone the
    // loss rate — nobody "won", so nobody gets the win rate either.
    async function awardMatchCoins(winner) {
        async function payAndNotify(player, amount) {
            const auth = getAuth(player);
            await db.addCoins(auth, player.name, amount);
            const newBalance = await db.getBalance(auth);
            notifyCoinsEarned(player, amount, newBalance);
        }
        if (winner === Team.SPECTATORS) {
            await Promise.all([...state.teamRed, ...state.teamBlue].map((player) => payAndNotify(player, LOSS_COINS)));
            return;
        }
        const winners = winner === Team.RED ? state.teamRed : state.teamBlue;
        const losers = winner === Team.RED ? state.teamBlue : state.teamRed;
        await Promise.all([
            ...winners.map((player) => payAndNotify(player, WIN_COINS)),
            ...losers.map((player) => payAndNotify(player, LOSS_COINS)),
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
                db.addCoins(auth, player.name, PLAYTIME_COINS)
                    .then(() => db.getBalance(auth))
                    .then((newBalance) => notifyCoinsEarned(player, PLAYTIME_COINS, newBalance))
                    .catch((err) => console.error('[economy] addCoins (playtime) failed:', err));
                playtimeSecondsSinceLastPayout.set(auth, accumulated - PLAYTIME_INTERVAL_SECONDS);
            } else {
                playtimeSecondsSinceLastPayout.set(auth, accumulated);
            }
        }
    }

    /* COSMETIC APPLICATION */

    // A side's form isn't a personal choice — it's whichever form item its
    // captain (state.teamRed[0]/state.teamBlue[0], the same "captain" concept
    // team/choosing.js already uses for picking) has equipped, or — if the
    // captain hasn't equipped one — a random pick among teammates who have.
    // Returns { item, sourcePlayer } (not just a color) — the caller still
    // needs to decide home/away, and announceTeamForms below needs to credit
    // whoever the form actually came from.
    async function determineSideForm(teamPlayers) {
        if (teamPlayers.length === 0) return null;
        const captain = teamPlayers[0];
        const captainEquipped = await db.getEquipped(getAuth(captain));
        if (captainEquipped.form) {
            const item = itemsById.get(captainEquipped.form);
            return item ? { item, sourcePlayer: captain } : null;
        }

        const equippedList = await Promise.all(teamPlayers.map((p) => db.getEquipped(getAuth(p))));
        const candidates = teamPlayers
            .map((player, i) => ({ player, formId: equippedList[i].form }))
            .filter((c) => c.formId);
        if (candidates.length === 0) return null;
        const chosen = candidates[getRandomInt(candidates.length)];
        const item = itemsById.get(chosen.formId);
        return item ? { item, sourcePlayer: chosen.player } : null;
    }

    // room.setTeamColors(team, angle, textColor, colors) sets a whole side's
    // jersey in one call — no need to touch individual players' discs at
    // all. A "kit" is exactly setTeamColors' own (colors, textColor, angle)
    // triple, so an item's home/away (see shopItems.js) can be passed
    // straight through. Fallen back to whenever a side has no form active,
    // so a side never keeps wearing a stale kit from before its last
    // form-owner left/switched (setTeamColors doesn't auto-revert on its own).
    const DEFAULT_RED_KIT = { colors: [0xe56e56], textColor: 0xffffff, angle: 0 };
    const DEFAULT_BLUE_KIT = { colors: [0x6a8ef5], textColor: 0xffffff, angle: 0 };

    // Recomputes and re-applies BOTH sides' colors — call this on any roster
    // change to either team (a new captain, a teammate joining/leaving that
    // changes the random-fallback pool, etc.), not just for whoever actually
    // moved, since it also has to re-check whether the two sides now clash.
    // Returns what it determined for each side (or null) so announceTeamForms
    // below can reuse the same computation instead of querying the DB again.
    async function applyTeamForms() {
        const [red, blue] = await Promise.all([
            determineSideForm(state.teamRed),
            determineSideForm(state.teamBlue),
        ]);

        let redKit = red ? red.item.home : null;
        let blueKit = blue ? blue.item.home : null;
        // Same form on both sides would mean identical kits — red keeps
        // home, blue switches to its away variant so they're never twinning.
        if (red && blue && red.item.id === blue.item.id) {
            blueKit = blue.item.away;
        }
        redKit ??= DEFAULT_RED_KIT;
        blueKit ??= DEFAULT_BLUE_KIT;

        room.setTeamColors(Team.RED, redKit.angle, redKit.textColor, redKit.colors);
        room.setTeamColors(Team.BLUE, blueKit.angle, blueKit.textColor, blueKit.colors);

        return { red, blue };
    }

    // Match-start-only announcement (unlike applyTeamForms, which also runs
    // silently on every roster change) — credits whoever the form actually
    // came from (the captain, or the teammate it fell back to), not just
    // "the side has this form". Says nothing at all if neither side has any
    // custom form in play.
    async function announceTeamForms() {
        const { red, blue } = await applyTeamForms();
        if (!red && !blue) return;
        const parts = [];
        if (red) parts.push(`красных: ${red.item.name} (${red.sourcePlayer.name})`);
        if (blue) parts.push(`синих: ${blue.item.name} (${blue.sourcePlayer.name})`);
        room.sendAnnouncement(`Форма ${parts.join(', ')}`, null, announcementColor, 'bold', HaxNotification.CHAT);
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
        }, GOAL_CELEBRATION_DURATION_MS);
    }

    // Same idea as playGoalAnimation, but for the scorer's disc radius —
    // deliberately never applied at any other time (no re-apply on join/team
    // change/match start), since 'size' is a real physics collision radius
    // and this is a coin-shop cosmetic, not a paid gameplay advantage.
    // Restores the EXACT radius the player had a moment ago (captured live
    // via getPlayerDiscProperties) rather than some assumed map default, so
    // it's correct regardless of stadium or any other effect already in play.
    async function playGoalSizeEffect(player) {
        const equipped = await db.getEquipped(getAuth(player));
        if (!equipped.size) return;
        const item = itemsById.get(equipped.size);
        if (!item) return;
        const original = room.getPlayerDiscProperties(player.id);
        if (!original) return;
        room.setPlayerDiscProperties(player.id, { radius: item.radius });
        setTimeout(() => {
            if (state.playersAll.some((p) => p.id === player.id)) {
                room.setPlayerDiscProperties(player.id, { radius: original.radius });
            }
        }, GOAL_CELEBRATION_DURATION_MS);
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

    async function balanceCommand(player, message) {
        const balance = await db.getBalance(getAuth(player));
        room.sendAnnouncement(`💰 Ваш баланс: ${formatCoins(balance)}`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
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
        // A form is a whole-side decision, not personal — equipping one can
        // change what the player's ENTIRE team wears (if they're the
        // captain, or the only form-owner on their side), so this
        // recomputes both sides rather than just re-applying to `player`.
        // 'size' has no immediate effect at all — it only ever shows up on
        // this player's next goal (see playGoalSizeEffect).
        if (item.type === 'form') await applyTeamForms();
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
        applyTeamForms,
        announceTeamForms,
        playGoalAnimation,
        playGoalSizeEffect,
        shopCommand,
        inventoryCommand,
        equipCommand,
        addCoinsCommand,
        balanceCommand,
    };
};
