const path = require('node:path');
const os = require('node:os');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const HaxballJS = require('haxball.js').default;

HaxballJS({ debug: false }).then((HBInit) => {

/* SHARED MUTABLE STATE */
// Every binding here is reassigned at runtime; extracted modules must reach it
// through this object rather than capturing the value at wiring time.
const state = {};


/* VARIABLES */

const {
    roomName,
    maxPlayers,
    roomPublic,
    roomPassword,
    fetchRecordingVariable,
    timeLimit,
    scoreLimit,
    buildGameConfig,
} = require('./core/config');

const room = HBInit(buildGameConfig());

const {
    Team,
    State,
    Role,
    HaxNotification,
    Situation,
    welcomeColor,
    announcementColor,
    infoColor,
    privateMessageColor,
    redColor,
    blueColor,
    warningColor,
    errorColor,
    successColor,
    defaultColor,
    masterChatColor,
    adminChatColor,
    vipChatColor,
} = require('./core/constants');
const {
    Goal,
    PlayerComposition,
    BallTouch,
    HaxStatistics,
    Game,
    MuteList,
    createMutePlayerClass,
} = require('./core/models');
const {
    getDate,
    getRandomInt,
    pointDistance,
    getHoursStats,
    getMinutesGame,
    getMinutesReport,
    getMinutesEmbed,
    getMinutesStats,
    getSecondsGame,
    getSecondsReport,
    getSecondsEmbed,
    getTimeGame,
    getTimeEmbed,
    getTimeStats,
    findFirstNumberCharString,
    generateRoomPassword,
} = require('./core/utils');
const {
    getIdReport,
    getRecordingName,
    fetchRecording,
} = require('./core/reports');
const createChatHelpers = require('./core/chat');

const { createDatabaseApi } = require('../api/database');
const db = createDatabaseApi();
db.init();

// Runs the Discord bot in its own process (see core/discordProcess.js)
// instead of in-process like the old roomWebhook/gameWebhook replacement
// used to be. Reason: discord.js's gateway traffic, JSON parsing and object
// churn were sharing this event loop with the room's physics tick — any
// stall there (a GC pause, a burst of chat traffic) could delay a tick just
// enough for players to see it as ping lag ("redbars"), while a
// minute-averaged CPU/RAM graph from the host never shows a few hundred ms
// of stolen event-loop time. `serialization: 'advanced'` lets game
// recordings (Uint8Array, from room.stopRecording()) cross the IPC boundary
// via structured clone instead of a lossy/expensive JSON detour. The DB
// backup (VACUUM INTO, see db/sqlite.js) moved there too, for the same
// reason — it also fully blocks whichever event loop runs it.
const { fork } = require('node:child_process');

// Mutable: a dead Discord process gets respawned (see spawnDiscordProcess
// below) rather than left permanently gone, so this always points at
// whichever child is currently live — or null in the brief gap while one is
// restarting.
let discordProcess = null;
let discordRespawnTimer = null;
const DISCORD_RESPAWN_BASE_DELAY_MS = 5000;
const DISCORD_RESPAWN_MAX_DELAY_MS = 5 * 60 * 1000;
// If it stayed up at least this long, the next crash starts the backoff
// over from the base delay instead of continuing to escalate — only a
// tight crash loop (bad token, a bug on every startup path) should ever
// reach the max delay above.
const DISCORD_STABLE_UPTIME_MS = 60 * 1000;
let discordRespawnDelay = DISCORD_RESPAWN_BASE_DELAY_MS;

// room.onRoomLink only fires once, right when the room is first created —
// a respawned Discord process (see spawnDiscordProcess below) would
// otherwise never learn it and leave the status embed's join button
// permanently missing/stale. Cached here so resyncDiscordProcess can
// replay it after a respawn.
let lastRoomLink = null;

// Guards every send: with no live/connected child (mid-respawn, or the
// channel dropped a moment before 'exit' fires), this degrades to "the
// message is dropped" instead of a thrown/queued-forever call.
function sendToDiscord(message) {
    if (discordProcess && discordProcess.connected) discordProcess.send(message);
}

// Replays the state a freshly (re)spawned Discord process would otherwise
// have missed — it only exists from this point forward, but the roster and
// room link were both established earlier, via events that won't fire
// again. Deliberately NOT called after the very first spawnDiscordProcess()
// at module load: state.playersAll/authArray don't exist yet at that point
// (see the AUTH/OBJECTS blocks below), and there is nothing to replay for a
// room that has no players and hasn't linked yet anyway.
function resyncDiscordProcess() {
    sendToDiscord({
        type: 'roster',
        players: state.playersAll.map((p) => ({ id: p.id, name: p.name, auth: authArray[p.id]?.[0] ?? null })),
    });
    if (lastRoomLink) sendToDiscord({ type: 'roomLink', url: lastRoomLink });
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
    // kernel favors the room (physics ticks — i.e. player ping) over
    // Discord traffic whenever both want the CPU at the same instant,
    // rather than splitting it evenly between a real-time game and a chat
    // bot. Best-effort: some platforms/permission setups don't allow this,
    // and that must never take the room down with it.
    if (child.pid) {
        try {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
        } catch (err) {
            console.error('[WARN] Could not lower Discord process OS priority:', err.message);
        }
    }

    // Handles the two things the Discord process can't do on its own:
    // relaying a !say/`/say` message into the room chat, and kicking a
    // currently-connected player by auth for !banauth/`/banauth` (the ban
    // record itself is written directly by that process's own DB
    // connection — see discordProcess.js).
    child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'relay') {
            // room.sendChat() speaks as the host's own player character,
            // which doesn't exist when buildGameConfig() sets noPlayer:
            // true — sendAnnouncement isn't tied to a player at all, which
            // is why every other message already goes through it.
            room.sendAnnouncement(`[DISCORD] ${msg.username}: ${msg.content}`, null, announcementColor, 'bold', HaxNotification.CHAT);
            return;
        }
        if (msg.type === 'kickByAuth') {
            const target = state.playersAll.find((p) => authArray[p.id]?.[0] === msg.auth);
            const result = target ? { name: target.name } : null;
            if (target) room.kickPlayer(target.id, msg.reason ? `Вы забанены: ${msg.reason}` : 'Вы забанены.', false);
            sendToDiscord({ type: 'kickResult', requestId: msg.requestId, result });
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

// Same public shape the old same-process discordBot had, so every call site
// below (sendLog, sendReport, sendRecording, setRoomLink, updateRoomStatus,
// sendPassword) is unchanged — only the implementation now forwards over IPC.
const discordBot = {
    init() {},
    sendLog(content) {
        sendToDiscord({ type: 'log', content });
    },
    sendReport(embedData) {
        sendToDiscord({ type: 'report', embedData });
    },
    sendRecording(buffer, filename) {
        sendToDiscord({ type: 'recording', buffer, filename });
    },
    setRoomLink(url) {
        lastRoomLink = url;
        sendToDiscord({ type: 'roomLink', url });
    },
    sendPassword(password) {
        sendToDiscord({ type: 'password', password });
    },
    // authArray is declared later (in the AUTH block) — reached lazily for
    // the same reason it always was: this must not capture it by value
    // before it exists.
    updateRoomStatus() {
        sendToDiscord({
            type: 'roster',
            players: state.playersAll.map((p) => ({ id: p.id, name: p.name, auth: authArray[p.id]?.[0] ?? null })),
        });
    },
};

process.on('exit', () => {
    clearTimeout(discordRespawnTimer);
    if (discordProcess) discordProcess.kill();
});

// Last-resort safety net: safeEventHandlers (see below) already catches sync
// errors inside every room.onXxx handler so one bad command can't take the
// whole bot down, but anything that slips past that (a bug outside those
// handlers, an unawaited rejected promise) would otherwise kill the process
// silently. There's no way to auto-restart afterwards — the HaxBall token is
// single-use and expires quickly, so a fresh one has to be fetched by hand —
// but at least the crash gets reported instead of the room just vanishing.
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    discordBot.sendLog(`🔴 **КРИТИЧЕСКАЯ ОШИБКА, бот падает:**\n\`\`\`${(err && err.stack) || err}\`\`\``);
    setTimeout(() => process.exit(1), 2000);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
    discordBot.sendLog(`⚠️ **Необработанный reject:**\n\`\`\`${(reason && reason.stack) || reason}\`\`\``);
});

/* EVENT LOOP LAG MONITORING */

// Diagnostic, not a fix: players have kept reporting ping spikes ("redbars")
// even after isolating the Discord process onto its own event loop, and the
// host's own CPU/RAM graphs never show it (coarse averaging hides a
// sub-second stall, and on this single-vCPU host both processes share one
// core regardless of isolation). Rather than keep guessing at the cause,
// this reports whenever the ROOM process's own event loop actually stalls
// meaningfully, so the next report can be checked against real measured
// numbers — what stalled, how long, and when — instead of a hypothesis.
const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();
const EVENT_LOOP_CHECK_INTERVAL_MS = 30000;
const EVENT_LOOP_WARN_THRESHOLD_MS = 150;
setInterval(() => {
    const maxMs = eventLoopMonitor.max / 1e6;
    if (maxMs >= EVENT_LOOP_WARN_THRESHOLD_MS) {
        const meanMs = eventLoopMonitor.mean / 1e6;
        discordBot.sendLog(
            `⚠️ Event loop room-процесса подвисал: макс ${maxMs.toFixed(0)}мс, среднее ${meanMs.toFixed(0)}мс ` +
            `за последние ${EVENT_LOOP_CHECK_INTERVAL_MS / 1000}с — вероятная причина редбаров в этом окне.`
        );
    }
    eventLoopMonitor.reset();
}, EVENT_LOOP_CHECK_INTERVAL_MS);

/* OVERFLOW PASSWORD */

// Reserves the last 2 slots below capacity for people who know the password
// (shared to Discord) rather than anyone who has the room link — see
// core/overflowPassword.js for the activate/rotate/deactivate lifecycle.
const passwordThreshold = maxPlayers - 2;
const createOverflowPassword = require('./core/overflowPassword');
const { checkOverflowPassword } = createOverflowPassword({
    room,
    state,
    maxPlayers,
    passwordThreshold,
    discordBot,
    generateRoomPassword,
    rotateIntervalMs: 60 * 60 * 1000,
});

const { trainingMap, classicMap, bigMap } = require('./core/stadiums');

const {
    getCommand,
    getTeamArray,
    sendAnnouncementTeam,
    teamChat,
    playerChat,
} = createChatHelpers({
    room,
    Team,
    redColor,
    blueColor,
    errorColor,
    privateMessageColor,
    HaxNotification,
    getPlayersAll: () => state.playersAll,
    getTeamRed: () => state.teamRed,
    getTeamBlue: () => state.teamBlue,
    getTeamSpec: () => state.teamSpec,
    getCommands: () => commands,
});

state.currentStadium = 'training';
const bigMapObj = JSON.parse(trainingMap);

room.setScoreLimit(scoreLimit);
room.setTimeLimit(timeLimit);
room.setTeamsLock(true);
room.setKickRateLimit(6, 12, 4);

state.roomPassword = roomPassword;
room.setPassword(state.roomPassword != '' ? state.roomPassword : null);

/* OPTIONS */

const drawTimeLimit = Infinity;
const teamSize = 4;
// Per-stadium score/time limits, applied whenever stadiumCommand switches
// arenas — classic is the small 1v1/2v2 map, big is the 3v3/4v4 map.
const classicScoreLimit = 3;
const classicTimeLimit = 3;
const bigScoreLimit = 5;
const bigTimeLimit = 5;
const disableBans = false;
const debugMode = false;
const afkLimit = debugMode ? Infinity : 15;

const defaultSlowMode = 0.5;
const chooseModeSlowMode = 1;
state.slowMode = defaultSlowMode;
const SMSet = new Set();

const mentionPlayersUnpause = true;

/* OBJECTS */

state.gameState = State.STOP;
state.playSituation = Situation.STOP;
state.goldenGoal = false;

state.playersAll = [];
state.players = [];
state.teamRed = [];
state.teamBlue = [];
state.teamSpec = [];

state.teamRedStats = [];
state.teamBlueStats = [];

state.banList = [];

/* STATS */

state.possession = [0, 0];
state.actionZoneHalf = [0, 0];
state.lastWinner = Team.SPECTATORS;
state.streak = 0;

/* AUTH */

const authArray = [];
// Masters and permanent admins are configured in the database (see
// scripts/add-master.js) rather than granted at runtime by any bot command.
state.adminList = db.getAdmins().map((a) => [a.auth, a.playerName]);
state.vipList = db.getVips().map((v) => [v.auth, v.playerName]);
const masterList = db.getMasters();

/* GAME */

state.lastTouches = Array(2).fill(null);
state.lastTeamTouched = undefined;

state.speedCoefficient = 100 / (5 * (0.99 ** 60 + 1));
state.ballSpeed = 0;
state.playerRadius = 15;
state.ballRadius = 10;
state.triggerDistance = state.playerRadius + state.ballRadius + 0.01;

/* AUXILIARY */

state.checkTimeVariable = false;
state.checkStadiumVariable = true;
state.endGameVariable = false;
state.cancelGameVariable = false;
state.kickFetchVariable = false;

state.chooseMode = false;
state.timeOutCap = undefined;
state.capLeft = false;
state.redCaptainChoice = '';
state.blueCaptainChoice = '';
const chooseTime = 20;

const AFKSet = new Set();
const AFKMinSet = new Set();
const AFKCooldownSet = new Set();
const minAFKDuration = 0;
const maxAFKDuration = 30;
const AFKCooldown = 0;

const muteArray = new MuteList();
const muteDuration = 5;
const MutePlayer = createMutePlayerClass({ room, announcementColor, HaxNotification, muteArray });

state.removingPlayers = false;
state.insertingPlayers = false;

state.stopTimeout = undefined;
state.startTimeout = undefined;
state.unpauseTimeout = undefined;
state.removingTimeout = undefined;
state.insertingTimeout = undefined;

const emptyPlayer = {
    id: 0,
};

/* FUNCTIONS */

/* AUXILIARY FUNCTIONS */

function getGoalGame() {
    return state.game.scores.red + state.game.scores.blue;
}

/* REPORT FUNCTIONS */

/* FEATURE FUNCTIONS */

function getPlayerComp(player) {
    if (player == null || player.id == 0) return null;
    const comp = state.game.playerComp;
    let index = comp[0].findIndex((c) => c.auth == authArray[player.id][0]);
    if (index != -1) return comp[0][index];
    index = comp[1].findIndex((c) => c.auth == authArray[player.id][0]);
    if (index != -1) return comp[1][index];
    return null;
}

/* PHYSICS FUNCTIONS */

function calculateStadiumVariables() {
    if (state.checkStadiumVariable && state.teamRed.length + state.teamBlue.length > 0) {
        state.checkStadiumVariable = false;
        setTimeout(() => {
            let ballDisc = room.getDiscProperties(0);
            let playerDisc = room.getPlayerDiscProperties(state.teamRed.concat(state.teamBlue)[0].id);
            state.ballRadius = ballDisc.radius;
            state.playerRadius = playerDisc.radius;
            state.triggerDistance = state.ballRadius + state.playerRadius + 0.01;
            state.speedCoefficient = 100 / (5 * ballDisc.invMass * (ballDisc.damping ** 60 + 1));
        }, 1);
    }
}

function checkGoalKickTouch(array, index, goal) {
    if (array != null && array.length >= index + 1) {
        const obj = array[index];
        if (obj != null && obj.goal != null && obj.goal == goal) return obj;
    }
    return null;
}

/* BUTTONS */

const createButtonHelpers = require('./core/team/buttons');
const {
    topButton,
    randomButton,
    blueToSpecButton,
    redToSpecButton,
    resetButton,
    swapButton,
} = createButtonHelpers({
    room,
    state,
    Team,
    getRandomInt,
});

/* COMMAND FUNCTIONS */

/* ADMIN COMMANDS */

const createAdminCommands = require('./core/commands/admin');
const {
    restartCommand,
    restartSwapCommand,
    swapCommand,
    kickTeamCommand,
    stadiumCommand,
    muteCommand,
    unmuteCommand,
    muteListCommand,
} = createAdminCommands({
    room,
    state,
    authArray,
    muteArray,
    muteDuration,
    MutePlayer,
    trainingMap,
    classicMap,
    bigMap,
    classicScoreLimit,
    classicTimeLimit,
    bigScoreLimit,
    bigTimeLimit,
    State,
    Situation,
    announcementColor,
    errorColor,
    HaxNotification,
    instantRestart,
    swapButton,
});

/* MASTER COMMANDS */

const createMasterCommands = require('./core/commands/master');
const {
    clearbansCommand,
    banListCommand,
    adminListCommand,
    setAdminCommand,
    removeAdminCommand,
    setVipCommand,
    removeVipCommand,
    vipListCommand,
    banAuthCommand,
    unbanAuthCommand,
    authBanListCommand,
    playersListCommand,
    passwordCommand,
} = createMasterCommands({
    room,
    state,
    authArray,
    db,
    masterList,
    announcementColor,
    errorColor,
    HaxNotification,
});

/* GAME FUNCTIONS */

function checkTime() {
    const scores = room.getScores();
    if (state.game != undefined) state.game.scores = scores;
    if (Math.abs(scores.time - scores.timeLimit) <= 0.01 && scores.timeLimit != 0 && state.playSituation == Situation.PLAY) {
        if (scores.red != scores.blue) {
            if (!state.checkTimeVariable) {
                state.checkTimeVariable = true;
                setTimeout(() => {
                    state.checkTimeVariable = false;
                }, 3000);
                scores.red > scores.blue ? endGame(Team.RED) : endGame(Team.BLUE);
                state.stopTimeout = setTimeout(() => {
                    room.stopGame();
                }, 2000);
            }
            return;
        }
        if (drawTimeLimit != 0) {
            state.goldenGoal = true;
            room.sendAnnouncement(
                '⚽ Решающий гол !',
                null,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
        }
    }
    if (Math.abs(scores.time - drawTimeLimit * 60 - scores.timeLimit) <= 0.01 && scores.timeLimit != 0) {
        if (!state.checkTimeVariable) {
            state.checkTimeVariable = true;
            setTimeout(() => {
                state.checkTimeVariable = false;
            }, 10);
            endGame(Team.SPECTATORS);
            room.stopGame();
            state.goldenGoal = false;
        }
    }
}

function instantRestart() {
    room.stopGame();
    state.startTimeout = setTimeout(() => {
        room.startGame();
    }, 10);
}

function resumeGame() {
    state.startTimeout = setTimeout(() => {
        room.startGame();
    }, 1000);
    setTimeout(() => {
        room.pauseGame(false);
    }, 500);
}

function endGame(winner) {
    // Captain-choosing mode is reserved for a genuine full house (enough for
    // 4v4) — with fewer players, people should just keep playing whatever
    // smaller size they naturally have (2v2, 3v3) without the pick ritual.
    if (state.players.length >= 2 * teamSize) activateChooseMode();
    const scores = room.getScores();
    state.game.scores = scores;
    state.lastWinner = winner;
    state.endGameVariable = true;
    if (winner == Team.RED) {
        state.streak++;
        room.sendAnnouncement(
            `✨ Красная команда выиграла ${scores.red} - ${scores.blue} ! Текущая серия: ${state.streak}`,
            null,
            redColor,
            'bold',
            HaxNotification.CHAT
        );
    } else if (winner == Team.BLUE) {
        state.streak = 1;
        room.sendAnnouncement(
            `✨ Синяя команда выиграла ${scores.blue} - ${scores.red} ! Текущая серия: ${state.streak}`,
            null,
            blueColor,
            'bold',
            HaxNotification.CHAT
        );
    } else {
        state.streak = 0;
        room.sendAnnouncement(
            '💤 Лимит ничьих достигнут !',
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }
    let possessionRedPct = (state.possession[0] / (state.possession[0] + state.possession[1])) * 100;
    let possessionBluePct = 100 - possessionRedPct;
    let possessionString = `🔴 ${possessionRedPct.toFixed(0)}% - ${possessionBluePct.toFixed(0)}% 🔵`;
    let actionRedPct = (state.actionZoneHalf[0] / (state.actionZoneHalf[0] + state.actionZoneHalf[1])) * 100;
    let actionBluePct = 100 - actionRedPct;
    let actionString = `🔴 ${actionRedPct.toFixed(0)}% - ${actionBluePct.toFixed(0)}% 🔵`;
    let CSString = getCSString(scores);
    room.sendAnnouncement(
        `📊 Владение: 🔴 ${possessionString}\n` +
        `📊 Зоны действия: 🔴 ${actionString}\n` +
        `${CSString}`,
        null,
        announcementColor,
        'bold',
        HaxNotification.NONE
    );
    updateStats();
}

/* CHOOSING FUNCTIONS */

const createChoosingHelpers = require('./core/team/choosing');
const {
    activateChooseMode,
    deactivateChooseMode,
    getSpecList,
    choosePlayer,
    chooseModeFunction,
    checkCaptainLeave,
    slowModeFunction,
} = createChoosingHelpers({
    room,
    state,
    Team,
    HaxNotification,
    announcementColor,
    errorColor,
    infoColor,
    warningColor,
    chooseModeSlowMode,
    chooseTime,
    defaultSlowMode,
    SMSet,
    getRandomInt,
});

/* PLAYER FUNCTIONS */

function updateTeams() {
    state.playersAll = room.getPlayerList();
    state.players = state.playersAll.filter((p) => !AFKSet.has(p.id));
    state.teamRed = state.players.filter((p) => p.team == Team.RED);
    state.teamBlue = state.players.filter((p) => p.team == Team.BLUE);
    state.teamSpec = state.players.filter((p) => p.team == Team.SPECTATORS);
}

// Hierarchical, not additive: each tier is checked in descending order of
// privilege, so e.g. a permanent admin who also happens to be in vipList
// still reads as ADMIN_PERM (higher tiers imply every permission of the
// tiers below them — VIP-only commands stay usable by admins/masters too,
// since command gating is `commands[command].roles <= getRole(player)`).
function getRole(player) {
    const auth = authArray[player.id][0];
    if (masterList.includes(auth)) return Role.MASTER;
    if (state.adminList.some((a) => a[0] == auth)) return Role.ADMIN_PERM;
    if (player.admin) return Role.ADMIN_TEMP;
    if (state.vipList.some((v) => v[0] == auth)) return Role.VIP;
    return Role.PLAYER;
}

function ghostKickHandle(oldP, newP) {
    const teamArrayId = getTeamArray(oldP.team, true).map((p) => p.id);
    teamArrayId.splice(teamArrayId.findIndex((id) => id == oldP.id), 1, newP.id);

    room.kickPlayer(oldP.id, 'Дубликат', false);
    room.setPlayerTeam(newP.id, oldP.team);
    room.setPlayerAdmin(newP.id, oldP.admin);
    room.reorderPlayers(teamArrayId, true);

    if (oldP.team != Team.SPECTATORS && state.playSituation != Situation.STOP) {
        const discProp = room.getPlayerDiscProperties(oldP.id);
        room.setPlayerDiscProperties(newP.id, discProp);
    }
}

/* ACTIVITY FUNCTIONS */

function handleActivityPlayer(player) {
    let pComp = getPlayerComp(player);
    if (pComp != null) {
        pComp.inactivityTicks++;
        if (pComp.inactivityTicks == 60 * ((2 / 3) * afkLimit)) {
            room.sendAnnouncement(
                `⛔ ${player.name}, если вы не активны, вы будете кикнуты через ${afkLimit / 3} секунд.`,
                player.id,
                warningColor,
                'bold',
                HaxNotification.MENTION
            );
            return;
        }
        if (pComp.inactivityTicks >= 60 * afkLimit) {
            pComp.inactivityTicks = 0;
            if (state.game.scores.time <= afkLimit - 0.5) {
                setTimeout(() => {
                    !state.chooseMode ? instantRestart() : room.stopGame();
                }, 10);
            }
            room.kickPlayer(player.id, 'AFK', false);
        }
    }
}

function handleActivityPlayerTeamChange(changedPlayer) {
    if (changedPlayer.team == Team.SPECTATORS) {
        let pComp = getPlayerComp(changedPlayer);
        if (pComp != null) pComp.inactivityTicks = 0;
    }
}

function handleActivityStop() {
    for (let player of state.players) {
        let pComp = getPlayerComp(player);
        if (pComp != null) pComp.inactivityTicks = 0;
    }
}

function handleActivity() {
    if (state.gameState === State.PLAY && state.players.length > 1) {
        for (let player of state.teamRed) {
            handleActivityPlayer(player);
        }
        for (let player of state.teamBlue) {
            handleActivityPlayer(player);
        }
    }
}

/* LINEUP FUNCTIONS */

const createLineupHelpers = require('./core/team/lineup');
const {
    getStartingLineups,
    handleLineupChangeTeamChange,
    handleLineupChangeLeave,
} = createLineupHelpers({
    state,
    Team,
    State,
    Situation,
    PlayerComposition,
    authArray,
});

/* STATS FUNCTIONS */

// Wired here, before TEAM BALANCE FUNCTIONS/PLAYER COMMANDS: playerStats must
// come before roomStats/fetch (they consume its exports), and roomStats/print
// must exist before PLAYER COMMANDS (printRankings/printPlayerStats).

/* GK FUNCTIONS */

const createGkHelpers = require('./core/stats/gk');
const {
    handleGKTeam,
    handleGK,
    getGK,
    getCS,
    getCSString,
} = createGkHelpers({
    state,
    Team,
    getPlayerComp,
});

/* GLOBAL STATS FUNCTIONS */

const createGlobalStats = require('./core/stats/global');
const {
    getLastTouchOfTheBall,
    getBallSpeed,
    getGameStats,
} = createGlobalStats({
    room,
    state,
    Team,
    State,
    Situation,
    BallTouch,
    checkGoalKickTouch,
    getGoalGame,
    handleGK,
    pointDistance,
    updateTeams,
});

/* GOAL ATTRIBUTION FUNCTIONS */

const createGoalAttribution = require('./core/stats/goalAttribution');
const {
    getGoalAttribution,
    getGoalString,
} = createGoalAttribution({
    state,
    Team,
    Goal,
    getTimeGame,
});

/* GET STATS FUNCTIONS */

const createPlayerStats = require('./core/stats/playerStats');
const {
    getGamePlayerStats,
    getGametimePlayer,
    getGoalsPlayer,
    getOwnGoalsPlayer,
    getAssistsPlayer,
    getGKPlayer,
    getCSPlayer,
    actionReportCountTeam,
} = createPlayerStats({
    state,
    Team,
    authArray,
    HaxStatistics,
    getGK,
    getPlayerComp,
});

/* ROOM STATS FUNCTIONS */

const createRoomStats = require('./core/stats/roomStats');
const {
    updatePlayerStats,
    updateStats,
    printRankings,
} = createRoomStats({
    room,
    state,
    Team,
    authArray,
    db,
    HaxStatistics,
    HaxNotification,
    errorColor,
    infoColor,
    teamSize,
    getAssistsPlayer,
    getCSPlayer,
    getGametimePlayer,
    getGoalsPlayer,
    getOwnGoalsPlayer,
    getPlayerComp,
    getTimeStats,
});

/* PRINT FUNCTIONS */

const createPrintStats = require('./core/stats/print');
const {
    printPlayerStats,
} = createPrintStats({
    getTimeStats,
});

/* FETCH FUNCTIONS */

const createFetchReports = require('./core/stats/fetch');
const {
    fetchGametimeReport,
    fetchActionsSummaryReport,
    fetchSummaryEmbed,
} = createFetchReports({
    Team,
    state,
    discordBot,
    roomName,
    findFirstNumberCharString,
    actionReportCountTeam,
    getGametimePlayer,
    getIdReport,
    getMinutesReport,
    getRecordingName,
    getSecondsReport,
    getTimeEmbed,
});

/* TEAM BALANCE FUNCTIONS */

const createTeamBalance = require('./core/team/balance');
const {
    balanceTeams,
    handlePlayersJoin,
    handlePlayersLeave,
    handlePlayersTeamChange,
    handlePlayersStop,
} = createTeamBalance({
    room,
    state,
    Team,
    State,
    HaxNotification,
    emptyPlayer,
    infoColor,
    scoreLimit,
    teamSize,
    timeLimit,
    activateChooseMode,
    blueToSpecButton,
    choosePlayer,
    deactivateChooseMode,
    endGame,
    getRandomInt,
    getSpecList,
    instantRestart,
    randomButton,
    redToSpecButton,
    resetButton,
    resumeGame,
    stadiumCommand,
    swapButton,
    topButton,
});

/* PLAYER COMMANDS */

// Wired after TEAM BALANCE FUNCTIONS: afkCommand calls handlePlayersJoin/
// handlePlayersLeave, which only exist once that factory has run.
const createPlayerCommands = require('./core/commands/player');
const {
    leaveCommand,
    helpCommand,
    globalStatsCommand,
    renameCommand,
    linkDiscordCommand,
    statsLeaderboardCommand,
    afkCommand,
    afkListCommand,
} = createPlayerCommands({
    room,
    state,
    Team,
    Role,
    HaxStatistics,
    authArray,
    db,
    AFKSet,
    AFKMinSet,
    AFKCooldownSet,
    minAFKDuration,
    maxAFKDuration,
    AFKCooldown,
    announcementColor,
    errorColor,
    infoColor,
    successColor,
    HaxNotification,
    getCommand,
    getRole,
    handlePlayersJoin,
    handlePlayersLeave,
    printPlayerStats,
    printRankings,
    updateTeams,
    getCommands: () => commands,
});

/* COMMANDS */

// Built last: the command table refers to the handlers above, and helpCommand
// reads this table back through a lazy accessor.
const createCommands = require('./core/commands');

const commands = createCommands({
    Role,
    muteDuration,
    leaveCommand,
    helpCommand,
    globalStatsCommand,
    renameCommand,
    linkDiscordCommand,
    statsLeaderboardCommand,
    afkCommand,
    afkListCommand,
    restartCommand,
    restartSwapCommand,
    swapCommand,
    kickTeamCommand,
    stadiumCommand,
    muteCommand,
    unmuteCommand,
    muteListCommand,
    clearbansCommand,
    banListCommand,
    adminListCommand,
    setAdminCommand,
    removeAdminCommand,
    setVipCommand,
    removeVipCommand,
    vipListCommand,
    banAuthCommand,
    unbanAuthCommand,
    authBanListCommand,
    playersListCommand,
    passwordCommand,
});

stadiumCommand(emptyPlayer, "!training");

state.game = new Game(room, getStartingLineups);

/* EVENTS */

// room.onXxx handlers are wrapped so a bug in any one of them can't crash the
// whole process and end the game for every player.
const wrapEventHandlers = require('./core/safeEventHandlers');

/* PLAYER MOVEMENT */

const createMovementEvents = require('./core/events/movement');
Object.assign(room, wrapEventHandlers(createMovementEvents({
    room,
    state,
    authArray,
    db,
    AFKSet,
    HaxNotification,
    Role,
    State,
    Team,
    announcementColor,
    debugMode,
    disableBans,
    discordBot,
    errorColor,
    infoColor,
    masterList,
    maxPlayers,
    welcomeColor,
    getDate,
    checkCaptainLeave,
    checkOverflowPassword,
    getRole,
    ghostKickHandle,
    handleActivityPlayerTeamChange,
    handleLineupChangeLeave,
    handleLineupChangeTeamChange,
    handlePlayersJoin,
    handlePlayersLeave,
    handlePlayersTeamChange,
    updateTeams,
})));

/* PLAYER ACTIVITY */

const createActivityEvents = require('./core/events/activity');
Object.assign(room, wrapEventHandlers(createActivityEvents({
    room,
    state,
    authArray,
    BallTouch,
    HaxNotification,
    Role,
    Situation,
    State,
    Team,
    adminChatColor,
    commands,
    discordBot,
    errorColor,
    masterChatColor,
    muteArray,
    vipChatColor,
    checkGoalKickTouch,
    chooseModeFunction,
    getCommand,
    getDate,
    getGoalGame,
    getPlayerComp,
    getRole,
    playerChat,
    slowModeFunction,
    teamChat,
})));

/* GAME MANAGEMENT */

const createGameManagementEvents = require('./core/events/gameManagement');
Object.assign(room, wrapEventHandlers(createGameManagementEvents({
    room,
    state,
    Game,
    HaxNotification,
    Situation,
    State,
    Team,
    blueColor,
    defaultColor,
    discordBot,
    fetchRecordingVariable,
    getStartingLineups,
    mentionPlayersUnpause,
    redColor,
    teamSize,
    calculateStadiumVariables,
    deactivateChooseMode,
    endGame,
    fetchRecording,
    fetchSummaryEmbed,
    getBallSpeed,
    getDate,
    getGoalString,
    getPlayerComp,
    handleActivityStop,
    handlePlayersStop,
    updateTeams,
})));

/* MISCELLANEOUS */

const createMiscEvents = require('./core/events/misc');
Object.assign(room, wrapEventHandlers(createMiscEvents({
    room,
    state,
    HaxNotification,
    Role,
    discordBot,
    emptyPlayer,
    errorColor,
    infoColor,
    checkTime,
    getDate,
    getGameStats,
    getLastTouchOfTheBall,
    getRole,
    handleActivity,
    stadiumCommand,
    updateTeams,
})));
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
