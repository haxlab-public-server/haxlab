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
 * and a connection to the shared Discord bot process — genuinely
 * independent now (confirmed 2026-08-15, see discordProcess.js's own
 * header comment for why), reached over local loopback TCP the same way
 * BFF's own orchestrator already reaches it, not fork()'s built-in IPC.
 * Its two room-touching message types reach the page via page.evaluate()
 * instead of touching `room`/`state` directly.
 */
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const puppeteer = require('puppeteer');
const esbuild = require('esbuild');

const { roomPassword, token, testMode, mentionWatchName, discordMainBridgePort } = require('./core/config');
const { createDatabaseApi } = require('../api/database');
const { BRIDGED_METHODS } = require('./browser/dbBridgeClient');

const db = createDatabaseApi();
db.init();

/* CONNECTION-DROP MONITORING */
// Diagnostic for a live incident (players reporting redbars followed by a
// ping spike + mass disconnect, no corresponding pm2 restart): correlates
// the page's own "WebSocket is already in CLOSING or CLOSED state" errors
// — a symptom of the room's live connection to HaxBall dying and
// reconnecting — with this host's own CPU load in the run-up to it.
// Working theory: on a single-vCPU box, the browser's networking
// occasionally can't get serviced promptly enough under load, and
// HaxBall's server sees that as a dead connection; the redbars players see
// just before the kick would be the same underlying stall, visible to them
// slightly earlier. Confirmed by players: this sequence (redbars, then
// kick) only happens on this VPS, not on other rooms — so the shape of the
// load trend leading up to each occurrence, not just the peak, is what
// actually confirms or rules out CPU starvation as the cause. Just grep pm2
// logs for '[MONITOR]' to see every occurrence.
const LOAD_SAMPLE_INTERVAL_MS = 2000;
const LOAD_HISTORY_MS = 120000; // 2 minutes: comfortably covers redbars-then-kick
const loadHistory = [];
setInterval(() => {
    loadHistory.push({ t: Date.now(), load: os.loadavg()[0] });
    const cutoff = Date.now() - LOAD_HISTORY_MS;
    while (loadHistory.length && loadHistory[0].t < cutoff) loadHistory.shift();
}, LOAD_SAMPLE_INTERVAL_MS);

// Compact visual shape of the trend (low->high mapped to increasingly
// tall block characters) so a human skimming pm2 logs can see AT A GLANCE
// whether load ramped up gradually or spiked suddenly, without having to
// mentally parse a list of numbers.
function loadSparkline(values) {
    const blocks = '▁▂▃▄▅▆▇█';
    const max = Math.max(...values, 0.1);
    return values.map((v) => blocks[Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1)))]).join('');
}

function logConnectionDropDiagnostics(trigger) {
    const cpuCount = os.cpus().length;
    const now = Date.now();
    const recent = loadHistory.filter((s) => now - s.t <= LOAD_HISTORY_MS);
    let peak = null;
    for (const s of recent) {
        if (!peak || s.load > peak.load) peak = s;
    }
    console.log(
        `[MONITOR] ${trigger} at ${new Date(now).toISOString()} — ` +
        `load now: ${os.loadavg()[0].toFixed(2)} (of ${cpuCount} core${cpuCount === 1 ? '' : 's'}), ` +
        `peak ${peak ? peak.load.toFixed(2) : 'n/a'}${peak ? ` (${Math.round((now - peak.t) / 1000)}s before this)` : ''}, ` +
        `free mem: ${Math.round(os.freemem() / 1024 / 1024)}MB, ` +
        `trend (last ${LOAD_HISTORY_MS / 1000}s, oldest->newest): ${recent.length ? loadSparkline(recent.map((s) => s.load)) : 'n/a'}`
    );
}

/* DISCORD BRIDGE (TCP client) */
// discordProcess.js is a genuinely independent pm2 process now (confirmed
// 2026-08-15 — see its own header comment for why), reached over local
// loopback TCP the same way BFF's own orchestrator already reaches it,
// rather than fork()'s built-in IPC. Reconnects with a simple fixed delay
// on drop, same as bffIndex.js's own connectDiscordBridge — no exponential
// backoff needed here anymore: that used to guard against rapidly
// respawning a whole Discord gateway client (heavy, rate-limit-sensitive)
// on a crash loop, but this process no longer spawns/owns that client at
// all, just a cheap TCP socket to an already-running, independently
// supervised one.
let discordSocket = null;
let discordReconnectTimer = null;
const DISCORD_RECONNECT_DELAY_MS = 5000;

// room.onRoomLink only fires once, right when the room is first created —
// a discordProcess.js that (re)starts after that, or a reconnect following
// a dropped socket, would otherwise never learn it. Cached here (set
// whenever a 'roomLink' message passes through __discordSend below) so
// resyncDiscordProcess can replay it.
let lastRoomLink = null;

// Set once the browser/page is ready (see launchRoom below) — every
// Discord->room bridge call guards on this being non-null, since the
// Discord bridge can connect before the browser is ready.
let page = null;

function sendToDiscord(message) {
    if (!discordSocket || discordSocket.destroyed) return;
    try {
        discordSocket.write(JSON.stringify(message) + '\n');
    } catch (err) {
        console.error('[WARN] Failed to write to Discord bridge:', err.message);
    }
}

// Replays the state a freshly (re)connected discordProcess.js would
// otherwise have missed — whether because IT just (re)started (its own
// in-memory roster is empty until told) or because THIS process just
// (re)started (a fresh page always starts with a real roomLink of its own
// via room.onRoomLink, but discordProcess.js has no way to know that
// without this). Reads the roster from the page (this process holds none
// of it directly) — a no-op if the page isn't ready yet.
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

let discordBridgeBuffer = '';
function handleDiscordBridgeMessage(msg) {
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
}

function connectDiscordBridge() {
    const socket = net.connect(discordMainBridgePort, '127.0.0.1');
    socket.on('connect', () => {
        console.log('[Main] Connected to the shared Discord bridge.');
        discordSocket = socket;
        resyncDiscordProcess();
    });
    socket.on('data', (chunk) => {
        discordBridgeBuffer += chunk.toString('utf8');
        let newlineIndex;
        while ((newlineIndex = discordBridgeBuffer.indexOf('\n')) !== -1) {
            const line = discordBridgeBuffer.slice(0, newlineIndex);
            discordBridgeBuffer = discordBridgeBuffer.slice(newlineIndex + 1);
            if (!line.trim()) continue;
            try {
                handleDiscordBridgeMessage(JSON.parse(line));
            } catch (err) {
                console.error('[WARN] Failed to parse Discord bridge message:', err);
            }
        }
    });
    socket.on('error', () => {
        // Expected/frequent if discordProcess.js hasn't started yet (startup
        // ordering between independent pm2 processes isn't guaranteed) — the
        // reconnect loop below handles it, so this doesn't need its own log
        // spam.
    });
    socket.on('close', () => {
        if (discordSocket === socket) discordSocket = null;
        discordBridgeBuffer = '';
        clearTimeout(discordReconnectTimer);
        discordReconnectTimer = setTimeout(connectDiscordBridge, DISCORD_RECONNECT_DELAY_MS);
    });
}
connectDiscordBridge();

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
    // 'recording' carries bufferBase64 straight through, unchanged — no
    // longer decoded into a real Buffer here: fork()'s 'advanced'
    // serialization could carry a Buffer natively, but sendToDiscord now
    // writes plain JSON over a TCP socket (see discordProcess.js's own
    // handleMainBridgeMessage, which decodes it on that end instead, same
    // as it already does for BFF's identical 'recording' message).
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
            // Real bug found 2026-08-18: the room's own tick-jitter monitor
            // (entry.js) fired far more often with an EMPTY room than a
            // full one — backwards from what real CPU/hypervisor contention
            // would look like (that gets WORSE under our own load, not
            // better). Chrome throttles/coalesces setInterval/setTimeout on
            // pages it judges "backgrounded" (no visible changes, no real
            // input) to save power — a headless page that's never actually
            // foregrounded as a real window, sitting quiet with nobody
            // playing, is exactly what trips that heuristic. An active
            // match's constant rendering/network activity was masking it.
            // These three flags are the standard, well-documented fix for
            // long-running Puppeteer automation — without them, Chrome's
            // own power-saving was likely the source of at least SOME of
            // the "jitter" the monitor was reporting as external stutter.
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
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

    try {
        const newPage = await browser.newPage();
        await newPage.exposeFunction('__dbCall', handleDbCall);
        await newPage.exposeFunction('__discordSend', handleDiscordSend);

        // Without this, everything the injected bundle logs (console.log/error
        // calls inside the page, including onRoomLink's own console.log(url))
        // only ever reaches the browser's own devtools console — invisible to
        // `pm2 logs`. Forwarding it here is the only way to see it from Node.
        newPage.on('console', (msg) => {
            const text = msg.text();
            console.log(`[PAGE ${msg.type()}]`, text);
            if (text.includes('WebSocket is already in CLOSING or CLOSED state')) {
                logConnectionDropDiagnostics('WebSocket drop detected');
            }
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
    } catch (err) {
        // Real bug fixed 2026-08-15: a failure here used to leave this
        // browser process running, orphaned, forever — `browser` was only
        // ever local to this function, never closed on a thrown error.
        // Harmless for a single unrecoverable failure, but a real resource
        // leak once launchRoom() started being retried in-process (see
        // launchRoomWithRetries below) — each failed attempt would have
        // left one more zombie Chromium running.
        await browser.close().catch(() => {});
        throw err;
    }
}

// Real bug fixed 2026-08-15 ("launchRoom() doesn't self-heal" — the actual
// root cause of a real ~20-minute outage): a launch failure used to only
// set process.exitCode = 1, which does NOT actually terminate the process —
// pm2 never saw a crash and never auto-restarted, so the room sat dead
// forever, silently, with `page` stuck null, until a human noticed and
// restarted by hand. Now retries a few times with a growing delay before
// giving up — that specific outage was a transient elevated Cloudflare
// security posture (see haxchill-vps-deployment project memory), and simply
// trying again a few minutes later is literally what fixed it. The Discord
// status flips to "down" on the FIRST failure already (not only once every
// retry has also failed), so nobody's left staring at a dead-but-still-
// displayed join link in the meantime.
const LAUNCH_RETRY_DELAYS_MS = [30000, 120000, 300000]; // 30s, 2min, 5min

async function launchRoomWithRetries() {
    for (let attempt = 0; attempt <= LAUNCH_RETRY_DELAYS_MS.length; attempt++) {
        try {
            await launchRoom();
            return;
        } catch (err) {
            console.error(`[FATAL] Failed to launch room (attempt ${attempt + 1}/${LAUNCH_RETRY_DELAYS_MS.length + 1}):`, err);
            if (attempt === 0) {
                sendToDiscord({ type: 'roomDown' });
                sendToDiscord({ type: 'log', content: `🔴 **Не удалось запустить комнату:**\n\`\`\`${err.stack || err}\`\`\`\nПовторю попытку через ${LAUNCH_RETRY_DELAYS_MS[0] / 1000} сек.` });
            }
            if (attempt < LAUNCH_RETRY_DELAYS_MS.length) {
                await new Promise((resolve) => setTimeout(resolve, LAUNCH_RETRY_DELAYS_MS[attempt]));
                continue;
            }
            // Every in-process retry exhausted — exit so pm2 hands this a
            // genuinely fresh process (new Chromium instance, not the same
            // possibly-wedged attempt) rather than looping forever inside
            // one. pm2 restarts near-instantly, so the NEXT process's own
            // retry cycle becomes the "still down, remind again" cadence
            // from here on, roughly every ~8 minutes (this cycle's own
            // delays) for as long as the underlying issue persists.
            sendToDiscord({ type: 'log', content: `🔴 Комната не запустилась после ${LAUNCH_RETRY_DELAYS_MS.length + 1} попыток. Перезапускаюсь для новой попытки...` });
            setTimeout(() => process.exit(1), 2000);
        }
    }
}

launchRoomWithRetries();

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
