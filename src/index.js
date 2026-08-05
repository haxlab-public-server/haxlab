/*
 * Orchestrator — launches a real headless Chromium (via Puppeteer) against
 * the actual HaxBall room page and injects the bundled room logic (see
 * src/browser/entry.js) into it. Replaces the old approach of hosting the
 * room directly in this process via haxball.js + @webrtc-node/webrtc: a
 * WebRTC-internals dump from an affected player showed stable RTT but
 * bursty packet delivery, decoupled from RTT — pointing at that native
 * binding's own send/receive buffering, not at this process, the network,
 * or anything fixable from here. A real browser uses the same battle-tested
 * WebRTC engine every actual player's browser already does.
 *
 * This process itself no longer touches `room`/`state` at all — those live
 * entirely inside the page now. It owns only what a browser page genuinely
 * can't: the real sqlite DB (bridged to the page via page.exposeFunction)
 * and the Discord child process (unchanged from before this migration,
 * except its two room-touching message types now reach the page via
 * page.evaluate() instead of touching `room`/`state` directly).
 */
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const puppeteer = require('puppeteer');
const esbuild = require('esbuild');

const { roomPassword, token, testMode, mentionWatchName } = require('./core/config');
const { createDatabaseApi } = require('../api/database');
const { BRIDGED_METHODS } = require('./browser/dbBridgeClient');

const db = createDatabaseApi();
db.init();

/* DISCORD CHILD PROCESS */
// Unchanged from before this migration — still its own process, still
// respawned with backoff, still deprioritized on this single-vCPU host so
// the room (now the browser's rendering/JS thread, not this process) gets
// CPU first. Only the 'relay'/'kickByAuth' handling below changed: this
// process has no direct `room`/`state` to touch anymore, so those two
// message types now reach into the page via page.evaluate() instead.
let discordProcess = null;
let discordRespawnTimer = null;
const DISCORD_RESPAWN_BASE_DELAY_MS = 5000;
const DISCORD_RESPAWN_MAX_DELAY_MS = 5 * 60 * 1000;
const DISCORD_STABLE_UPTIME_MS = 60 * 1000;
let discordRespawnDelay = DISCORD_RESPAWN_BASE_DELAY_MS;

// room.onRoomLink only fires once, right when the room is first created —
// a respawned Discord process would otherwise never learn it. Cached here
// (set whenever a 'roomLink' message passes through __discordSend below)
// so resyncDiscordProcess can replay it after a respawn.
let lastRoomLink = null;

// Set once the browser/page is ready (see launchRoom below) — every
// Discord->room bridge call guards on this being non-null, since the
// Discord process can finish spawning before the browser has.
let page = null;

function sendToDiscord(message) {
    if (discordProcess && discordProcess.connected) discordProcess.send(message);
}

// Replays the state a freshly (re)spawned Discord process would otherwise
// have missed. Reads the roster from the page (this process holds none of
// it directly) — a no-op if the page isn't ready yet, same as the
// pre-migration version was a no-op before state.playersAll existed.
async function resyncDiscordProcess() {
    if (!page) return;
    try {
        const players = await page.evaluate(() => window.__roomBridge.getRoster());
        sendToDiscord({ type: 'roster', players });
        if (lastRoomLink) sendToDiscord({ type: 'roomLink', url: lastRoomLink });
    } catch (err) {
        console.error('[WARN] resyncDiscordProcess failed:', err);
    }
}

function spawnDiscordProcess() {
    const child = fork(path.join(__dirname, 'core', 'discordProcess.js'), {
        serialization: 'advanced',
    });
    discordProcess = child;
    const spawnedAt = Date.now();

    // The host this runs on has a single vCPU — separating the event loops
    // doesn't separate the CPU itself, both processes still take turns on
    // the same core. Lowering the child's OS scheduling priority means the
    // kernel favors the room (the browser's rendering/JS thread — i.e.
    // player ping) over Discord traffic whenever both want the CPU at the
    // same instant. Best-effort: some platforms/permission setups don't
    // allow this, and that must never take the room down with it.
    if (child.pid) {
        try {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
        } catch (err) {
            console.error('[WARN] Could not lower Discord process OS priority:', err.message);
        }
    }

    child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'relay') {
            if (page) page.evaluate((m) => window.__roomBridge.relayToRoom(m.username, m.content), msg).catch((err) => console.error('[WARN] relay bridge failed:', err));
            return;
        }
        if (msg.type === 'kickByAuth') {
            if (!page) {
                sendToDiscord({ type: 'kickResult', requestId: msg.requestId, result: null });
                return;
            }
            page.evaluate((m) => window.__roomBridge.kickByAuth(m.auth, m.reason), msg)
                .then((result) => sendToDiscord({ type: 'kickResult', requestId: msg.requestId, result }))
                .catch((err) => {
                    console.error('[WARN] kickByAuth bridge failed:', err);
                    sendToDiscord({ type: 'kickResult', requestId: msg.requestId, result: null });
                });
            return;
        }
        if (msg.type === 'grantVip') {
            if (page) page.evaluate((m) => window.__roomBridge.grantVipByAuth(m.auth, m.targetName), msg).catch((err) => console.error('[WARN] grantVip bridge failed:', err));
            return;
        }
        if (msg.type === 'muteByAuth') {
            if (!page) {
                sendToDiscord({ type: 'muteResult', requestId: msg.requestId, result: { ok: false, reason: 'offline' } });
                return;
            }
            page.evaluate((m) => window.__roomBridge.muteByAuth(m.auth, m.minutes), msg)
                .then((result) => sendToDiscord({ type: 'muteResult', requestId: msg.requestId, result }))
                .catch((err) => {
                    console.error('[WARN] muteByAuth bridge failed:', err);
                    sendToDiscord({ type: 'muteResult', requestId: msg.requestId, result: { ok: false, reason: 'offline' } });
                });
            return;
        }
        if (msg.type === 'unmuteByAuth') {
            if (!page) {
                sendToDiscord({ type: 'unmuteResult', requestId: msg.requestId, result: { ok: false } });
                return;
            }
            page.evaluate((m) => window.__roomBridge.unmuteByAuth(m.auth), msg)
                .then((result) => sendToDiscord({ type: 'unmuteResult', requestId: msg.requestId, result }))
                .catch((err) => {
                    console.error('[WARN] unmuteByAuth bridge failed:', err);
                    sendToDiscord({ type: 'unmuteResult', requestId: msg.requestId, result: { ok: false } });
                });
            return;
        }
    });
    child.on('error', (err) => {
        console.error('[WARN] Discord process error:', err);
    });
    // Auto-respawned rather than left dead: a crash in discord.js (or the
    // process being OOM-killed, etc.) must not permanently lose logging/
    // moderation/stats until someone notices and restarts the whole VPS
    // process by hand.
    child.on('exit', (code, signal) => {
        discordRespawnDelay = Date.now() - spawnedAt >= DISCORD_STABLE_UPTIME_MS
            ? DISCORD_RESPAWN_BASE_DELAY_MS
            : Math.min(discordRespawnDelay * 2, DISCORD_RESPAWN_MAX_DELAY_MS);
        console.error(`[WARN] Discord process exited (code=${code}, signal=${signal}), respawning in ${discordRespawnDelay}ms`);
        if (discordProcess === child) discordProcess = null;
        discordRespawnTimer = setTimeout(() => {
            spawnDiscordProcess();
            resyncDiscordProcess();
        }, discordRespawnDelay);
    });

    return child;
}
spawnDiscordProcess();

process.on('exit', () => {
    clearTimeout(discordRespawnTimer);
    if (discordProcess) discordProcess.kill();
});

/* DB BRIDGE */
// One generic dispatcher rather than one page.exposeFunction per method —
// the in-page client (dbBridgeClient.js) builds its whole `db` object from
// the same BRIDGED_METHODS list, so the two stay in sync automatically.
// The allowlist keeps this from ever reaching e.g. db.close()/db.backup(),
// which have no business being reachable from the page at all.
const dbMethodAllowlist = new Set(BRIDGED_METHODS);
async function handleDbCall(method, args) {
    if (!dbMethodAllowlist.has(method) || typeof db[method] !== 'function') {
        throw new Error(`Bridged db call to disallowed method: ${method}`);
    }
    return db[method](...args);
}

/* DISCORD BRIDGE */
// Fire-and-forget, mirroring every discordBot.* call site in src/core/*
// (none of them ever awaited a result). 'recording' carries a base64
// string instead of the raw Uint8Array — page.exposeFunction JSON-
// serializes its arguments, so the in-page client encodes it first (see
// discordBridgeClient.js) and this decodes it back to a real Buffer.
function handleDiscordSend(type, payload) {
    if (type === 'roomLink') lastRoomLink = payload.url;
    if (type === 'recording') {
        sendToDiscord({ type: 'recording', buffer: Buffer.from(payload.bufferBase64, 'base64'), filename: payload.filename });
        return;
    }
    sendToDiscord({ type, ...payload });
}

/* BUNDLE */
// Built fresh at every startup (esbuild is fast — sub-second for a project
// this size) rather than as a separate deploy-time build step, so the
// injected bundle can never drift out of sync with source on disk and
// deploy stays "git push, pm2 restarts node HaxBot_public.js" same as ever.
async function buildEntryBundle() {
    const result = await esbuild.build({
        entryPoints: [path.join(__dirname, 'browser', 'entry.js')],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'iife',
        target: 'chrome120',
    });
    return result.outputFiles[0].text;
}

/* BROWSER LAUNCH */
async function launchRoom() {
    // Flags carried over from this project's own prior working Puppeteer
    // setup on the same VPS tier: --disable-features=WebRtcHideLocalIpsWithMdns
    // is load-bearing (Chrome hides host ICE candidates behind mDNS by
    // default, which breaks headless server-side connectivity), --no-sandbox/
    // --disable-setuid-sandbox are needed running as root without the
    // sandbox's usual setuid helper configured. AsyncDns is also disabled:
    // Chrome's own async DNS resolver returned a different (unreachable from
    // this VPS) address for www.haxball.com than the system resolver curl
    // uses, causing every navigation to hang until net::ERR_TIMED_OUT —
    // confirmed directly by forcing the system-resolved IP via
    // --host-resolver-rules and seeing navigation succeed; disabling AsyncDns
    // fixes it generally, without hardcoding an IP that could change.
    const browser = await puppeteer.launch({
        args: [
            '--remote-debugging-port=9222',
            '--disable-features=WebRtcHideLocalIpsWithMdns,AsyncDns',
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
    });

    browser.on('disconnected', () => {
        console.error('[FATAL] Browser disconnected/crashed.');
        sendToDiscord({
            type: 'log',
            content: '🔴 **КРИТИЧЕСКАЯ ОШИБКА: браузер комнаты упал.** Нужен новый токен (одноразовый) и ручной перезапуск — как и раньше, авто-восстановить это нельзя.',
        });
        // Same reasoning the old uncaughtException handler had: there's no
        // way to auto-recover a dead room (the HaxBall token is single-use
        // and short-lived), so this just makes sure the crash is visible and
        // the process actually exits instead of sitting there half-alive
        // with Discord still running but no room behind it.
        setTimeout(() => process.exit(1), 2000);
    });

    const newPage = await browser.newPage();
    await newPage.exposeFunction('__dbCall', handleDbCall);
    await newPage.exposeFunction('__discordSend', handleDiscordSend);

    // Without this, everything the injected bundle logs (console.log/error
    // calls inside the page, including onRoomLink's own console.log(url))
    // only ever reaches the browser's own devtools console — invisible to
    // `pm2 logs`. Forwarding it here is the only way to see it from Node.
    newPage.on('console', (msg) => {
        console.log(`[PAGE ${msg.type()}]`, msg.text());
    });
    newPage.on('pageerror', (err) => {
        console.error('[PAGE ERROR]', err);
    });

    // networkidle2 previously hung indefinitely here (30s timeout) — this
    // page appears to keep some background connection alive, so "network
    // idle" never actually arrives. domcontentloaded is enough to have the
    // page's own scripts running, then wait for the one thing we actually
    // need: HBInit becoming available as a global.
    await newPage.goto('https://www.haxball.com/headless', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await newPage.waitForFunction(() => typeof window.HBInit === 'function', { timeout: 60000 });
    await newPage.evaluate((secrets) => {
        window.__secrets = secrets;
    }, { token, roomPassword, testMode, mentionWatchName });

    const bundle = await buildEntryBundle();
    await newPage.addScriptTag({ content: bundle });

    page = newPage;
    return { browser, page: newPage };
}

launchRoom().catch((err) => {
    console.error('[FATAL] Failed to launch room:', err);
    sendToDiscord({ type: 'log', content: `🔴 **Не удалось запустить комнату:**\n\`\`\`${err.stack || err}\`\`\`` });
    process.exitCode = 1;
});

// Last-resort safety net for THIS process (Puppeteer/orchestrator-side
// bugs) — errors inside the page itself are handled by entry.js's own
// window.addEventListener('error'/'unhandledrejection') instead, since
// they happen in a different JS realm this process can't see into.
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    sendToDiscord({ type: 'log', content: `🔴 **КРИТИЧЕСКАЯ ОШИБКА, оркестратор падает:**\n\`\`\`${(err && err.stack) || err}\`\`\`` });
    setTimeout(() => process.exit(1), 2000);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
    sendToDiscord({ type: 'log', content: `⚠️ **Необработанный reject в оркестраторе:**\n\`\`\`${(reason && reason.stack) || reason}\`\`\`` });
});
