/*
 * BFF orchestrator — a genuinely separate Node process from src/index.js
 * (own pm2 entry, own headless Chromium), not a mode flag on the main
 * room's orchestrator. Mirrors src/index.js's architecture closely (same
 * Puppeteer-injection pattern, same DB/console bridging) with two real
 * differences: it wires TWO database files together (see
 * core/bff/dbBridge.js — BFF's own stats/rating file + the main room's
 * file for shared masters/admins/vips), and its Discord integration is
 * currently a STUB (see "DISCORD BRIDGE (STUB)" below) — the confirmed
 * "one shared bot process for both rooms" design needs its own IPC
 * mechanism between two unrelated processes, which is real, undone work
 * tracked separately (see haxchill-second-room-plan project memory), not
 * something to improvise here.
 */
const path = require('node:path');
const os = require('node:os');
const puppeteer = require('puppeteer');
const esbuild = require('esbuild');

const net = require('node:net');

const { bffRoomPassword, bffToken, testMode } = require('./core/bff/config');
const { discordBridgePort } = require('./core/config');
const { createDatabaseApi } = require('../api/database');
const createBffDatabaseBridge = require('./core/bff/dbBridge');
const { BRIDGED_METHODS } = require('./browser/dbBridgeClient');

// roomDb: BFF's own file (stats, rating, bans, settings). sharedDb: the
// SAME file the main room's src/index.js already uses (createDatabaseApi()
// with no override resolves to db/sqlite.js's own default path, which is
// anchored to db/sqlite.js's directory regardless of which orchestrator
// requires it — so this really is the identical file, not a copy).
const roomDb = createDatabaseApi({ filePath: path.join(__dirname, '..', 'db', 'haxlab-bff.sqlite') });
const sharedDb = createDatabaseApi();
const db = createBffDatabaseBridge({ roomDb, sharedDb });
db.init();

/* CONNECTION-DROP MONITORING — same diagnostic as the main room's
 * src/index.js, genuinely useful here too since it's the identical
 * headless-Chromium-on-a-shared-vCPU architecture. See that file's own
 * comment for the full incident history this is watching for. */
const LOAD_SAMPLE_INTERVAL_MS = 2000;
const LOAD_HISTORY_MS = 120000;
const loadHistory = [];
setInterval(() => {
    loadHistory.push({ t: Date.now(), load: os.loadavg()[0] });
    const cutoff = Date.now() - LOAD_HISTORY_MS;
    while (loadHistory.length && loadHistory[0].t < cutoff) loadHistory.shift();
}, LOAD_SAMPLE_INTERVAL_MS);

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
        `[BFF MONITOR] ${trigger} at ${new Date(now).toISOString()} — ` +
        `load now: ${os.loadavg()[0].toFixed(2)} (of ${cpuCount} core${cpuCount === 1 ? '' : 's'}), ` +
        `peak ${peak ? peak.load.toFixed(2) : 'n/a'}${peak ? ` (${Math.round((now - peak.t) / 1000)}s before this)` : ''}, ` +
        `free mem: ${Math.round(os.freemem() / 1024 / 1024)}MB, ` +
        `trend (last ${LOAD_HISTORY_MS / 1000}s, oldest->newest): ${recent.length ? loadSparkline(recent.map((s) => s.load)) : 'n/a'}`
    );
}

/* DISCORD BRIDGE — connects to the main room's discordProcess.js over a
 * local loopback TCP socket (see its own "BFF BRIDGE" section) instead of
 * spawning a second bot process here: the confirmed design is ONE shared
 * Discord bot for both rooms. Best-effort, matching how every discordBot.*
 * call in src/core/* has always been fire-and-forget: a dropped/reconnecting
 * socket degrades to "this message never reached Discord," never to the
 * room itself failing. */
let discordSocket = null;
let discordReconnectTimer = null;
const DISCORD_RECONNECT_DELAY_MS = 5000;

// discordProcess.js -> here: newline-delimited JSON, same framing it uses
// for the reverse direction (see its own "BFF BRIDGE" section). Only
// message type so far is 'relay' (!saybff/`/saybff`, discord.js) — the
// bridge was write-only from this side until now.
let discordBridgeBuffer = '';
function handleDiscordBridgeMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'relay') {
        if (page) page.evaluate((m) => window.__bffRoomBridge.relayToRoom(m.username, m.content), msg).catch((err) => console.error('[BFF] relay bridge failed:', err));
    }
}

function connectDiscordBridge() {
    const socket = net.connect(discordBridgePort, '127.0.0.1');
    socket.on('connect', () => {
        console.log('[BFF] Connected to the shared Discord bridge.');
        discordSocket = socket;
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
                console.error('[BFF] Failed to parse Discord bridge message:', err);
            }
        }
    });
    socket.on('error', () => {
        // Expected/frequent if discordProcess.js hasn't started its bridge
        // server yet (startup ordering between the two independent pm2
        // processes isn't guaranteed) — the reconnect loop below handles
        // it, so this doesn't need its own log spam.
    });
    socket.on('close', () => {
        if (discordSocket === socket) discordSocket = null;
        discordBridgeBuffer = '';
        clearTimeout(discordReconnectTimer);
        discordReconnectTimer = setTimeout(connectDiscordBridge, DISCORD_RECONNECT_DELAY_MS);
    });
}
connectDiscordBridge();

function sendToDiscord(message) {
    if (!discordSocket || discordSocket.destroyed) return;
    try {
        discordSocket.write(JSON.stringify(message) + '\n');
    } catch (err) {
        console.error('[BFF] Failed to write to Discord bridge:', err.message);
    }
}

// Combined status message needs both values together (see discord.js's
// updateBffRoomStatus) — tracked here the same way the main room's own
// index.js tracks lastRoomLink, since 'roomLink' only ever arrives once
// (onRoomLink fires a single time) while 'roster' arrives on every join/leave.
let lastBffRoomLink = null;
let lastBffPlayerCount = 0;

let page = null;

/* DB BRIDGE */
const dbMethodAllowlist = new Set(BRIDGED_METHODS);
async function handleDbCall(method, args) {
    if (!dbMethodAllowlist.has(method) || typeof db[method] !== 'function') {
        throw new Error(`Bridged db call to disallowed method: ${method}`);
    }
    return db[method](...args);
}

/* DISCORD BRIDGE (page -> here) */
function handleDiscordSend(type, payload) {
    // 'roomLink' (fires once, see onRoomLink) and 'roster' (fires on every
    // join/leave, see discordBridgeClient.js's updateRoomStatus) both need
    // to be combined into ONE 'status' message — discord.js's
    // updateBffRoomStatus wants playerCount and roomLink together, not two
    // separate partial updates.
    if (type === 'roomLink') {
        lastBffRoomLink = payload.url;
        sendToDiscord({ type: 'status', playerCount: lastBffPlayerCount, roomLink: lastBffRoomLink });
        return;
    }
    if (type === 'roster') {
        lastBffPlayerCount = payload.players.length;
        if (lastBffRoomLink) sendToDiscord({ type: 'status', playerCount: lastBffPlayerCount, roomLink: lastBffRoomLink });
        return;
    }
    if (type === 'recording') {
        sendToDiscord({ type: 'recording', bufferBase64: payload.bufferBase64, filename: payload.filename });
        return;
    }
    sendToDiscord({ type, ...payload });
}

/* BUNDLE — built fresh at every startup from bffEntry.js, same reasoning
 * as the main room's own buildEntryBundle() (see src/index.js): never
 * drifts from source on disk, no committed-bundle staleness risk. */
async function buildBffEntryBundle() {
    const result = await esbuild.build({
        entryPoints: [path.join(__dirname, 'browser', 'bffEntry.js')],
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
    // Same flags as the main room's launchRoom() — proven to work on this
    // exact VPS tier (see haxchill-puppeteer-migration memory). ONE
    // deliberate difference: a different --remote-debugging-port. Both
    // orchestrators run as separate OS processes on the same box — reusing
    // port 9222 here would collide with the main room's own browser
    // instance the moment both are running at once.
    const browser = await puppeteer.launch({
        args: [
            '--remote-debugging-port=9223',
            '--disable-features=WebRtcHideLocalIpsWithMdns,AsyncDns',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // Same fix as src/index.js — see its own comment for the full
            // reasoning (a QUIC-specific load failure on RUVDS's network
            // left window.HBInit undefined, crashing init with a "JSON5 is
            // not defined" error that belongs to HBInit's own code, not
            // ours).
            '--disable-quic',
            // Same fix as src/index.js — see its own comment for the full
            // reasoning (Chrome's background-tab timer throttling, tripped
            // by an empty/quiet room, was the likely source of at least
            // some of the "jitter" the main room's own monitor reported).
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
        ],
    });

    browser.on('disconnected', () => {
        console.error('[BFF FATAL] Browser disconnected/crashed.');
        sendToDiscord({
            type: 'log',
            content: '🔴 **[BFF] КРИТИЧЕСКАЯ ОШИБКА: браузер комнаты упал.** Нужен новый токен и ручной перезапуск.',
        });
        setTimeout(() => process.exit(1), 2000);
    });

    try {
        const newPage = await browser.newPage();
        await newPage.exposeFunction('__dbCall', handleDbCall);
        await newPage.exposeFunction('__discordSend', handleDiscordSend);

        // Same fix as src/index.js — see its own comment for the full
        // incident (a bundle that injected fine but never actually finished
        // initialising, forever, with no retry). Wired before addScriptTag
        // so bffEntry.js's own __reportInit call always has something to
        // call into.
        let resolveInit;
        const initPromise = new Promise((resolve) => { resolveInit = resolve; });
        await newPage.exposeFunction('__reportInit', (result) => resolveInit(result));

        newPage.on('console', (msg) => {
            const text = msg.text();
            console.log(`[BFF PAGE ${msg.type()}]`, text);
            if (text.includes('WebSocket is already in CLOSING or CLOSED state')) {
                logConnectionDropDiagnostics('WebSocket drop detected');
            }
        });
        newPage.on('pageerror', (err) => {
            console.error('[BFF PAGE ERROR]', err);
        });

        await newPage.goto('https://www.haxball.com/headless', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await newPage.waitForFunction(() => typeof window.HBInit === 'function', { timeout: 60000 });
        await newPage.evaluate((secrets) => {
            window.__secrets = secrets;
        }, { bffToken, bffRoomPassword, testMode });

        const bundle = await buildBffEntryBundle();
        await newPage.addScriptTag({ content: bundle });

        const INIT_TIMEOUT_MS = 20000;
        const initResult = await Promise.race([
            initPromise,
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'bffEntry.js never reported init (timed out)' }), INIT_TIMEOUT_MS)),
        ]);
        if (!initResult.ok) {
            throw new Error(`bffEntry.js failed to initialise: ${initResult.error}`);
        }

        page = newPage;
        return { browser, page: newPage };
    } catch (err) {
        // Same leak fix as the main room's own launchRoom() (see
        // src/index.js) — a thrown error here used to leave this browser
        // process orphaned forever, only relevant once retries (below)
        // could actually call launchRoom() more than once.
        await browser.close().catch(() => {});
        throw err;
    }
}

// Same self-heal fix as the main room's own launchRoomWithRetries (see
// src/index.js's own comment for the full reasoning — this used to only
// set process.exitCode = 1, never actually exiting, so pm2 never restarted
// it and a launch failure just sat there forever, silently dead).
const LAUNCH_RETRY_DELAYS_MS = [30000, 120000, 300000]; // 30s, 2min, 5min

async function launchRoomWithRetries() {
    for (let attempt = 0; attempt <= LAUNCH_RETRY_DELAYS_MS.length; attempt++) {
        try {
            await launchRoom();
            return;
        } catch (err) {
            console.error(`[BFF FATAL] Failed to launch room (attempt ${attempt + 1}/${LAUNCH_RETRY_DELAYS_MS.length + 1}):`, err);
            if (attempt === 0) {
                sendToDiscord({ type: 'roomDown' });
                sendToDiscord({ type: 'log', content: `🔴 **[BFF] Не удалось запустить комнату:**\n\`\`\`${err.stack || err}\`\`\`\nПовторю попытку через ${LAUNCH_RETRY_DELAYS_MS[0] / 1000} сек.` });
            }
            if (attempt < LAUNCH_RETRY_DELAYS_MS.length) {
                await new Promise((resolve) => setTimeout(resolve, LAUNCH_RETRY_DELAYS_MS[attempt]));
                continue;
            }
            sendToDiscord({ type: 'log', content: `🔴 [BFF] Комната не запустилась после ${LAUNCH_RETRY_DELAYS_MS.length + 1} попыток. Перезапускаюсь для новой попытки...` });
            setTimeout(() => process.exit(1), 2000);
        }
    }
}

launchRoomWithRetries();

process.on('uncaughtException', (err) => {
    console.error('[BFF FATAL] Uncaught exception:', err);
    sendToDiscord({ type: 'log', content: `🔴 **[BFF] КРИТИЧЕСКАЯ ОШИБКА, оркестратор падает:**\n\`\`\`${(err && err.stack) || err}\`\`\`` });
    setTimeout(() => process.exit(1), 2000);
});
process.on('unhandledRejection', (reason) => {
    console.error('[BFF FATAL] Unhandled rejection:', reason);
    sendToDiscord({ type: 'log', content: `⚠️ **[BFF] Необработанный reject в оркестраторе:**\n\`\`\`${(reason && reason.stack) || reason}\`\`\`` });
});
