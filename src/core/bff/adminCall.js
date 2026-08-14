/*
 * BFF's own !report — forked out of commands/player.js's reportCommand
 * (identical cooldown/restriction logic), which lives in a factory that
 * otherwise pulls in economy/club-tied deps (formatCoins, printClubRankings,
 * the DISCORD_LINK_BONUS_COINS reward) BFF doesn't have any use for.
 *
 * discordBot.sendAdminCall is routed by discordProcess.js's BFF bridge to
 * the SAME shared admin-call channel the main room's own !report already
 * pings (confirmed 2026-08-14 — not a separate BFF channel), tagged
 * [BFF] there so the one shared channel can tell the two rooms apart.
 */
module.exports = function createBffAdminCall({
    room,
    authArray,
    db,
    errorColor,
    HaxNotification,
    discordBot,
    formatBanRemaining,
    reportCooldownMs = 60 * 1000,
}) {
    const reportCooldownSet = new Set();

    async function reportCommand(player) {
        const restriction = await db.getCommandRestriction(authArray[player.id][0], 'report');
        if (restriction) {
            room.sendAnnouncement(
                `Вам запрещено использовать !report (осталось: ${formatBanRemaining(restriction.expiresAt)})${restriction.reason ? ' : ' + restriction.reason : ''}.`,
                player.id, errorColor, 'bold', HaxNotification.CHAT
            );
            return;
        }
        if (reportCooldownSet.has(player.id)) {
            room.sendAnnouncement(`Команду !report можно использовать раз в минуту. Подождите немного.`, player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        reportCooldownSet.add(player.id);
        setTimeout(() => reportCooldownSet.delete(player.id), reportCooldownMs);
        room.sendAnnouncement(`🚨 ${player.name} позвал(а) администрацию !`, null, errorColor, 'bold', HaxNotification.MENTION);
        discordBot.sendAdminCall(player.name);
    }

    return { reportCommand };
};
