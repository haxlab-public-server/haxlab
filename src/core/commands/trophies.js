/*
 * !trophy: chat-prefix trophies for currently holding rank #1-3 in a stat.
 * Unlike shop cosmetics (core/economy.js), these aren't owned once and kept
 * forever — eligibility is a live snapshot (state.topPlayers, refreshed once
 * per completed match by stats/roomStats.js's updateStats(), not per
 * message) of who currently ranks top-3 in each category. Equipping one
 * just records a category preference, never a rank — the medal (🥇/🥈/🥉)
 * shown is always the player's ACTUAL current rank in that category (see
 * utils.js's formatTrophyLabel), so a promotion/demotion between 1st-3rd
 * updates the chat prefix on its own. events/activity.js's chat prefix only
 * actually shows it while state.topPlayers still agrees the player holds a
 * top-3 spot, so a trophy silently stops appearing (rather than lying) the
 * moment someone falls out of the top 3, and silently reappears if they
 * climb back in without needing to !trophy again.
 *
 * Seasons (see db.closeSeason): once a season closes, that season's top-3
 * gets frozen forever into state.seasonTrophies (never recomputed, unlike
 * state.topPlayers) and every player's live stats reset to 0. A player who
 * held rank 1-3 doesn't lose that title — they can re-point !trophy at the
 * now-closed season's frozen result ("!trophy goals 0") instead of the live
 * current one, and it displays exactly the same way (see
 * utils.js's resolveTrophyRank), just tagged with that season's number
 * instead of the current one.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createTrophyCommands({
    room,
    state,
    authArray,
    db,
    Trophies,
    formatTrophyLabel,
    encodeLegacyTrophyKey,
    resolveTrophyRank,
    announcementColor,
    errorColor,
    HaxNotification,
}) {
    function getAuth(player) {
        return authArray[player.id][0];
    }

    // `auth`'s current LIVE rank (1-3) in `category` this season, or null if
    // they're not in the top-3 snapshot at all. Only ever used for the
    // CURRENT season — a closed season's rank is looked up in
    // state.seasonTrophies instead (it never changes, so there's nothing to
    // "look up live").
    function getLiveRank(category, auth) {
        const entries = state.topPlayers[category] ?? [];
        const index = entries.findIndex((e) => e.auth === auth);
        return index === -1 ? null : index + 1;
    }

    // Every trophy `auth` can currently equip: live current-season top-3
    // spots, plus every already-closed season's frozen top-3 they hold (see
    // state.seasonTrophies — populated once at startup from
    // db.getSeasonTrophies(), same in-memory-cache reasoning as
    // state.topPlayers itself, since closed seasons never change again).
    function ownedTrophies(auth) {
        const live = Object.keys(Trophies)
            .map((category) => ({ category, season: state.currentSeason, rank: getLiveRank(category, auth) }))
            .filter((t) => t.rank != null);
        const legacy = state.seasonTrophies
            .filter((t) => t.auth === auth)
            .map((t) => ({ category: t.category, season: t.season, rank: t.rank }));
        return [...live, ...legacy].map((t) => ({ ...t, label: formatTrophyLabel(Trophies, t.category, t.rank, t.season) }));
    }

    async function trophiesCommand(player, message) {
        const args = message.split(/ +/).slice(1);
        const arg = args[0]?.toLowerCase();
        const auth = getAuth(player);
        const trophyKeys = Object.keys(Trophies);

        if (!arg) {
            const owned = ownedTrophies(auth);
            const equippedKey = state.equippedTrophies[auth];
            const resolved = equippedKey ? resolveTrophyRank(equippedKey, auth, state.currentSeason, state.topPlayers, state.seasonTrophies) : null;
            const ownedText = owned.length > 0 ? owned.map((t) => t.label).join(', ') : 'нет';
            const equippedText = resolved ? formatTrophyLabel(Trophies, resolved.category, resolved.rank, resolved.season) : 'не выбран';
            room.sendAnnouncement(
                `🏆 Ваши трофеи: ${ownedText}. Экипирован: ${equippedText}.\n` +
                    `Введите "!trophy <${trophyKeys.join('|')}>" чтобы экипировать трофей текущего сезона, ` +
                    `"!trophy <${trophyKeys.join('|')}> <сезон>" — трофей прошлого сезона, или "!trophy none" чтобы снять.`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        if (arg === 'none') {
            await db.setEquipped(auth, 'trophy', null);
            delete state.equippedTrophies[auth];
            room.sendAnnouncement(`✔️ Трофей снят !`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
            return;
        }

        if (!Trophies[arg]) {
            room.sendAnnouncement(
                `Использование: !trophy <${trophyKeys.join('|')}> [сезон]. Введите "!trophy" без аргумента, чтобы посмотреть свои трофеи.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        if (args[1] != null && Number.isNaN(Number(args[1]))) {
            room.sendAnnouncement(`Сезон должен быть числом, например "!trophy ${arg} 0".`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const seasonArg = args[1] != null ? Number(args[1]) : null;
        // An explicitly-typed CURRENT season is just the live pick spelled
        // out — state.seasonTrophies has no row for a season that hasn't
        // closed yet, so treating it as "legacy" would always reject it.
        const wantsLegacy = seasonArg != null && seasonArg !== state.currentSeason;

        if (wantsLegacy) {
            const row = state.seasonTrophies.find((t) => t.season === seasonArg && t.category === arg && t.auth === auth);
            if (!row) {
                room.sendAnnouncement(`У вас нет этого трофея за сезон ${seasonArg} !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
                return;
            }
            const key = encodeLegacyTrophyKey(seasonArg, arg);
            await db.setEquipped(auth, 'trophy', key);
            state.equippedTrophies[auth] = key;
            room.sendAnnouncement(
                `✔️ Экипирован трофей "${formatTrophyLabel(Trophies, arg, row.rank, seasonArg)}" !`,
                player.id,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        const rank = getLiveRank(arg, auth);
        if (rank == null) {
            room.sendAnnouncement(`Вы сейчас не в топ-3 по этому показателю !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }

        await db.setEquipped(auth, 'trophy', arg);
        state.equippedTrophies[auth] = arg;
        room.sendAnnouncement(
            `✔️ Экипирован трофей "${formatTrophyLabel(Trophies, arg, rank, state.currentSeason)}" !`,
            player.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    return {
        trophiesCommand,
    };
};
