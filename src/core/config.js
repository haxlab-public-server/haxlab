// Secrets and instance-specific IDs live in .env (gitignored), never here —
// see .env.example for the template. process.loadEnvFile() (HaxBot_public.js)
// populates process.env before this module is required.
//
// This file is orchestrator/Discord-process-only — it reads process.env,
// which doesn't exist in the browser page (see src/index.js, which forks
// discordProcess.js and reads the two secrets below to inject into the
// page). Anything that also needs to be visible inside the bundled in-page
// entry (src/browser/entry.js) lives in roomConstants.js instead, and is
// re-exported here so nothing else has to know about that split.
const roomConstants = require('./roomConstants');

const roomPassword = process.env.ROOM_PASSWORD ?? ''; // leave unset for no password
const token = process.env.HAXBALL_TOKEN ?? ''; // from https://www.haxball.com/headlesstoken — expires in ~1 hour

// Room-side too (injected into the page as window.__secrets, same as
// roomPassword above) — entry.js/events/activity.js watches every chat
// message for "@<mentionWatchName>" and, when it appears, relays the whole
// message to Discord via discordBot.sendMentionAlert. Leave empty to
// disable the whole feature.
const mentionWatchName = process.env.MENTION_WATCH_NAME ?? '';

// !gif (commands/player.js, core/gifClip.js) — same "room-side secret,
// injected into the page as window.__secrets" as mentionWatchName above.
// HaxClip is a separately-hosted service (a different box entirely, see
// gifClip.js's own doc comment) — leave any of these empty to disable the
// whole feature (gifClip.js's own `enabled` flag checks all five).
const haxclipWsUrl = process.env.HAXCLIP_WS_URL ?? '';
const haxclipApiKey = process.env.HAXCLIP_API_KEY ?? '';
const gifUploadWebhookUrl = process.env.DISCORD_GIF_UPLOAD_WEBHOOK ?? ''; // temp home for the raw .hbr2 so HaxClip has a URL to fetch it from
const gifResultWebhookId = process.env.DISCORD_GIF_RESULT_WEBHOOK_ID ?? ''; // HaxClip posts the finished GIF here directly
const gifResultWebhookToken = process.env.DISCORD_GIF_RESULT_WEBHOOK_TOKEN ?? '';

// Set by HaxBot_test.js (npm run test), never by hand in .env — a "[TEST] "
// room name prefix (see roomConstants.js's buildGameConfig) and no
// ghost-kick/AFK-kick (see entry.js's debugMode), so you can join a test
// room from the same account you're already using in the live one without
// getting yourself kicked out of either.
const testMode = process.env.TEST_MODE === 'true';

const discordToken = process.env.DISCORD_TOKEN ?? '';
// Telegram bot for on-demand overflow-password delivery (requested
// 2026-08-17, see core/telegram.js) — obtained from @BotFather. Same
// "leave empty to disable" convention as discordToken above; telegram.js's
// own init() no-ops with no token.
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
const discordLogChannelId = process.env.DISCORD_LOG_CHANNEL_ID ?? ''; // formerly roomWebhook
const discordReportChannelId = process.env.DISCORD_REPORT_CHANNEL_ID ?? ''; // formerly gameWebhook
const discordOwnerId = process.env.DISCORD_OWNER_ID ?? '';
const discordAdminRoleId = process.env.DISCORD_ADMIN_ROLE_ID ?? ''; // members with this role can also use /say, alongside the owner
const discordAutoRoleId = process.env.DISCORD_AUTO_ROLE_ID ?? ''; // role auto-assigned to every new Discord member
const discordVipRoleId = process.env.DISCORD_VIP_ROLE_ID ?? ''; // granting this role on Discord grants room VIP to the linked auth
const discordStatusChannelId = process.env.DISCORD_STATUS_CHANNEL_ID ?? ''; // live "join the room" message with player count
const discordPasswordChannelId = process.env.DISCORD_PASSWORD_CHANNEL_ID ?? ''; // gets the auto-rotated overflow room password
const discordAdminCallChannelId = process.env.DISCORD_ADMIN_CALL_CHANNEL_ID ?? ''; // gets an @here ping when a player uses !report
const discordVotebanChannelId = process.env.DISCORD_VOTEBAN_CHANNEL_ID ?? ''; // gets a notification whenever a !voteban vote actually bans someone
const discordMentionAlertChannelId = process.env.DISCORD_MENTION_ALERT_CHANNEL_ID ?? ''; // gets pinged (via DISCORD_OWNER_ID) whenever MENTION_WATCH_NAME is mentioned in chat

// BFF room's own log/report channels (see haxchill-second-room-plan project
// memory: separate channels per room, except the combined status message).
// Read here (not a separate bff/config.js) because discordProcess.js is the
// ONE shared Discord bot process both rooms' orchestrators talk to — it
// needs both rooms' channel IDs available in the same place.
const discordBffLogChannelId = process.env.DISCORD_BFF_LOG_CHANNEL_ID ?? '';
const discordBffReportChannelId = process.env.DISCORD_BFF_REPORT_CHANNEL_ID ?? '';

// Local loopback port discordProcess.js listens on for the BFF orchestrator
// (a separate, unrelated OS process — see src/bffIndex.js) to reach the
// SAME running Discord bot/client, instead of spawning a second bot.
// `||`, not `??` — a .env line left as `DISCORD_BRIDGE_PORT=` (the
// .env.example-recommended way to "leave unset") sets process.env to an
// empty STRING, not undefined, so `??` never falls through to the default;
// Number('') is 0, which the bridge server then silently binds to a
// random OS-assigned port while every client still tries to connect to
// literal port 0 and fails. Found 2026-08-22 on a from-scratch deploy.
const discordBridgePort = Number(process.env.DISCORD_BRIDGE_PORT || 47100);

// Same idea, for the MAIN room's orchestrator (src/index.js) — confirmed
// 2026-08-15: discordProcess.js is now a genuinely independent pm2 process
// (own ecosystem.config.js entry), not forked from src/index.js anymore, so
// the main room needs the same kind of loopback TCP bridge BFF already had,
// not fork()'s built-in IPC channel.
// Same `||` reasoning as discordBridgePort above.
const discordMainBridgePort = Number(process.env.DISCORD_MAIN_BRIDGE_PORT || 47101);

// SOCKS5 proxy for the Discord process's own outbound traffic only (REST +
// gateway), e.g. `socks5://user:pass@host:port` — see discordProcess.js's
// proxy patch. Leave empty to connect directly. Never touches the room
// process / Puppeteer, which live entirely separately.
const discordProxyUrl = process.env.DISCORD_PROXY_URL ?? '';

module.exports = {
    ...roomConstants,
    roomPassword,
    token,
    testMode,
    mentionWatchName,
    haxclipWsUrl,
    haxclipApiKey,
    gifUploadWebhookUrl,
    gifResultWebhookId,
    gifResultWebhookToken,
    discordToken,
    telegramBotToken,
    discordLogChannelId,
    discordReportChannelId,
    discordOwnerId,
    discordAdminRoleId,
    discordAutoRoleId,
    discordVipRoleId,
    discordStatusChannelId,
    discordPasswordChannelId,
    discordAdminCallChannelId,
    discordVotebanChannelId,
    discordMentionAlertChannelId,
    discordProxyUrl,
    discordBffLogChannelId,
    discordBffReportChannelId,
    discordBridgePort,
    discordMainBridgePort,
};
