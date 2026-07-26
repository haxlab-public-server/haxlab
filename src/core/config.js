// Secrets and instance-specific IDs live in .env (gitignored), never here —
// see .env.example for the template. process.loadEnvFile() (HaxBot_public.js)
// populates process.env before this module is required.
const roomName = '🌴 HaxChill | 4v4 Winstay | dsc.gg/haxchill 🌴'; // room name
const maxPlayers = 14;
const roomPublic = true;
const roomPassword = process.env.ROOM_PASSWORD ?? ''; // leave unset for no password
const token = process.env.HAXBALL_TOKEN ?? ''; // from https://www.haxball.com/headlesstoken — expires in ~1 hour
const geo = { code: 'RU', lat: 55.7558, lon: 37.6173 }; // Moscow — shown as the room's flag/location

const discordToken = process.env.DISCORD_TOKEN ?? '';
const discordLogChannelId = process.env.DISCORD_LOG_CHANNEL_ID ?? ''; // formerly roomWebhook
const discordReportChannelId = process.env.DISCORD_REPORT_CHANNEL_ID ?? ''; // formerly gameWebhook
const discordOwnerId = process.env.DISCORD_OWNER_ID ?? '';
const discordAutoRoleId = process.env.DISCORD_AUTO_ROLE_ID ?? ''; // role auto-assigned to every new Discord member
const discordStatusChannelId = process.env.DISCORD_STATUS_CHANNEL_ID ?? ''; // live "join the room" message with player count
const discordPasswordChannelId = process.env.DISCORD_PASSWORD_CHANNEL_ID ?? ''; // gets the auto-rotated overflow room password
const fetchRecordingVariable = true;
const timeLimit = 5;
const scoreLimit = 5;

const HAXBALL_TOKEN_LENGTH = 39;

function buildGameConfig() {
    const gameConfig = {
        roomName,
        maxPlayers,
        public: roomPublic,
        noPlayer: true,
        geo,
    };

    if (typeof token === 'string' && token.length === HAXBALL_TOKEN_LENGTH) {
        gameConfig.token = token;
    }

    return gameConfig;
}

module.exports = {
    roomName,
    maxPlayers,
    roomPublic,
    roomPassword,
    token,
    geo,
    discordToken,
    discordLogChannelId,
    discordReportChannelId,
    discordOwnerId,
    discordAutoRoleId,
    discordStatusChannelId,
    discordPasswordChannelId,
    fetchRecordingVariable,
    timeLimit,
    scoreLimit,
    buildGameConfig,
};
