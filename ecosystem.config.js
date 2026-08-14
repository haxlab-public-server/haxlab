// pm2 process definitions for both rooms — two genuinely separate OS
// processes (own Puppeteer/Chromium each, see src/bffIndex.js's own
// top-of-file comment), started/reloaded together by deploy.yml via
// `pm2 startOrReload ecosystem.config.js`. Matching by `name` against the
// main room's existing ad-hoc-started "haxlab" process (originally
// `pm2 start HaxBot_public.js --name haxlab`, no ecosystem file) so this
// adopts it in place rather than creating a duplicate.
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
    ],
};
