/*
 * Entry point for the Discord bot's own process — a genuinely independent
 * pm2 process (own ecosystem.config.js entry, own root wrapper
 * HaxDiscordBot_public.js), not forked from either room's orchestrator.
 * Confirmed 2026-08-15: the bot used to be forked from src/index.js
 * specifically, which meant restarting the main room (any deploy, crash, or
 * forced restart) also killed and respawned Discord — dropping BFF's own
 * bridge connection along with it even though BFF was never touched. Runs
 * on its own event loop either way: discord.js's gateway traffic, JSON
 * parsing and object churn was never meant to compete with either room's
 * physics tick for the main thread, and a GC pause here must never show up
 * to players as a ping spike. Also owns the periodic DB backup (VACUUM INTO
 * fully blocks whichever event loop runs it — see db/sqlite.js's backup())
 * for the same reason.
 *
 * Has no access to either room's `room`/`state` directly — those live in
 * their own orchestrator processes (src/index.js, src/bffIndex.js). Talks
 * to both over local loopback TCP, one listener per room (discordBridgePort
 * for BFF, discordMainBridgePort for the main room — see ./config), plain
 * newline-delimited JSON on each. Symmetric in both directions: this
 * process pushes 'relay'/'kickByAuth'/'muteByAuth'/'unmuteByAuth'/etc.
 * messages to whichever room they're addressed to, and receives
 * 'log'/'report'/'recording'/'roomLink'/'password'/'roster'/etc. messages
 * back from it.
 */

// Registered first, before anything that could actually throw: a crash here
// must never take either room down with it — it's a separate process
// specifically so it can't. Just log and keep whatever still works (pm2
// auto-restarts this process on its own if it does fully exit).
process.on('uncaughtException', (err) => {
    console.error('[discordProcess] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[discordProcess] Unhandled rejection:', reason);
});

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

// The VPS this runs on has few vCPUs shared with BOTH rooms' own Chromium
// instances — lowering this process's own OS scheduling priority means the
// kernel favors room rendering/JS (i.e. player ping) over Discord traffic
// whenever more than one wants the CPU at the same instant. Previously done
// externally by src/index.js right after fork()'ing this process (it had
// the child's pid to hand to os.setPriority); now that this runs as its own
// independent process with no parent to do that for it, it does it to
// itself. Best-effort: some platforms/permission setups don't allow this,
// and that must never take this process down.
try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW);
} catch (err) {
    console.error('[WARN] Could not lower Discord process OS priority:', err.message);
}

const {
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
    maxPlayers,
    discordBffLogChannelId,
    discordBffReportChannelId,
    discordBridgePort,
    discordMainBridgePort,
} = require('./config');
const { maxPlayers: bffMaxPlayers } = require('./bff/roomConstants');
const { getTimeStats, generateRoomPassword } = require('./utils');

// Routes this process's Discord gateway (WebSocket) traffic through
// DISCORD_PROXY_URL, when set — the ISP appears to drop Discord's TCP
// traffic outright, so both REST and the gateway need to go through it.
// This process only ever talks to Discord (see the file header above), so
// patching `ws` globally here is safe: neither room's own Puppeteer
// connection (what players actually ride on) lives in this process or ever
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

// Mirrors the main room's live roster, kept in sync via 'roster' messages
// from it (sent on every join/leave) — this process has no direct access to
// the real `room`/`state`. BFF doesn't feed this at all (only !stats/`/stats`
// need a live roster, and those have only ever looked up the main room's).
const state = { playersAll: [] };
const authArray = [];

/* MAIN ROOM BRIDGE — local TCP server the main room's orchestrator
 * (src/index.js) connects to, the same shape as the BFF bridge below (see
 * its own comment for why plain loopback TCP rather than a Unix socket).
 * Used to be the main room's own dedicated channel via fork()'s built-in
 * IPC; now genuinely symmetric with BFF's bridge, just a different port and
 * message vocabulary (the main room's discordBot.* calls, not the *Bff*
 * ones, plus the kickByAuth/muteByAuth/unmuteByAuth request/reply protocol
 * BFF has no equivalent of yet). */

let mainSocket = null;

function sendToMainRoom(message) {
    if (!mainSocket || mainSocket.destroyed) return;
    try {
        mainSocket.write(JSON.stringify(message) + '\n');
    } catch (err) {
        console.error('[Main bridge] Failed to write message:', err.message);
    }
}

// Bounded so a lost/delayed reply from the main room (dead channel, that
// process itself mid-restart) can't leave a !banauth/`/banauth` command hung
// forever — kickPlayerByAuth always settles, worst case with "nobody was
// kicked", and the ban itself still gets recorded by the caller either way.
const KICK_REPLY_TIMEOUT_MS = 5000;
let nextRequestId = 1;
const pendingKicks = new Map();

function kickPlayerByAuth(auth, reason) {
    if (!mainSocket || mainSocket.destroyed) return Promise.resolve(null);
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
        sendToMainRoom({ type: 'kickByAuth', requestId, auth, reason });
    });
}

function relayToRoom(username, content) {
    sendToMainRoom({ type: 'relay', username, content });
}

// Fire-and-forget, same as relayToRoom above — a member getting the
// configured VIP role on Discord (see discord.js's handleGuildMemberUpdate)
// grants room VIP to whichever HaxBall auth they've linked, but nothing on
// this side is waiting on a reply to report back.
function grantVipByAuth(auth, targetName) {
    sendToMainRoom({ type: 'grantVip', auth, targetName });
}

// Same request/reply-with-timeout shape as kickPlayerByAuth above, for
// !muteauth/!unmuteauth (discord.js) — a lost/delayed reply degrades to
// "nobody was muted/unmuted" rather than hanging the command forever.
const MUTE_REPLY_TIMEOUT_MS = 5000;
const pendingMutes = new Map();
const pendingUnmutes = new Map();

function muteByAuth(auth, minutes) {
    if (!mainSocket || mainSocket.destroyed) return Promise.resolve({ ok: false, reason: 'offline' });
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
        sendToMainRoom({ type: 'muteByAuth', requestId, auth, minutes });
    });
}

function unmuteByAuth(auth) {
    if (!mainSocket || mainSocket.destroyed) return Promise.resolve({ ok: false });
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
        sendToMainRoom({ type: 'unmuteByAuth', requestId, auth });
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

// Telegram bot (requested 2026-08-17, see core/telegram.js) — reuses THIS
// process's own `db` (already the direct connection to the main room's
// physical file, the canonical/shared store both the overflow password and
// telegram_links live in) rather than spinning up a separate process.
const createTelegramBot = require('./telegram');
createTelegramBot({ db, telegramBotToken, generateRoomPassword }).init();

// Unchanged in substance from the old process.on('message') switch — just
// invoked from the TCP data handler below instead of fork() IPC. Handles
// both directions that flow over the main room's socket: messages IT
// initiates (log/report/recording/...) and replies to requests THIS process
// initiated (kickResult/muteResult/unmuteResult).
function handleMainBridgeMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
        case 'log':
            discordBot.sendLog(msg.content);
            break;
        case 'report':
            discordBot.sendReport(msg.embedData);
            recordMatchForDigest(msg.embedData, 'main');
            break;
        case 'recording':
            discordBot.sendRecording(Buffer.from(msg.bufferBase64, 'base64'), msg.filename);
            break;
        case 'roomLink':
            discordBot.setRoomLink(msg.url);
            break;
        // Sent once src/index.js's own launch-retry loop has genuinely
        // given up (requested 2026-08-15, after an outage where the status
        // message kept showing a dead link the whole time with no
        // indication anything was wrong) — see discord.js's own setRoomDown.
        case 'roomDown':
            discordBot.setRoomDown();
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
}

const mainBridgeServer = net.createServer((socket) => {
    // src/index.js reconnects with backoff on drop (mirroring bffIndex.js's
    // own connectDiscordBridge) — always the latest/only connection, so a
    // fresh one here simply replaces whatever was tracked before.
    mainSocket = socket;
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (!line.trim()) continue;
            try {
                handleMainBridgeMessage(JSON.parse(line));
            } catch (err) {
                console.error('[Main bridge] Failed to parse message:', err);
            }
        }
    });
    socket.on('close', () => {
        if (mainSocket === socket) mainSocket = null;
    });
    socket.on('error', (err) => {
        console.error('[Main bridge] Socket error:', err.message);
    });
});
mainBridgeServer.on('error', (err) => {
    // Non-fatal: BFF's own bridge (and the Discord client itself) must keep
    // working even if this particular listener can't bind (port already in
    // use from a stale process, etc.) — src/index.js already tolerates a
    // failed connection (fire-and-forget, own reconnect backoff).
    console.error('[Main bridge] Server error (main room Discord bridging unavailable):', err.message);
});
mainBridgeServer.listen(discordMainBridgePort, '127.0.0.1', () => {
    console.log(`[Main bridge] Listening on 127.0.0.1:${discordMainBridgePort}`);
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

// Tracks the single active BFF connection (bffIndex.js only ever opens one)
// so relayToBffRoom below has something to write to.
let bffSocket = null;

// Fire-and-forget, same as relayToRoom above — a disconnected/reconnecting
// BFF bridge degrades to "this message never reached the room," never to
// the command itself erroring.
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
            recordMatchForDigest(msg.embedData, 'bff');
            break;
        case 'recording':
            discordBot.sendBffRecording(Buffer.from(msg.bufferBase64, 'base64'), msg.filename);
            break;
        case 'status':
            discordBot.updateBffRoomStatus(msg.playerCount, msg.roomLink);
            break;
        // Same idea as the main room's own 'roomDown' (see
        // handleMainBridgeMessage above) — bffIndex.js's own launch-retry
        // loop has genuinely given up.
        case 'roomDown':
            discordBot.setBffRoomDown();
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
        // !report already uses (not a separate BFF channel), tagged so the
        // one shared channel can tell the two rooms' alerts apart. Also
        // picks up the real @here ping sendAdminCall already does, which
        // sendBffLog never had.
        case 'adminCall':
            discordBot.sendAdminCall(msg.playerName, 'BFF');
            break;
        // Real bug fixed 2026-08-17: this case was simply missing — BFF's
        // core/overflowPassword.js (reused as-is, see bffEntry.js) calls
        // discordBot.sendPassword() over this exact bridge same as the main
        // room does over its own, but with no matching case here the
        // message was silently dropped by this switch (no default branch,
        // no error). The room itself still correctly got password-
        // protected (room.setPassword() is local, doesn't need the bridge)
        // — only the Discord announcement telling anyone what the password
        // actually was never arrived, making it look totally broken from a
        // player's side. No room tag (unlike adminCall above) — both rooms
        // now share ONE overflow password (see overflowPassword.js's own
        // doc comment), so this genuinely applies to both regardless of
        // which room's threshold triggered the mint.
        case 'password':
            discordBot.sendPassword(msg.password);
            break;
    }
}

const bffBridgeServer = net.createServer((socket) => {
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

// Lives here rather than in either room's orchestrator for the same reason
// the Discord client does: VACUUM INTO fully blocks whichever event loop
// runs it for as long as it takes to snapshot the whole file, and that must
// never be either room's. WAL mode lets this connection see a consistent,
// fully committed snapshot regardless of which process (this one or either
// room's) last wrote to it.
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

/* PERIODIC ADMIN ACTIVITY DIGEST (item #19) */

// No per-match log table is ever actually populated in this codebase (see
// db/sqlite.js's saveGameReport — defined, never called from anywhere) —
// this piggybacks on the SAME 'report' bridge messages already flowing
// through here for Discord's own match-report embeds (every natural match
// end, both rooms) rather than adding a second persistence path just for
// this. Reset to zero after every post, so each digest only covers what
// happened since the last one, not a running total.
const digestState = { mainMatches: 0, bffMatches: 0, players: new Set() };

// Every participant gets exactly one "> **Name:**" line in the Game Time
// section of every report (see stats/fetch.js/core/bff/report.js);
// goal-scorers/assisters/keepers get a second one in the Player Stats
// section under the same name (own goals prefixed "[OG] ") — deduped here
// via the Set regardless of which section or how many times a name
// reappears, so this naturally counts the full match roster.
function recordMatchForDigest(embedData, room) {
    if (room === 'main') digestState.mainMatches++;
    else digestState.bffMatches++;
    for (const field of embedData?.fields ?? []) {
        for (const m of (field.value ?? '').matchAll(/> \*\*(?:\[OG\] )?(.+?):\*\*/g)) {
            digestState.players.add(m[1]);
        }
    }
}

function postActivityDigest() {
    const { mainMatches, bffMatches, players } = digestState;
    digestState.mainMatches = 0;
    digestState.bffMatches = 0;
    digestState.players = new Set();
    if (mainMatches === 0 && bffMatches === 0) return; // a quiet period doesn't need a report saying so

    const topClubs = db.getTopClubs(1);
    const topClubLine = topClubs.length > 0
        ? `🏆 Топ клуб: [${topClubs[0].emoji ?? ''}${topClubs[0].prefix}] ${topClubs[0].name} (${topClubs[0].score})`
        : '🏆 Топ клуб: пока никто не набрал очков';
    discordBot.sendLog(
        `📊 **Дайджест активности за 24 ч.**\n` +
        `⚽ Матчей: ${mainMatches + bffMatches} (${mainMatches} основная, ${bffMatches} BFF)\n` +
        `👥 Уникальных игроков: ${players.size}\n` +
        `${topClubLine}`
    );
}
const digestIntervalMs = 24 * 60 * 60 * 1000;
setInterval(postActivityDigest, digestIntervalMs);
