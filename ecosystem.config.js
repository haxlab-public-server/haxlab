// pm2 process definitions for all three processes — two rooms (own
// Puppeteer/Chromium each, see src/bffIndex.js's own top-of-file comment)
// plus the shared Discord bot, genuinely independent of both since
// 2026-08-15 (see discordProcess.js's own header comment for why: it used
// to be fork()'d from the main room specifically, so restarting that room
// also killed and respawned Discord, dropping BFF's own bridge connection
// along with it even though BFF was never touched). Started/reloaded
// together by deploy.yml via `pm2 startOrReload ecosystem.config.js`.
// Matching by `name` against the main room's existing ad-hoc-started
// "haxlab" process (originally `pm2 start HaxBot_public.js --name haxlab`,
// no ecosystem file) so this adopts it in place rather than creating a
// duplicate.
module.exports = {
    apps: [
        {
            name: 'haxlab',
            script: 'HaxBot_public.js',
        },
        {
            name: 'haxlab-bff',
            script: 'HaxBotBFF_public.js',
        },
        {
            name: 'haxlab-discord',
            script: 'HaxDiscordBot_public.js',
        },
    ],
};
