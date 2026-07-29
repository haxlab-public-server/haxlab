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
    announcementColor,
    errorColor,
    HaxNotification,
}) {
    function getAuth(player) {
        return authArray[player.id][0];
    }

    // `auth`'s current rank (1-3) in `category`, or null if they're not in
    // the top-3 snapshot at all.
    function getRank(category, auth) {
        const entries = state.topPlayers[category] ?? [];
        const index = entries.findIndex((e) => e.auth === auth);
        return index === -1 ? null : index + 1;
    }

    // { key, rank, label } for every category `auth` currently qualifies for.
    function ownedTrophies(auth) {
        return Object.keys(Trophies)
            .map((key) => ({ key, rank: getRank(key, auth) }))
            .filter((t) => t.rank != null)
            .map((t) => ({ ...t, label: formatTrophyLabel(Trophies, t.key, t.rank) }));
    }

    async function trophiesCommand(player, message) {
        const arg = message.split(/ +/)[1]?.toLowerCase();
        const auth = getAuth(player);
        const trophyKeys = Object.keys(Trophies);

        if (!arg) {
            const owned = ownedTrophies(auth);
            const equippedKey = state.equippedTrophies[auth];
            const equippedRank = equippedKey ? getRank(equippedKey, auth) : null;
            const ownedText = owned.length > 0 ? owned.map((t) => t.label).join(', ') : 'нет';
            const equippedText = equippedRank ? formatTrophyLabel(Trophies, equippedKey, equippedRank) : 'не выбран';
            room.sendAnnouncement(
                `🏆 Ваши трофеи: ${ownedText}. Экипирован: ${equippedText}.\n` +
                    `Введите "!trophy <${trophyKeys.join('|')}>" чтобы экипировать, или "!trophy none" чтобы снять.`,
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
                `Использование: !trophy <${trophyKeys.join('|')}>. Введите "!trophy" без аргумента, чтобы посмотреть свои трофеи.`,
                player.id,
                errorColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        const rank = getRank(arg, auth);
        if (rank == null) {
            room.sendAnnouncement(`Вы сейчас не в топ-3 по этому показателю !`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }

        await db.setEquipped(auth, 'trophy', arg);
        state.equippedTrophies[auth] = arg;
        room.sendAnnouncement(`✔️ Экипирован трофей "${formatTrophyLabel(Trophies, arg, rank)}" !`, player.id, announcementColor, 'bold', HaxNotification.CHAT);
    }

    return {
        trophiesCommand,
    };
};
