/*
 * Entry point for the Discord bot's own process (forked from src/index.js
 * with `serialization: 'advanced'`). Runs on a completely separate event
 * loop from the HaxBall room: discord.js's gateway traffic, JSON parsing and
 * object churn can no longer compete with the room's physics tick for the
 * main thread, and a GC pause here can no longer show up to players as a
 * ping spike. Also owns the periodic DB backup (VACUUM INTO fully blocks
 * whichever event loop runs it — see db/sqlite.js's backup()) for the same
 * reason.
 *
 * Has no access to `room`/`state` — those live in the parent. Talks to it
 * over the fork's IPC channel: this process pushes 'relay'/'kickByAuth'/
 * 'muteByAuth'/'unmuteByAuth' messages up, and receives 'log'/'report'/
 * 'recording'/'roomLink'/'password'/'roster' messages down (see the
 * matching shim in src/index.js).
 */

// Registered first, before anything that could actually throw: a crash here
// must never take the room down with it — it's a separate process
// specifically so it can't. Just log and keep whatever still works (the
// parent auto-respawns this process if it does fully exit — see index.js).
process.on('uncaughtException', (err) => {
    console.error('[discordProcess] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[discordProcess] Unhandled rejection:', reason);
});

const path = require('node:path');
const fs = require('node:fs');

const {
    discordToken,
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
    maxPlayers,
    discordBffLogChannelId,
    discordBffReportChannelId,
    discordBridgePort,
} = require('./config');
const { maxPlayers: bffMaxPlayers } = require('./bff/roomConstants');
const { getTimeStats } = require('./utils');

// Routes this process's Discord gateway (WebSocket) traffic through
// DISCORD_PROXY_URL, when set — the ISP appears to drop Discord's TCP
// traffic outright, so both REST and the gateway need to go through it.
// This process only ever talks to Discord (see the file header above), so
// patching `ws` globally here is safe: the room/Puppeteer connection that
// players actually ride on lives entirely in the parent process and never
// sees this. Must run before `./discord` (-> discord.js -> @discordjs/ws)
// is required below, since @discordjs/ws reads `require('ws').WebSocket`
// once, at module-load time, into a module-level constant — patching it
// any later would be too late for that reference to pick it up.
if (discordProxyUrl) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const wsModule = require('ws');
    const socksAgent = new SocksProxyAgent(discordProxyUrl);
    const NativeWebSocket = wsModule.WebSocket;
    class ProxiedWebSocket extends NativeWebSocket {
        constructor(address, protocols, options) {
            super(address, protocols, { ...options, agent: socksAgent });
        }
    }
    wsModule.WebSocket = ProxiedWebSocket;
}

const { createDatabaseApi } = require('../../api/database');
const db = createDatabaseApi();
db.init();

const createPrintStats = require('./stats/print');
const { printPlayerStats } = createPrintStats({ getTimeStats, db });

// Mirrors the room's live roster, kept in sync via 'roster' messages from
// the parent (sent on every join/leave) — this process has no direct access
// to the real `room`/`state`.
const state = { playersAll: [] };
const authArray = [];

// process.send only exists while the IPC channel to the parent is alive —
// guarding every call means a channel hiccup degrades to "this particular
// message is dropped" instead of an uncaught TypeError.
function sendToParent(message) {
    if (process.connected) process.send(message);
}

// Bounded so a lost/delayed reply from the parent (dead channel, the parent
// itself mid-restart) can't leave a !banauth/`/banauth` command hung
// forever — kickPlayerByAuth always settles, worst case with "nobody was
// kicked", and the ban itself still gets recorded by the caller either way.
const KICK_REPLY_TIMEOUT_MS = 5000;
let nextRequestId = 1;
const pendingKicks = new Map();

function kickPlayerByAuth(auth, reason) {
    if (!process.connected) return Promise.resolve(null);
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingKicks.delete(requestId);
            resolve(null);
        }, KICK_REPLY_TIMEOUT_MS);
        pendingKicks.set(requestId, (result) => {
            clearTimeout(timer);
            resolve(result);
        });
        sendToParent({ type: 'kickByAuth', requestId, auth, reason });
    });
}

function relayToRoom(username, content) {
    sendToParent({ type: 'relay', username, content });
}

// Fire-and-forget, same as relayToRoom above — a member getting the
// configured VIP role on Discord (see discord.js's handleGuildMemberUpdate)
// grants room VIP to whichever HaxBall auth they've linked, but nothing on
// this side is waiting on a reply to report back.
function grantVipByAuth(auth, targetName) {
    sendToParent({ type: 'grantVip', auth, targetName });
}

// Same request/reply-with-timeout shape as kickPlayerByAuth above, for
// !muteauth/!unmuteauth (discord.js) — a lost/delayed reply degrades to
// "nobody was muted/unmuted" rather than hanging the command forever.
const MUTE_REPLY_TIMEOUT_MS = 5000;
const pendingMutes = new Map();
const pendingUnmutes = new Map();

function muteByAuth(auth, minutes) {
    if (!process.connected) return Promise.resolve({ ok: false, reason: 'offline' });
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingMutes.delete(requestId);
            resolve({ ok: false, reason: 'offline' });
        }, MUTE_REPLY_TIMEOUT_MS);
        pendingMutes.set(requestId, (result) => {
            clearTimeout(timer);
            resolve(result);
        });
        sendToParent({ type: 'muteByAuth', requestId, auth, minutes });
    });
}

function unmuteByAuth(auth) {
    if (!process.connected) return Promise.resolve({ ok: false });
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingUnmutes.delete(requestId);
            resolve({ ok: false });
        }, MUTE_REPLY_TIMEOUT_MS);
        pendingUnmutes.set(requestId, (result) => {
            clearTimeout(timer);
            resolve(result);
        });
        sendToParent({ type: 'unmuteByAuth', requestId, auth });
    });
}

const createDiscordBot = require('./discord');
const discordBot = createDiscordBot({
    discordToken,
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
    maxPlayers,
    discordBffLogChannelId,
    discordBffReportChannelId,
    bffMaxPlayers,
    db,
    state,
    getAuthArray: () => authArray,
    getPrintPlayerStats: () => printPlayerStats,
    relayToRoom,
    relayToBffRoom,
    kickPlayerByAuth,
    grantVipByAuth,
    muteByAuth,
    unmuteByAuth,
    getTimeStats,
});
discordBot.init();

process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
        case 'log':
            discordBot.sendLog(msg.content);
            break;
        case 'report':
            discordBot.sendReport(msg.embedData);
            break;
        case 'recording':
            discordBot.sendRecording(msg.buffer, msg.filename);
            break;
        case 'roomLink':
            discordBot.setRoomLink(msg.url);
            break;
        case 'password':
            discordBot.sendPassword(msg.password);
            break;
        case 'adminCall':
            discordBot.sendAdminCall(msg.playerName);
            break;
        case 'voteBanNotification':
            discordBot.sendVoteBanNotification({
                targetName: msg.targetName,
                durationMinutes: msg.durationMinutes,
                votesFor: msg.votesFor,
                votesAgainst: msg.votesAgainst,
                abstained: msg.abstained,
            });
            break;
        case 'mentionAlert':
            discordBot.sendMentionAlert(msg.speakerName, msg.text);
            break;
        case 'checkVipRoleOnLink':
            discordBot.checkVipRoleOnLink(msg.discordId, msg.auth, msg.targetName);
            break;
        case 'grantVipRole': {
            const discordId = db.getDiscordIdByAuth(msg.auth);
            if (discordId) discordBot.grantVipRole(discordId);
            break;
        }
        case 'revokeVipRole': {
            const discordId = db.getDiscordIdByAuth(msg.auth);
            if (discordId) discordBot.revokeVipRole(discordId);
            break;
        }
        case 'roster':
            state.playersAll = msg.players.map((p) => ({ id: p.id, name: p.name }));
            authArray.length = 0;
            for (const p of msg.players) authArray[p.id] = [p.auth];
            discordBot.updateRoomStatus();
            break;
        case 'kickResult': {
            const resolve = pendingKicks.get(msg.requestId);
            if (resolve) {
                pendingKicks.delete(msg.requestId);
                resolve(msg.result);
            }
            break;
        }
        case 'muteResult': {
            const resolve = pendingMutes.get(msg.requestId);
            if (resolve) {
                pendingMutes.delete(msg.requestId);
                resolve(msg.result);
            }
            break;
        }
        case 'unmuteResult': {
            const resolve = pendingUnmutes.get(msg.requestId);
            if (resolve) {
                pendingUnmutes.delete(msg.requestId);
                resolve(msg.result);
            }
            break;
        }
    }
});

/* BFF BRIDGE — local TCP server so the BFF orchestrator (src/bffIndex.js, a
 * genuinely separate, unrelated OS process — see haxchill-second-room-plan
 * project memory) can reach this SAME running Discord bot/client instead of
 * spawning a second one ("one shared bot for both rooms", confirmed). Plain
 * loopback TCP rather than a Unix socket specifically so this works
 * identically in local Windows dev and on the Linux VPS with no
 * platform-specific branching. Newline-delimited JSON, one message per
 * line — simple enough not to need a real framing protocol at this
 * message rate (a handful of events per minute, not a firehose). */
const net = require('node:net');

// Tracks the single active BFF connection (bffIndex.js only ever opens one)
// so relayToBffRoom below has something to write to — the bridge was
// write-only from BFF's side until now (log/report/recording/status/
// voteBanNotification/adminCall all flow BFF -> here, nothing flowed back
// the other way). !saybff/`/saybff` (discord.js) need the reverse
// direction, so this is the first thing sent back down this socket.
let bffSocket = null;

// Fire-and-forget, same as relayToRoom (index.js's IPC 'relay' message) —
// a disconnected/reconnecting BFF bridge degrades to "this message never
// reached the room," never to the command itself erroring.
function relayToBffRoom(username, content) {
    if (!bffSocket || bffSocket.destroyed) return;
    try {
        bffSocket.write(JSON.stringify({ type: 'relay', username, content }) + '\n');
    } catch (err) {
        console.error('[BFF bridge] Failed to write relay message:', err.message);
    }
}

function handleBffBridgeMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
        case 'log':
            discordBot.sendBffLog(msg.content);
            break;
        case 'report':
            discordBot.sendBffReport(msg.embedData);
            break;
        case 'recording':
            discordBot.sendBffRecording(Buffer.from(msg.bufferBase64, 'base64'), msg.filename);
            break;
        case 'status':
            discordBot.updateBffRoomStatus(msg.playerCount, msg.roomLink);
            break;
        // core/voteBan.js (reused as-is by BFF) — no dedicated BFF voteban
        // channel was ever confirmed in the design, so this is folded into
        // the existing log channel: it's a genuine moderation-log event,
        // same category as join/leave/kick already posted there.
        case 'voteBanNotification':
            discordBot.sendBffLog(
                `🔨 **Бан по голосованию**: **${msg.targetName}** забанен(а) на ${msg.durationMinutes} мин. ` +
                `(за: ${msg.votesFor}, против: ${msg.votesAgainst}, воздержались: ${msg.abstained})`
            );
            break;
        // !report (core/bff/adminCall.js) — corrected 2026-08-14: goes to
        // the SAME shared DISCORD_ADMIN_CALL_CHANNEL_ID the main room's own
        // !report already uses (not a separate BFF channel, and not folded
        // into the log channel like voteBanNotification above) — the
        // [BFF]/[FUTSAL] tags exist specifically so one shared channel can
        // tell the two rooms' alerts apart. Also picks up the real @here
        // ping sendAdminCall already does, which sendBffLog never had.
        case 'adminCall':
            discordBot.sendAdminCall(msg.playerName, 'BFF');
            break;
    }
}

const bffBridgeServer = net.createServer((socket) => {
    // bffIndex.js reconnects with backoff on drop (see its own
    // connectDiscordBridge) — always the latest/only connection, so a
    // fresh one here simply replaces whatever was tracked before.
    bffSocket = socket;
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (!line.trim()) continue;
            try {
                handleBffBridgeMessage(JSON.parse(line));
            } catch (err) {
                console.error('[BFF bridge] Failed to parse message:', err);
            }
        }
    });
    socket.on('close', () => {
        if (bffSocket === socket) bffSocket = null;
    });
    socket.on('error', (err) => {
        console.error('[BFF bridge] Socket error:', err.message);
    });
});
bffBridgeServer.on('error', (err) => {
    // Non-fatal: the main room's Discord integration must keep working
    // even if the BFF bridge can't bind (port already in use from a stale
    // process, etc.) — BFF's own orchestrator already tolerates a failed
    // connection (see bffIndex.js's Discord client, fire-and-forget with
    // its own reconnect backoff).
    console.error('[BFF bridge] Server error (BFF Discord bridging unavailable):', err.message);
});
bffBridgeServer.listen(discordBridgePort, '127.0.0.1', () => {
    console.log(`[BFF bridge] Listening on 127.0.0.1:${discordBridgePort}`);
});

/* DATABASE BACKUPS */

// Moved here from src/index.js for the same reason the Discord client lives
// here: VACUUM INTO fully blocks whichever event loop runs it for as long as
// it takes to snapshot the whole file, and that must never be the room's.
// WAL mode lets this connection see a consistent, fully committed snapshot
// regardless of which process (this one or the room's) last wrote to it.
const backupDir = path.join(__dirname, '..', '..', 'db', 'backups');
const backupIntervalMs = 6 * 60 * 60 * 1000;
const maxBackups = 28; // 1 week of history at the 6h cadence

function runDatabaseBackup() {
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        db.backup(path.join(backupDir, `haxlab-${stamp}.sqlite`));
        const backups = fs.existsSync(backupDir)
            ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.sqlite')).sort()
            : [];
        while (backups.length > maxBackups) {
            fs.unlinkSync(path.join(backupDir, backups.shift()));
        }
    } catch (err) {
        console.error('DB backup failed:', err);
        discordBot.sendLog(`⚠️ Не удалось создать резервную копию БД: ${err.message}`);
    }
}
runDatabaseBackup();
setInterval(runDatabaseBackup, backupIntervalMs);
