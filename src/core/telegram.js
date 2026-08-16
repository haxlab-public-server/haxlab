/*
 * Telegram bot for on-demand overflow-password delivery (requested
 * 2026-08-17) — VIPs who don't use Discord can pull the CURRENT shared
 * password (see core/overflowPassword.js — one value for both rooms now)
 * via /pass, instead of watching a Discord channel. Long polling (no
 * inbound port needed, matches this bundle's existing "outbound-only"
 * shape — see discord.js).
 *
 * Same "leave empty to disable" convention as discordToken/discordProxyUrl
 * in config.js — safe to merge/deploy before a real TELEGRAM_BOT_TOKEN
 * exists; init() is then a total no-op.
 *
 * `db` here is discordProcess.js's own direct connection to the main
 * room's physical file — already the canonical/shared store for both the
 * overflow password (core/overflowPassword.js writes there too, whether
 * directly as the main room or via the shared-setting routing as BFF) and
 * telegram_links/telegram_link_codes (see db/sqlite.js).
 */
const PASSWORD_SETTING_KEY = 'overflowPasswordValue';
const PASSWORD_SET_AT_SETTING_KEY = 'overflowPasswordSetAt';
const LINK_CODE_EXPIRY_MS = 10 * 60 * 1000;
// Must match core/overflowPassword.js's own rotateIntervalMs (1h, hardcoded
// at both call sites in entry.js/bffEntry.js) — a password past this is
// exactly as stale here as it is to either room, so /pass never contradicts
// what the rooms themselves are currently enforcing.
const ROTATE_INTERVAL_MS = 60 * 60 * 1000;

// TelegramBotClass is dependency-injected (defaults to the real library,
// lazily required only when actually needed — same "don't load the heavy
// client at all with an empty token" reasoning as before) specifically so
// tests can substitute a fake client instead of constructing the real one,
// which would immediately start making real HTTP polling requests to
// Telegram's API the moment it's instantiated with `polling: true`.
module.exports = function createTelegramBot({ db, telegramBotToken, generateRoomPassword, TelegramBotClass }) {
    let bot = null;

    async function handleStart(msg) {
        const chatId = msg.chat.id;
        const code = generateRoomPassword();
        await db.createTelegramLinkCode(code, { telegramChatId: String(chatId) }, new Date(Date.now() + LINK_CODE_EXPIRY_MS).toISOString());
        bot.sendMessage(chatId, `Зайдите в комнату HaxBall (футзал или BFF) и напишите: !telegram ${code}\nКод действует 10 минут.`);
    }

    async function handleLink(msg, match) {
        const chatId = msg.chat.id;
        const code = match[1].trim();
        const row = await db.redeemTelegramLinkCode(code);
        if (!row || row.auth == null) {
            bot.sendMessage(chatId, 'Код неверный или истёк.');
            return;
        }
        await db.linkTelegramId(row.auth, String(chatId));
        bot.sendMessage(chatId, 'Аккаунт связан! Теперь используйте /pass, чтобы получить текущий пароль (только для VIP).');
    }

    async function handlePass(msg) {
        const chatId = msg.chat.id;
        const auth = await db.getAuthByTelegramId(String(chatId));
        if (!auth) {
            bot.sendMessage(chatId, 'Аккаунт не привязан. Зайдите в комнату и напишите: !telegram');
            return;
        }
        const vips = await db.getVips();
        if (!vips.some((v) => v.auth === auth)) {
            bot.sendMessage(chatId, 'Эта команда доступна только VIP.');
            return;
        }
        const value = await db.getSetting(PASSWORD_SETTING_KEY);
        const setAt = Number(await db.getSetting(PASSWORD_SET_AT_SETTING_KEY)) || 0;
        const isFresh = value && Date.now() - setAt < ROTATE_INTERVAL_MS;
        bot.sendMessage(chatId, isFresh
            ? `Текущий пароль (футзал и BFF): ${value}`
            : 'Сейчас пароль не нужен — в обеих комнатах есть свободные обычные места.');
    }

    function init() {
        if (!telegramBotToken) return;
        const TelegramBot = TelegramBotClass ?? require('node-telegram-bot-api');
        bot = new TelegramBot(telegramBotToken, { polling: true });
        bot.onText(/^\/start\b/, (msg) => handleStart(msg).catch((err) => console.error('[telegram] /start failed:', err)));
        bot.onText(/^\/link\s+(\S+)/, (msg, match) => handleLink(msg, match).catch((err) => console.error('[telegram] /link failed:', err)));
        bot.onText(/^\/pass\b/, (msg) => handlePass(msg).catch((err) => console.error('[telegram] /pass failed:', err)));
        bot.on('polling_error', (err) => console.error('[telegram] polling error:', err));
    }

    return { init };
};
