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

const discordToken = process.env.DISCORD_TOKEN ?? '';
const discordLogChannelId = process.env.DISCORD_LOG_CHANNEL_ID ?? ''; // formerly roomWebhook
const discordReportChannelId = process.env.DISCORD_REPORT_CHANNEL_ID ?? ''; // formerly gameWebhook
const discordOwnerId = process.env.DISCORD_OWNER_ID ?? '';
const discordAutoRoleId = process.env.DISCORD_AUTO_ROLE_ID ?? ''; // role auto-assigned to every new Discord member
const discordStatusChannelId = process.env.DISCORD_STATUS_CHANNEL_ID ?? ''; // live "join the room" message with player count
const discordPasswordChannelId = process.env.DISCORD_PASSWORD_CHANNEL_ID ?? ''; // gets the auto-rotated overflow room password

module.exports = {
    ...roomConstants,
    roomPassword,
    token,
    discordToken,
    discordLogChannelId,
    discordReportChannelId,
    discordOwnerId,
    discordAutoRoleId,
    discordStatusChannelId,
    discordPasswordChannelId,
};
