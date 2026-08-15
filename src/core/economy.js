/*
 * Coin economy: coins for wins/losses/playtime, spent in !shop on cosmetics
 * (see core/shopItems.js for the catalog) worn via !equip and shown in
 * !inventory.
 *
 * Four independent equip slots — 'form', 'size', 'avatar' and
 * 'goalAnimation' — so owning/wearing one never touches the others. An
 * item's `type` is always the same string as its slot name, so no mapping
 * table is needed between the two. 'avatar' (fire/star/skull/crown) and
 * 'goalAnimation' (smoke/fireworks) used to be one slot/type with a runtime
 * split (isBigGoalAnimation) — split for real once it became clear they're
 * not the same kind of thing: a player can now have one of each equipped and
 * have both fire on the same goal (see playGoalAnimation).
 *
 * 'size', 'avatar' and 'goalAnimation' are all personal, per-player,
 * POST-GOAL-ONLY effects — a radius bump, an avatar flash, and a disc burst
 * respectively, triggered on the scorer at the moment they score and
 * reverted (or, for goalAnimation, simply finished) a few seconds later.
 * None of these are ever applied while a match is actually being played, on
 * purpose: 'size' changes the real physics collision radius, so making it a
 * standing equip
 * would mean spending coins to change the game's balance. Confined to the
 * celebration window, it never affects ongoing play (see playGoalSizeEffect).
 * 'small'/'big' are further upgradeable — 10 levels each, ±1 radius per
 * level off the default 15, priced 1000 more per level (level N costs
 * N*1000 — see shopItems.js's `upgradeable` items and
 * priceForLevel/radiusForLevel below) — !shop <id> on an already-owned
 * tiered item upgrades it in place rather than rejecting "already owned".
 * (Was 5 levels of ±2 before — see scripts/migrate-size-levels.js for the
 * one-time level-doubling that kept existing owners' actual radius the
 * same across that change.)
 *
 * 'form' is NOT personal — it's a whole-SIDE decision, applied with a single
 * room.setTeamColors(team, angle, textColor, colors) call per side rather
 * than touching individual players' discs. A side wears whichever form its
 * captain (state.teamRed[0]/state.teamBlue[0]) has equipped, or a random
 * pick among teammates who have one if the captain doesn't (see
 * determineSideForm). If both sides land on the same form, red wears its
 * home color and blue switches to its away color so they're never identical
 * (see applyTeamForms).
 * Some forms are `vipOnly` (see shopItems.js) — these outrank a non-VIP
 * captain's own pick entirely: if ANY current VIP on a side has one
 * equipped, that's what the side wears (randomly chosen if more than one
 * VIP on the same side has one), before the captain's own choice is even
 * considered. Re-checked live on every call, not cached — a VIP form drops
 * out of consideration the instant its wearer's VIP itself lapses, same as
 * goalAnimation items' own access check (see hasGoalAnimationAccess).
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
    playSmokeAnimation,
    playFireworksAnimation,
    playBlackholeAnimation,
    Role,
    getRole,
}) {
    const WIN_COINS = 10;
    const LOSS_COINS = 5;
    const PLAYTIME_INTERVAL_SECONDS = 10 * 60;
    const PLAYTIME_COINS = 1;
    const GOAL_CELEBRATION_DURATION_MS = 3000;
    // Daily login streak (see claimDailyBonus, called from
    // events/movement.js's onPlayerJoin): day N pays N*DAILY_BONUS_STEP,
    // capping at day DAILY_MAX_STREAK — one more day after that wraps back
    // around to day 1 instead of growing forever.
    const DAILY_BONUS_STEP = 5;
    const DAILY_MAX_STREAK = 30;
    // Two clubmates (see commands/club.js) on the same side get a coin
    // bonus — applies uniformly to every payout (win, loss, playtime tick).
    const CLUB_TEAMMATE_MULTIPLIER = 1.25;
    // A current VIP+ earns double on every payout (win, loss, playtime
    // tick) — see applyVipBonus. Only for as long as VIP itself lasts, not
    // a permanent unlock.
    const VIP_EARNINGS_MULTIPLIER = 2;

    const itemsById = new Map(items.map((item) => [item.id, item]));
    const CATEGORY_LABELS = {
        form: 'Формы',
        size: 'Размер шара после гола',
        avatar: 'Аватарка после гола',
        goalAnimation: 'Анимации после гола',
    };

    const SMOKE_COLOR_ITEM_IDS = items.filter((item) => item.smokeColor).map((item) => item.id);
    // Every real (ownable/equippable) goalAnimation item — the 4 smoke
    // colors plus fireworks — EXCLUDING the 'smoke' bundle id itself (never
    // owned/equipped directly, see shopCommand's smokeFamily branch). This
    // is the exact set a current VIP gets surfaced in !inventory for free
    // (see inventoryCommand) and the set hasGoalAnimationAccess checks.
    const GOAL_ANIMATION_ITEM_IDS = items.filter((item) => item.type === 'goalAnimation' && !item.smokeFamily).map((item) => item.id);

    // goalAnimation items (smoke/fireworks) are a VIP perk: any CURRENT
    // VIP+ can play/equip one without ever owning it, re-checked live every
    // time (not cached at equip time) — a lapsed VIP's still-equipped
    // goalAnimation just stops firing the instant their VIP does, no
    // re-equip needed to restore it once VIP renews either. Buying one
    // outright (50000 coins) is the only way to keep it after VIP lapses.
    // 'avatar' items (fire/star/skull/crown) never call this at all —
    // ordinary coin-shop cosmetics, no access tier above plain ownership.
    async function hasGoalAnimationAccess(player, item) {
        if (getRole(player) >= Role.VIP) return true;
        return db.ownsItem(getAuth(player), item.id);
    }

    // Whether `auth` owns the smoke family — checked via a single
    // representative color rather than the (never actually owned, see
    // shopCommand's smokeFamily branch) bundle id itself, since buying any
    // one smoke color always grants every sibling atomically.
    function ownsSmokeFamily(auth) {
        return db.ownsItem(auth, SMOKE_COLOR_ITEM_IDS[0]);
    }

    // Level N's price/radius for an `upgradeable` size item (see
    // shopItems.js) — level 1 is the first purchase (level 0 -> 1), up
    // through item.maxLevel.
    function priceForLevel(item, level) {
        return item.basePrice + item.priceStep * (level - 1);
    }
    function radiusForLevel(item, level) {
        return item.baseRadius + item.direction * item.stepRadius * level;
    }

    function getAuth(player) {
        return authArray[player.id][0];
    }

    function getClubId(auth) {
        const membership = state.clubMembers.find((m) => m.auth === auth);
        return membership ? membership.clubId : null;
    }

    // True if `player` shares a club with at least one other player on
    // `sidePlayers` (their own side's roster) — a fresh lookup every payout
    // rather than a cached flag, since who's on which side changes far more
    // often than club membership itself.
    function hasClubmateOnSide(player, sidePlayers) {
        const clubId = getClubId(getAuth(player));
        if (clubId == null) return false;
        return sidePlayers.some((p) => p.id !== player.id && getClubId(getAuth(p)) === clubId);
    }

    function applyClubBonus(amount, player, sidePlayers) {
        return hasClubmateOnSide(player, sidePlayers) ? Math.round(amount * CLUB_TEAMMATE_MULTIPLIER) : amount;
    }

    // A perk of CURRENTLY being VIP+, not something earned once and kept —
    // re-checked live on every single payout (never cached), same
    // "re-checked every time" reasoning as hasGoalAnimationAccess/vipOnly
    // forms: the instant VIP lapses, earnings drop back to normal on the
    // very next payout, no different from any other VIP perk in this file.
    // Stacks with the club bonus above (club first, then VIP, both
    // multiplicative) rather than picking whichever is bigger — a VIP with
    // a clubmate on their side gets both boosts at once.
    function applyVipBonus(amount, player) {
        return getRole(player) >= Role.VIP ? Math.round(amount * VIP_EARNINGS_MULTIPLIER) : amount;
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
        async function payAndNotify(player, amount, sidePlayers) {
            const auth = getAuth(player);
            const boosted = applyVipBonus(applyClubBonus(amount, player, sidePlayers), player);
            await db.addCoins(auth, player.name, boosted);
            const newBalance = await db.getBalance(auth);
            notifyCoinsEarned(player, boosted, newBalance);
        }
        if (winner === Team.SPECTATORS) {
            await Promise.all([
                ...state.teamRed.map((player) => payAndNotify(player, LOSS_COINS, state.teamRed)),
                ...state.teamBlue.map((player) => payAndNotify(player, LOSS_COINS, state.teamBlue)),
            ]);
            return;
        }
        const winners = winner === Team.RED ? state.teamRed : state.teamBlue;
        const losers = winner === Team.RED ? state.teamBlue : state.teamRed;
        await Promise.all([
            ...winners.map((player) => payAndNotify(player, WIN_COINS, winners)),
            ...losers.map((player) => payAndNotify(player, LOSS_COINS, losers)),
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
        for (const side of [state.teamRed, state.teamBlue]) {
            for (const player of side) {
                const auth = getAuth(player);
                const accumulated = (playtimeSecondsSinceLastPayout.get(auth) ?? 0) + elapsedSeconds;
                if (accumulated >= PLAYTIME_INTERVAL_SECONDS) {
                    const amount = applyVipBonus(applyClubBonus(PLAYTIME_COINS, player, side), player);
                    db.addCoins(auth, player.name, amount)
                        .then(() => db.getBalance(auth))
                        .then((newBalance) => notifyCoinsEarned(player, amount, newBalance))
                        .catch((err) => console.error('[economy] addCoins (playtime) failed:', err));
                    playtimeSecondsSinceLastPayout.set(auth, accumulated - PLAYTIME_INTERVAL_SECONDS);
                } else {
                    playtimeSecondsSinceLastPayout.set(auth, accumulated);
                }
            }
        }
    }

    // Called once per player from onPlayerJoin (see events/movement.js) —
    // db.claimDailyBonus itself is what actually decides, atomically, whether
    // today's already been claimed and what the resulting streak/amount is;
    // this just reports the outcome. A silent no-op (no message at all) if
    // they already claimed today, so reconnecting/ghost-kick-rejoining never
    // spams the same player with "already claimed" noise.
    async function claimDailyBonus(player) {
        const auth = getAuth(player);
        const result = await db.claimDailyBonus(auth, player.name, DAILY_BONUS_STEP, DAILY_MAX_STREAK);
        if (!result) return;
        room.sendAnnouncement(
            `🎁 Ежедневный бонус: день ${result.streak}/${DAILY_MAX_STREAK}, +${formatCoins(result.amount)} ! Баланс: ${formatCoins(result.newBalance)}`,
            player.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    /* COSMETIC APPLICATION */

    // A side's form isn't a personal choice — it's whichever form item its
    // captain (state.teamRed[0]/state.teamBlue[0], the same "captain" concept
    // team/choosing.js already uses for picking) has equipped, or — if the
    // captain hasn't equipped one — a random pick among teammates who have.
    // `vipOnly` forms (see shopItems.js) outrank all of that: if any CURRENT
    // VIP on the side has one equipped, it wins outright, before the
    // captain's own pick is even looked at — a non-VIP captain's ordinary
    // form never overrides a teammate's VIP one. Everything is fetched and
    // filtered fresh on every call (no caching) specifically so a lapsed VIP
    // grant makes their vipOnly form stop counting immediately, without
    // needing to be re-equipped — same live-recheck reasoning as
    // hasGoalAnimationAccess.
    // Returns { item, sourcePlayer } (not just a color) — the caller still
    // needs to decide home/away, and announceTeamForms below needs to credit
    // whoever the form actually came from.
    async function determineSideForm(teamPlayers) {
        if (teamPlayers.length === 0) return null;
        const captain = teamPlayers[0];
        const equippedList = await Promise.all(teamPlayers.map((p) => db.getEquipped(getAuth(p))));
        const candidates = teamPlayers
            .map((player, i) => ({ player, item: itemsById.get(equippedList[i].form) }))
            .filter((c) => c.item);

        const vipCandidates = candidates.filter((c) => c.item.vipOnly && getRole(c.player) >= Role.VIP);
        if (vipCandidates.length > 0) {
            const chosen = vipCandidates[getRandomInt(vipCandidates.length)];
            return { item: chosen.item, sourcePlayer: chosen.player };
        }

        // Non-VIP-only candidates only from here — a vipOnly form equipped
        // by someone whose VIP has lapsed is simply invisible to the rest of
        // this function too, not just excluded from the priority tier above.
        const plainCandidates = candidates.filter((c) => !c.item.vipOnly);
        // Current-season forms outrank retired ones (see shopItems.js's
        // `retired`) the same way vipOnly outranks plain above: if ANYONE on
        // the side has a current form equipped, it's used — even over the
        // CAPTAIN's own retired one — and a retired form is only ever shown
        // when nobody on the side has a current one at all.
        const newCandidates = plainCandidates.filter((c) => !c.item.retired);
        const pickFrom = newCandidates.length > 0 ? newCandidates : plainCandidates.filter((c) => c.item.retired);

        const captainChoice = pickFrom.find((c) => c.player.id === captain.id);
        if (captainChoice) return { item: captainChoice.item, sourcePlayer: captain };

        if (pickFrom.length === 0) return null;
        const chosen = pickFrom[getRandomInt(pickFrom.length)];
        return { item: chosen.item, sourcePlayer: chosen.player };
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

    // Same ranking determineSideForm's own tiers already imply: vipOnly >
    // current-season plain > retired. Only used to break a TIE between two
    // DIFFERENT forms flagged as clashing (see clashesWith below) — it has
    // no bearing on which form a side picked in the first place.
    function formPriority(item) {
        if (item.vipOnly) return 2;
        if (item.retired) return 0;
        return 1;
    }

    // Whether two DIFFERENT forms are flagged as visually clashing (see
    // shopItems.js's `clashesWith`) — curated by hand per pair, same
    // reasoning as clashesWithDefault below (real color-distance math would
    // be its own can of worms; a short manually-checked list is simpler and
    // has no false positives). Checked symmetrically since the flag only
    // needs to live on one side of a pair.
    function formsClash(a, b) {
        return Boolean(a.clashesWith?.includes(b.id) || b.clashesWith?.includes(a.id));
    }

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
        } else if (red && blue && formsClash(red.item, blue.item)) {
            // Two DIFFERENT forms that are specifically flagged as visually
            // clashing (see shopItems.js's `clashesWith`) — e.g. a retired
            // form vs a current one, or a plain form vs a near-identical
            // vipOnly one. ONLY the flagged pairs defer like this; two
            // different forms that just happen to both be old (or both be
            // current) never force each other away. The lower-priority side
            // (see formPriority: vipOnly > current > retired; red wins an
            // exact tie, same as the same-form case above) wears away.
            if (formPriority(red.item) < formPriority(blue.item)) redKit = red.item.away;
            else blueKit = blue.item.away;
        } else {
            // The other side isn't wearing a form at all here (it's about to
            // fall back to DEFAULT_RED_KIT/DEFAULT_BLUE_KIT below) — a form
            // whose home kit is close to THAT default (see
            // clashesWithDefault in shopItems.js, e.g. crimson's deep reds
            // next to the default red kit) reads as near-identical to the
            // side with no form, same problem as two sides sharing a form.
            if (!red && blue && blue.item.clashesWithDefault === 'red') {
                blueKit = blue.item.away;
            }
            if (!blue && red && red.item.clashesWithDefault === 'blue') {
                redKit = red.item.away;
            }
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

    // Two independent celebrations, both checked and fired on every goal —
    // 'avatar' (a brief avatar swap) and 'goalAnimation' (a disc-based burst
    // at the goal just scored into) are separate equip slots now (see the
    // file-level comment above), so a player with one of each equipped sees
    // both at once. player.team is guaranteed to be the scoring side here —
    // the caller (gameManagement.js's onTeamGoal) only ever invokes
    // playGoalAnimation for a genuine goal (scorer.team === team), never an
    // own goal.
    async function playGoalAnimation(player) {
        const auth = getAuth(player);
        const equipped = await db.getEquipped(auth);

        const avatarItem = equipped.avatar && itemsById.get(equipped.avatar);
        if (avatarItem) {
            room.setPlayerAvatar(player.id, avatarItem.avatar);
            setTimeout(() => {
                // The scorer may have left in the meantime — only revert if
                // they're still actually in the room.
                if (state.playersAll.some((p) => p.id === player.id)) {
                    room.setPlayerAvatar(player.id, null);
                }
            }, GOAL_CELEBRATION_DURATION_MS);
        }

        const animationItem = equipped.goalAnimation && itemsById.get(equipped.goalAnimation);
        // Re-checked live, not just at buy/equip time: a VIP grant can
        // lapse mid-session (see !setvip) without the player ever
        // unequipping — their still-equipped smoke/fireworks simply stops
        // firing the moment VIP (and no outright purchase) is gone.
        if (animationItem && (await hasGoalAnimationAccess(player, animationItem))) {
            if (animationItem.smokeColor) {
                await playSmokeAnimation({ room, Team, stadium: state.currentStadium, team: player.team, colorName: animationItem.smokeColor });
            } else if (animationItem.fireworks) {
                await playFireworksAnimation({ room, Team, stadium: state.currentStadium, team: player.team });
            } else if (animationItem.blackhole) {
                // Snapshotted here, not re-read mid-animation — same "who
                // was actually on the field the moment the goal was
                // scored" convention as smoke/fireworks' own `team`
                // parameter. player.id (the scorer) is excluded inside
                // playBlackholeAnimation itself, never pulled. Team/team
                // decide which goal mouth the hole opens at — same
                // mirroring rule as smoke/fireworks.
                await playBlackholeAnimation({
                    room,
                    state,
                    Team,
                    stadium: state.currentStadium,
                    team: player.team,
                    players: [...state.teamRed, ...state.teamBlue],
                    scorerId: player.id,
                });
            }
        }
    }

    // Same idea as playGoalAnimation, but for the scorer's disc radius —
    // deliberately never applied at any other time (no re-apply on join/team
    // change/match start), since 'size' is a real physics collision radius
    // and this is a coin-shop cosmetic, not a paid gameplay advantage.
    // Restores the EXACT radius the player had a moment ago (captured live
    // via getPlayerDiscProperties) rather than some assumed map default, so
    // it's correct regardless of stadium or any other effect already in play.
    async function playGoalSizeEffect(player) {
        const auth = getAuth(player);
        const equipped = await db.getEquipped(auth);
        if (!equipped.size) return;
        const item = itemsById.get(equipped.size);
        if (!item) return;
        const original = room.getPlayerDiscProperties(player.id);
        if (!original) return;
        // Upgradeable items (small/big) have no flat `.radius` — it depends
        // on the level actually bought, so this needs its own DB read here
        // rather than reusing whatever `equipped` already returned.
        const radius = item.upgradeable
            ? radiusForLevel(item, await db.getItemLevel(auth, item.id))
            : item.radius;
        room.setPlayerDiscProperties(player.id, { radius });
        setTimeout(() => {
            if (state.playersAll.some((p) => p.id === player.id)) {
                room.setPlayerDiscProperties(player.id, { radius: original.radius });
            }
        }, GOAL_CELEBRATION_DURATION_MS);
    }

    /* COMMANDS */

    // `level` is only meaningful (and only ever passed) for upgradeable
    // items — everything else still just shows its flat price. `retired`
    // items (see shopItems.js) never show a price at all — showing their old
    // price would read as "still buyable at this price", which is exactly
    // wrong (see shopCommand's unconditional retired rejection). This only
    // ever actually renders for an existing owner, in !inventory — retired
    // items are excluded from formatCatalogSection's !shop listing entirely.
    // `viaVip` — this item isn't actually owned, it's just surfaced for a
    // current VIP (see inventoryCommand/GOAL_ANIMATION_ITEM_IDS) — tagged
    // distinctly so it doesn't read as a real purchase.
    // balance — optional (requested 2026-08-15: "не видно, что по карману, а
    // что нет"). When given, an item this player can't currently afford gets
    // a trailing "❌ не хватает" marker — omitted entirely for already-owned
    // items (affordability is meaningless there) and whenever the caller
    // doesn't have a balance handy (inventoryCommand's own call below, where
    // every item shown is already owned anyway).
    function affordabilityMarker(price, balance) {
        return balance != null && balance < price ? ' ❌ не хватает' : '';
    }

    // item.isNew — requested 2026-08-15 ("новые/снятые с продажи товары
    // визуально не выделены"): no item sets this today (nothing's been
    // added since this was built), but the mechanism is here so a future
    // addition to shopItems.js can just set `isNew: true` and have it show
    // up distinctly without any further code changes.
    function formatItemLine(item, owned, equippedId, level, viaVip, balance) {
        const tag = !owned ? '' : item.id === equippedId ? ' [надето]' : viaVip ? ' [VIP]' : ' [куплено]';
        const newTag = item.isNew ? '🆕 ' : '';
        if (item.retired) {
            return `${newTag}${item.id} — ${item.name} (снят с продажи)${tag}`;
        }
        if (item.upgradeable) {
            const currentLevel = level ?? 0;
            const progress = `уровень ${currentLevel}/${item.maxLevel}`;
            const nextStep = currentLevel >= item.maxLevel
                ? 'максимум'
                : `след.: ${formatCoins(priceForLevel(item, currentLevel + 1))}${affordabilityMarker(priceForLevel(item, currentLevel + 1), balance)}`;
            return `${newTag}${item.id} — ${item.name} (${progress}, ${nextStep})${tag}`;
        }
        if (owned || item.price === 0) {
            return `${newTag}${item.id} — ${item.name} (${item.price === 0 ? 'бесплатно' : formatCoins(item.price)})${tag}`;
        }
        return `${newTag}${item.id} — ${item.name} (${formatCoins(item.price)}${affordabilityMarker(item.price, balance)})${tag}`;
    }

    // The smoke bundle (see shopItems.js's `smokeFamily`) is never itself
    // recorded as owned (see shopCommand's smokeFamily branch below) — its
    // "owned" status for display purposes is really "owns the family",
    // checked via any one representative color instead.
    function isOwned(item, owned) {
        return item.smokeFamily ? SMOKE_COLOR_ITEM_IDS.some((id) => owned.includes(id)) : owned.includes(item.id);
    }

    function formatCatalogSection(sectionKey, owned, equipped, levels, balance) {
        // `hidden` items (the smoke family's individual colors — see
        // shopItems.js) aren't independent catalog entries anymore, just
        // !equip targets once the smoke bundle above is owned. `retired`
        // items (past seasons' now-unbuyable forms) are the same story —
        // still fully equippable by whoever already owns one, just no
        // longer worth advertising in a list of things you CAN buy.
        const lines = items.filter((i) => i.type === sectionKey && !i.hidden && !i.retired).map((i) => formatItemLine(i, isOwned(i, owned), equipped[i.type], levels[i.id], undefined, balance));
        return `${CATEGORY_LABELS[sectionKey]}:\n${lines.join('\n')}`;
    }

    // Requested 2026-08-15 ("!shop вываливает всё одним полотном текста") —
    // exact match against the 4 real category keys, case-insensitive so
    // "!shop Form"/"!shop FORM" work the same as "!shop form". None of the
    // real item ids collide with these words (checked shopItems.js), so
    // this can be tried BEFORE the item-id lookup below with no ambiguity.
    const SHOP_CATEGORY_KEYS = ['form', 'size', 'avatar', 'goalAnimation'];
    function matchShopCategory(arg) {
        if (!arg) return null;
        return SHOP_CATEGORY_KEYS.find((key) => key.toLowerCase() === arg.toLowerCase()) ?? null;
    }

    // Every upgradeable item's current level for this auth, keyed by id —
    // 0 for one never bought at all, same as db.getItemLevel itself returns.
    async function getUpgradeableLevels(auth, candidateItems) {
        const upgradeableItems = candidateItems.filter((i) => i.upgradeable);
        const entries = await Promise.all(upgradeableItems.map(async (i) => [i.id, await db.getItemLevel(auth, i.id)]));
        return Object.fromEntries(entries);
    }

    async function shopCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = getAuth(player);

        // No argument at all: just the category list (requested 2026-08-15
        // — the wall-of-text fix from earlier today added !shop <category>
        // as an OPTIONAL filter on top of the full dump, but the actual ask
        // was for the bare command to be the compact view by default, with
        // the full per-category listing only one category name away).
        if (msgArray.length === 0) {
            const balance = await db.getBalance(auth);
            const categoryList = SHOP_CATEGORY_KEYS.map((key) => `${key} (${CATEGORY_LABELS[key]})`).join(', ');
            room.sendAnnouncement(
                `🛒 Магазин (баланс: ${formatCoins(balance)})\nКатегории: ${categoryList}\nСмотреть категорию: !shop <категория>. Купить/улучшить: !shop <id>. Надеть: !equip <id>.`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        const category = matchShopCategory(msgArray[0]);
        if (category) {
            const [balance, owned, equipped] = await Promise.all([db.getBalance(auth), db.getOwnedItemIds(auth), db.getEquipped(auth)]);
            const levels = await getUpgradeableLevels(auth, items);
            room.sendAnnouncement(
                `🛒 Магазин — ${CATEGORY_LABELS[category]} (баланс: ${formatCoins(balance)})\n${formatCatalogSection(category, owned, equipped, levels, balance)}\nКупить/улучшить: !shop <id>. Надеть: !equip <id>.`,
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

        // Retired items (see shopItems.js's `retired`) stay in the catalog
        // array forever — existing owners keep them, fully equippable,
        // exactly like any other item — but can never be bought again by
        // anyone, owner or not. Checked before every other purchase branch
        // below, unconditionally.
        if (item.retired) {
            room.sendAnnouncement(`"${item.name}" — предмет прошлого сезона, он больше не продаётся.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }

        // The smoke bundle is the way IN to goalAnimation access for a
        // non-VIP (see shopItems.js's `smokeFamily`) — handled entirely on
        // its own, before the access gate below, since buying it must work
        // even with zero prior access.
        if (item.smokeFamily) {
            if (await ownsSmokeFamily(auth)) {
                room.sendAnnouncement(`У вас уже есть "${item.name}".`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                return;
            }
            const spent = await db.spendCoins(auth, player.name, item.price);
            if (!spent) {
                const balance = await db.getBalance(auth);
                room.sendAnnouncement(`Недостаточно монет. Нужно ${formatCoins(item.price)}, у вас ${formatCoins(balance)}.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                return;
            }
            await Promise.all(SMOKE_COLOR_ITEM_IDS.map((id) => db.buyItem(auth, player.name, id, 0)));
            room.sendAnnouncement(
                `✔️ Куплено: ${item.name} за ${formatCoins(item.price)} ! Открыты все цвета дыма и анимации после гола — выберите цвет командой "!equip smoke-<цвет>".`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        // avatar and goalAnimation items have no purchase-time access gate
        // at all — anyone can buy any of them outright, VIP or not (a VIP
        // buying smoke/fireworks anyway just means they keep it after their
        // VIP eventually lapses). The VIP-free path is a separate, parallel
        // way to USE a goalAnimation item without ever owning it — see
        // hasGoalAnimationAccess.

        // vipOnly forms have no coin-bought bypass at all, unlike
        // goalAnimation — this is a hard role check, not an ownsItem escape
        // hatch. Still only gates a NEW purchase, same reasoning as above.
        if (item.vipOnly && !(await db.ownsItem(auth, item.id)) && getRole(player) < Role.VIP) {
            room.sendAnnouncement(`"${item.name}" — эксклюзивная форма для VIP.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }

        if (item.upgradeable) {
            const currentLevel = await db.getItemLevel(auth, item.id);
            if (currentLevel >= item.maxLevel) {
                room.sendAnnouncement(`"${item.name}" уже максимального уровня (${item.maxLevel}) !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                return;
            }
            const nextLevel = currentLevel + 1;
            const cost = priceForLevel(item, nextLevel);
            const upgraded = await db.upgradeItem(auth, player.name, item.id, cost, currentLevel);
            if (!upgraded) {
                const balance = await db.getBalance(auth);
                room.sendAnnouncement(`Недостаточно монет. Нужно ${formatCoins(cost)}, у вас ${formatCoins(balance)}.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                return;
            }
            room.sendAnnouncement(
                `✔️ "${item.name}" улучшен до уровня ${nextLevel}/${item.maxLevel} (радиус ${radiusForLevel(item, nextLevel)}) за ${formatCoins(cost)} !`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
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

        if (item.smokeColor) {
            // Buying any one smoke color unlocks the whole family at once —
            // the player still picks which one to actually wear via !equip.
            // Siblings are granted at cost 0 (already paid for via `item`
            // itself); each buyItem call is independently a harmless no-op
            // if that sibling was somehow already owned.
            const siblings = items.filter((i) => i.smokeColor && i.id !== item.id);
            await Promise.all(siblings.map((sibling) => db.buyItem(auth, player.name, sibling.id, 0)));
            room.sendAnnouncement(
                `✔️ Куплено: ${item.name} за ${formatCoins(item.price)} ! Открыты все цвета дыма — выберите нужный командой "!equip <id>".`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        const priceText = item.price === 0 ? 'бесплатно' : `за ${formatCoins(item.price)}`;
        room.sendAnnouncement(`✔️ Куплено: ${item.name} ${priceText} !`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    async function balanceCommand(player, message) {
        const balance = await db.getBalance(getAuth(player));
        room.sendAnnouncement(`💰 Ваш баланс: ${formatCoins(balance)}`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    async function inventoryCommand(player, message) {
        const auth = getAuth(player);
        const owned = await db.getOwnedItemIds(auth);
        // VIP perk: every goalAnimation item (smoke colors + fireworks)
        // shows up here for as long as VIP lasts, even though nothing was
        // actually bought — same effective access hasGoalAnimationAccess
        // grants at equip/play time, just surfaced here too so !inventory
        // doesn't lie about what a VIP can currently use (see
        // GOAL_ANIMATION_ITEM_IDS).
        const vipGranted = getRole(player) >= Role.VIP
            ? GOAL_ANIMATION_ITEM_IDS.filter((id) => !owned.includes(id))
            : [];
        const allIds = [...owned, ...vipGranted];
        if (allIds.length === 0) {
            room.sendAnnouncement(`У вас пока нет купленных аксессуаров. Загляните в "!shop".`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const equipped = await db.getEquipped(auth);
        const allItems = allIds.map((id) => itemsById.get(id)).filter(Boolean);
        const levels = await getUpgradeableLevels(auth, allItems);
        const lines = allItems.map((item) => formatItemLine(item, true, equipped[item.type], levels[item.id], vipGranted.includes(item.id)));
        room.sendAnnouncement(`🎒 Ваши аксессуары:\n${lines.join('\n')}`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    // Toggle: running this again on whatever's currently equipped for that
    // slot unequips it instead (absorbs the old standalone !unequip command
    // — same db.setEquipped(auth, item.type, null) path, just reached from
    // here now). Checked by item id, not just slot, so equipping a
    // DIFFERENT item in the same slot always replaces rather than toggling.
    async function equipCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const itemId = msgArray[0];
        if (!itemId) {
            room.sendAnnouncement(`Использование: !equip <id>. Список ваших аксессуаров — "!inventory". Повторный ввод для уже надетого аксессуара снимает его.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const item = itemsById.get(itemId);
        if (!item) {
            room.sendAnnouncement(`Нет такого аксессуара.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const auth = getAuth(player);
        const equipped = await db.getEquipped(auth);
        // Checked BEFORE the ownership gate below: a VIP's goalAnimation
        // item can be equipped for free without ever being recorded as
        // owned in the db (see hasGoalAnimationAccess) — the toggle-off has
        // to work for that case too, not just a normally bought item.
        if (equipped[item.type] === item.id) {
            await db.setEquipped(auth, item.type, null);
            // Same reasoning as the equip path below: a form is a whole-side
            // decision, so unequipping one needs both sides recomputed
            // (falls back to a teammate's form, or the default kit) — not
            // just this player's own state.
            if (item.type === 'form') await applyTeamForms();
            room.sendAnnouncement(`✔️ Снято: ${item.name} !`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
            return;
        }
        // goalAnimation items are equippable without ownership for a
        // current VIP (free perk — see hasGoalAnimationAccess); everything
        // else (avatar flashes included) needs a real purchase, no
        // exceptions.
        const owned = item.type === 'goalAnimation'
            ? await hasGoalAnimationAccess(player, item)
            : await db.ownsItem(auth, item.id);
        if (!owned) {
            room.sendAnnouncement(`Вы еще не купили "${item.name}". Загляните в "!shop".`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        if (item.vipOnly && getRole(player) < Role.VIP) {
            room.sendAnnouncement(`"${item.name}" — эксклюзивная форма для VIP.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
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

    // Player-facing (unlike !addcoins, which mints out of nowhere and stays
    // a MASTER-only testing tool) — any admin can give another player
    // coins, but out of their OWN balance: db.spendCoins on the admin
    // first, db.addCoins on the target only once that actually succeeds.
    // Amount must be positive — allowing negative would let spendCoins's
    // "balance < amount" check flip into effectively PAYING the admin from
    // the target instead of gifting them, since a negative amount is
    // always "less" than any real balance.
    async function giftCoinsCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const target = msgArray[0];
        const amount = parseInt(msgArray[1]);
        if (!target || !Number.isInteger(amount) || amount <= 0) {
            room.sendAnnouncement(`Использование: !gift <#id|auth> <количество>. Количество монет — положительное число, спишется с вашего баланса.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
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

        const adminAuth = getAuth(player);
        if (auth === adminAuth) {
            room.sendAnnouncement(`Нельзя подарить монеты самому себе.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }

        const charged = await db.spendCoins(adminAuth, player.name, amount);
        if (!charged) {
            const balance = await db.getBalance(adminAuth);
            room.sendAnnouncement(`Недостаточно монет. У вас ${formatCoins(balance)}, нужно ${formatCoins(amount)}.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        await db.addCoins(auth, targetName, amount);
        const newAdminBalance = await db.getBalance(adminAuth);
        room.sendAnnouncement(
            `🎁 ${player.name} подарил ${targetName} ${formatCoins(amount)} !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        room.sendAnnouncement(`Ваш баланс: ${formatCoins(newAdminBalance)}`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    return {
        awardMatchCoins,
        tickPlaytime,
        claimDailyBonus,
        applyTeamForms,
        announceTeamForms,
        playGoalAnimation,
        playGoalSizeEffect,
        shopCommand,
        inventoryCommand,
        equipCommand,
        addCoinsCommand,
        giftCoinsCommand,
        balanceCommand,
    };
};
