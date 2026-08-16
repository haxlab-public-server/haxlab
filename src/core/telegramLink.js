/*
 * !telegram [code] — links a player's room auth to a Telegram chat id, so
 * they can use /pass there instead of watching Discord (see
 * core/telegram.js). Reused as-is by both rooms (same "standalone
 * factory, both entry points instantiate their own" pattern as
 * core/overflowPassword.js) — VIP status and the overflow password are
 * already shared across rooms, so account linking belongs at that same
 * identity-level tier, not duplicated per room.
 *
 * A link can be INITIATED from either side:
 *  - the room, via a bare "!telegram" (no code) — generates a fresh code
 *    tied to the caller's auth, to be redeemed FROM Telegram via /link.
 *  - Telegram, via /start (core/telegram.js) — generates a code tied to
 *    the chat id, to be redeemed FROM the room via "!telegram <code>".
 * Either way redemption is one db.redeemTelegramLinkCode call filling in
 * whichever half was still missing; the direction is enforced by checking
 * WHICH half the code already carries, so a code from the wrong side
 * can't be replayed here.
 */
const LINK_CODE_EXPIRY_MS = 10 * 60 * 1000;

module.exports = function createTelegramLink({
    room,
    db,
    authArray,
    HaxNotification,
    errorColor,
    successColor,
    generateRoomPassword,
}) {
    async function linkTelegramCommand(player, message) {
        const code = message.split(/ +/)[1];
        const auth = authArray[player.id][0];

        if (!code) {
            const newCode = generateRoomPassword();
            await db.createTelegramLinkCode(newCode, { auth }, new Date(Date.now() + LINK_CODE_EXPIRY_MS).toISOString());
            room.sendAnnouncement(
                `Отправьте боту в Telegram: /link ${newCode}\nКод действует 10 минут.`,
                player.id, successColor, 'bold', HaxNotification.CHAT
            );
            return;
        }

        const row = await db.redeemTelegramLinkCode(code);
        // A code issued FROM the room (like the one above) has `auth` set
        // and `telegramChatId` null — only the OTHER direction (issued via
        // Telegram's /start) is redeemable here.
        if (!row || row.telegramChatId == null) {
            room.sendAnnouncement('Код неверный или истёк.', player.id, errorColor, 'bold', HaxNotification.CHAT);
            return;
        }
        await db.linkTelegramId(auth, row.telegramChatId);
        room.sendAnnouncement(
            'Ваш аккаунт Telegram связан! Теперь используйте /pass в боте, чтобы получить текущий пароль (только для VIP).',
            player.id, successColor, 'bold', HaxNotification.CHAT
        );
    }

    return { linkTelegramCommand };
};
