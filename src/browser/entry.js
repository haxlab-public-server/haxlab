/*
 * In-page entry point — bundled by esbuild (see tools/build-bundle.js) and
 * injected into the real HaxBall room page by the Node orchestrator (see
 * src/index.js) via Puppeteer. Runs in the SAME JS realm as the real `room`
 * object HBInit() creates, so every room.* call below is a plain, synchronous
 * call — no bridging needed for any of it, exactly like the reference
 * monolith at ../../haxball_bot_headless/HaxBot_public.js.
 *
 * Only two things actually cross the page<->orchestrator process boundary,
 * because only they need real Node capabilities a browser doesn't have:
 * the sqlite DB (see dbBridgeClient.js) and the Discord bot, itself already
 * a separate child process before this migration (see discordBridgeClient.js).
 * `db` and `discordBot` below have the exact same method names/shapes the
 * old direct/IPC-shim versions had, so every src/core/* factory is wired
 * exactly as it always was — only `db.*` calls actually became async (the
 * discordBot ones were already fire-and-forget everywhere, unaffected).
 *
 * HBInit is a global the page itself provides once its own scripts have
 * loaded — never required/imported here, matching every classic HaxBall
 * headless bot (including this project's own reference monolith).
 */
const { createBridgedDb } = require('./dbBridgeClient');
const { createBridgedDiscordBot } = require('./discordBridgeClient');

const {
    roomName,
    maxPlayers,
    fetchRecordingVariable,
    timeLimit,
    scoreLimit,
    buildGameConfig,
} = require('../core/roomConstants');

async function main() {

/* SHARED MUTABLE STATE */
// Every binding here is reassigned at runtime; extracted modules must reach it
// through this object rather than capturing the value at wiring time.
const state = {};

// Declared this early (rather than in the AUTH block further down, where the
// pre-migration index.js had it) so createBridgedDiscordBot below — which
// takes it as a constructor parameter, not a lazily-read closure — doesn't
// hit a temporal-dead-zone error. Safe to move: nothing reads it before
// onPlayerJoin ever populates it either way.
const authArray = [];

// window.__secrets is set by the orchestrator (src/index.js) via
// page.evaluate() right after navigation, before this bundle is injected —
// carries the two things that come from process.env on the orchestrator
// side (HAXBALL_TOKEN, ROOM_PASSWORD) and therefore can't live in
// roomConstants.js, which has to stay safe to bundle into a context with no
// `process` at all.
const room = HBInit(buildGameConfig(window.__secrets.token));

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
} = require('../core/constants');
const {
    Goal,
    PlayerComposition,
    BallTouch,
    HaxStatistics,
    Game,
    MuteList,
    createMutePlayerClass,
} = require('../core/models');
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
    formatBanRemaining,
    formatCoins,
} = require('../core/utils');
const {
    getIdReport,
    getRecordingName,
    fetchRecording,
} = require('../core/reports');
const createChatHelpers = require('../core/chat');

const db = createBridgedDb();
const discordBot = createBridgedDiscordBot({ state, authArray });

/* ROOM BRIDGE */
// The other direction: the orchestrator relays two message types from the
// Discord process ('relay' for !say/`/say`, 'kickByAuth' for !banauth/
// `/banauth`) that used to touch `room`/`state` directly since they all
// lived in the same process. Now the orchestrator has no direct access to
// either, so it reaches them via page.evaluate() calling these instead —
// same logic, same result shape (kickByAuth's return value resolves the
// Discord-side promise exactly like it always did).
window.__roomBridge = {
    relayToRoom(username, content) {
        // room.sendChat() speaks as the host's own player character, which
        // doesn't exist when buildGameConfig() sets noPlayer: true —
        // sendAnnouncement isn't tied to a player at all, which is why every
        // other message already goes through it.
        room.sendAnnouncement(`[DISCORD] ${username}: ${content}`, null, announcementColor, 'bold', HaxNotification.CHAT);
    },
    kickByAuth(auth, reason) {
        const target = state.playersAll.find((p) => authArray[p.id]?.[0] === auth);
        if (!target) return null;
        room.kickPlayer(target.id, reason ? `Вы забанены: ${reason}` : 'Вы забанены.', false);
        return { name: target.name };
    },
    // Lets the orchestrator rebuild the roster/roomLink it no longer holds
    // directly, to replay to a freshly (re)spawned Discord process — see
    // resyncDiscordProcess() in src/index.js.
    getRoster() {
        return state.playersAll.map((p) => ({ id: p.id, name: p.name, auth: authArray[p.id]?.[0] ?? null }));
    },
};

// Last-resort safety net: safeEventHandlers (see below) already catches sync
// AND async errors inside every room.onXxx handler so one bad command can't
// take the whole page down, but anything that slips past that would
// otherwise fail silently in a browser context (no process to crash, no
// console anyone's watching). Browser equivalent of the old
// uncaughtException/unhandledRejection handlers — there's no process.exit()
// analog here; the room's own native networking isn't touched by a bug in
// this bundle, so this just reports instead of trying to force a restart.
window.addEventListener('error', (event) => {
    console.error('[FATAL] Uncaught exception:', event.error);
    discordBot.sendLog(`🔴 **Необработанная ошибка в комнате:**\n\`\`\`${(event.error && event.error.stack) || event.message}\`\`\``);
});
window.addEventListener('unhandledrejection', (event) => {
    console.error('[FATAL] Unhandled rejection:', event.reason);
    discordBot.sendLog(`⚠️ **Необработанный reject:**\n\`\`\`${(event.reason && event.reason.stack) || event.reason}\`\`\``);
});

/* TICK JITTER MONITORING */

// Browser-side equivalent of the Node orchestrator's old
// perf_hooks.monitorEventLoopDelay() diagnostic — moved here because the
// actual room tick logic now runs on THIS thread, not the orchestrator's.
// Same shape: sample this thread's responsiveness on a steady timer,
// report p50/p95/p99/max over a rolling window whenever the max crosses a
// low threshold, via the same discordBot bridge.
const TICK_SAMPLE_INTERVAL_MS = 20;
const TICK_CHECK_INTERVAL_MS = 30000;
const TICK_WARN_THRESHOLD_MS = 30;
let lastSampleAt = performance.now();
let tickDeltas = [];
setInterval(() => {
    const now = performance.now();
    tickDeltas.push(now - lastSampleAt);
    lastSampleAt = now;
}, TICK_SAMPLE_INTERVAL_MS);

function percentileOf(sortedDeltas, p) {
    const idx = Math.min(sortedDeltas.length - 1, Math.floor((p / 100) * sortedDeltas.length));
    return sortedDeltas[idx];
}

setInterval(() => {
    const maxMs = tickDeltas.length ? Math.max(...tickDeltas) : 0;
    if (maxMs >= TICK_WARN_THRESHOLD_MS) {
        const sorted = [...tickDeltas].sort((a, b) => a - b);
        const p50Ms = percentileOf(sorted, 50);
        const p95Ms = percentileOf(sorted, 95);
        const p99Ms = percentileOf(sorted, 99);
        discordBot.sendLog(
            `⚠️ Вкладка комнаты подтормаживала (может ощущаться как подёргивание персонажа/мяча, ` +
            `даже без редбаров и с ровным пингом): p50 ${p50Ms.toFixed(1)}мс, p95 ${p95Ms.toFixed(1)}мс, ` +
            `p99 ${p99Ms.toFixed(1)}мс, макс ${maxMs.toFixed(1)}мс за последние ${TICK_CHECK_INTERVAL_MS / 1000}с.`
        );
    }
    tickDeltas = [];
}, TICK_CHECK_INTERVAL_MS);

/* OVERFLOW PASSWORD */

// Reserves the last 2 slots below capacity for people who know the password
// (shared to Discord) rather than anyone who has the room link — see
// core/overflowPassword.js for the activate/rotate/deactivate lifecycle.
const passwordThreshold = maxPlayers - 2;
const createOverflowPassword = require('../core/overflowPassword');
// Read once at startup, before the room can have refilled past the
// threshold — lets a restart reuse whatever password was last posted to
// Discord (if it hasn't hit its hourly rotation yet) instead of silently
// invalidating it. See overflowPassword.js's docblock for the full story.
const persistedPassword = await db.getSetting('overflowPasswordValue');
const persistedPasswordSetAt = Number(await db.getSetting('overflowPasswordSetAt')) || 0;
const { checkOverflowPassword } = createOverflowPassword({
    room,
    state,
    maxPlayers,
    passwordThreshold,
    discordBot,
    generateRoomPassword,
    rotateIntervalMs: 60 * 60 * 1000,
    db,
    initialPassword: persistedPassword,
    initialPasswordSetAt: persistedPasswordSetAt,
});

/* ECONOMY */

// Coins for wins/losses/playtime, spent in !shop on cosmetics (forms +
// goal animations) worn via !equip — see core/economy.js and
// core/shopItems.js (the editable catalog).
const shopItems = require('../core/shopItems');
const createEconomy = require('../core/economy');
const {
    awardMatchCoins,
    tickPlaytime,
    applyTeamForms,
    announceTeamForms,
    playGoalAnimation,
    playGoalSizeEffect,
    shopCommand,
    inventoryCommand,
    equipCommand,
    unequipCommand,
    addCoinsCommand,
    balanceCommand,
} = createEconomy({
    room,
    state,
    authArray,
    db,
    items: shopItems,
    Team,
    State,
    HaxNotification,
    announcementColor,
    errorColor,
    formatCoins,
    getRandomInt,
});

const PLAYTIME_TICK_INTERVAL_SECONDS = 60;
setInterval(() => tickPlaytime(PLAYTIME_TICK_INTERVAL_SECONDS), PLAYTIME_TICK_INTERVAL_SECONDS * 1000);

/* ANNOUNCEMENTS */

// Broadcasts core/announcementMessages.js's list to the room chat, one at a
// time, in order, every 3 minutes — edit that file's array to change what
// gets said, no logic changes needed.
const createAnnouncements = require('../core/announcements');
const announcementMessages = require('../core/announcementMessages');
createAnnouncements({
    room,
    messages: announcementMessages,
    announcementColor,
    HaxNotification,
    intervalMs: 3 * 60 * 1000,
}).start();

const { trainingMap, classicMap, bigMap } = require('../core/stadiums');

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

state.roomPassword = window.__secrets.roomPassword;
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

// Masters and permanent admins are configured in the database (see
// scripts/add-master.js) rather than granted at runtime by any bot command.
state.adminList = (await db.getAdmins()).map((a) => [a.auth, a.playerName]);
state.vipList = (await db.getVips()).map((v) => [v.auth, v.playerName]);
const masterList = await db.getMasters();

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

// !hide toggle (admins/master only) — suppresses the room admin badge and
// the chat prefix without touching adminList/masterList, so the underlying
// role/permissions never change, only the visible indicators. Keyed by
// player.id like AFKSet above (a per-session toggle, not a persisted
// preference — reconnecting resets it, same as AFK does).
const hiddenAdminsSet = new Set();

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

const createButtonHelpers = require('../core/team/buttons');
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

const createAdminCommands = require('../core/commands/admin');
const {
    restartCommand,
    restartSwapCommand,
    swapCommand,
    kickTeamCommand,
    stadiumCommand,
    muteCommand,
    unmuteCommand,
    muteListCommand,
    hideCommand,
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
    hiddenAdminsSet,
    instantRestart,
    swapButton,
});

/* MASTER COMMANDS */

const createMasterCommands = require('../core/commands/master');
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
    formatBanRemaining,
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

// async since it calls updateStats() (roomStats.js), which touches the DB
// bridge — every call site here still calls endGame(...) fire-and-forget,
// same as before the migration (none of them depended on its completion),
// so the try/catch below ensures this never produces an unhandled
// rejection no matter how it's called: a failed save gets logged/reported
// instead of the game continuing unaware.
async function endGame(winner) {
    // Bug (reported live): used to defensively activateChooseMode() here on
    // every win with a full-or-bigger house, before it's known whether
    // there's actually anyone to pick — handlePlayersStop's own chooseMode
    // branches ALWAYS immediately deactivated it again anyway (nothing to
    // hand-pick right at match end; see its own comments), so this only
    // ever produced a confusing "🐢 Время капитанов..." flicker on/off
    // around every full-house finish. Worse: room.stopGame() (which is what
    // actually runs handlePlayersStop's rebuild) fires on a SEPARATE,
    // deferred timer 1-2s after endGame() (see onTeamGoal/checkTime's own
    // stopTimeout) — during that gap, chooseMode sat transiently TRUE with
    // nothing benched/refilled yet, so any join/leave/afk landing in that
    // window could trip balanceTeams()'s "chooseMode stuck below a full
    // house" self-heal, which calls resumeGame() (meant for resuming a
    // mid-match PAUSED pick session, not starting a fresh post-match round)
    // — racing handlePlayersStop's own later, correct bench+refill+start
    // sequence and potentially starting the next round with the losing
    // side still sitting in spectators. activateChooseMode() is still
    // called for a genuine post-match surplus (WinStay bench leaves more
    // waiting spectators than the benched side needs) — but only from
    // INSIDE handlePlayersStop itself, once it's actually counted a real
    // surplus to hand off to a captain, not defensively here before that's
    // known. It's also called from balanceTeams()'s ordinary-growth branch
    // for a full house reached via joins DURING an ongoing match.
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
    try {
        await updateStats();
    } catch (err) {
        console.error('[endGame] updateStats failed:', err);
        discordBot.sendLog(`⚠️ Не удалось сохранить статистику: ${err.message}`);
    }
    // Unlike updateStats() (quals-only, full house required — see
    // roomStats.js), coins are paid out for every match regardless of team
    // size, so this runs independent of that gate.
    try {
        await awardMatchCoins(winner);
    } catch (err) {
        console.error('[endGame] awardMatchCoins failed:', err);
        discordBot.sendLog(`⚠️ Не удалось начислить монеты: ${err.message}`);
    }
}

/* CHOOSING FUNCTIONS */

const createChoosingHelpers = require('../core/team/choosing');
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

const createLineupHelpers = require('../core/team/lineup');
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

const createGkHelpers = require('../core/stats/gk');
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

const createGlobalStats = require('../core/stats/global');
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

const createGoalAttribution = require('../core/stats/goalAttribution');
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

const createPlayerStats = require('../core/stats/playerStats');
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

const createRoomStats = require('../core/stats/roomStats');
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

const createPrintStats = require('../core/stats/print');
const {
    printPlayerStats,
} = createPrintStats({
    getTimeStats,
});

/* FETCH FUNCTIONS */

const createFetchReports = require('../core/stats/fetch');
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

const createTeamBalance = require('../core/team/balance');
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
const createPlayerCommands = require('../core/commands/player');
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
const createCommands = require('../core/commands');

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
    hideCommand,
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
    teamChat,
    shopCommand,
    inventoryCommand,
    equipCommand,
    unequipCommand,
    addCoinsCommand,
    balanceCommand,
});

stadiumCommand(emptyPlayer, "!training");

state.game = new Game(room, getStartingLineups);

/* EVENTS */

// room.onXxx handlers are wrapped so a bug in any one of them can't crash the
// whole process and end the game for every player.
const wrapEventHandlers = require('../core/safeEventHandlers');

/* PLAYER MOVEMENT */

const createMovementEvents = require('../core/events/movement');
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
    applyTeamForms,
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

const createActivityEvents = require('../core/events/activity');
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
    hiddenAdminsSet,
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

const createGameManagementEvents = require('../core/events/gameManagement');
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
    announceTeamForms,
    balanceTeams,
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
    playGoalAnimation,
    playGoalSizeEffect,
    updateTeams,
})));

/* MISCELLANEOUS */

const createMiscEvents = require('../core/events/misc');
Object.assign(room, wrapEventHandlers(createMiscEvents({
    room,
    state,
    HaxNotification,
    Role,
    discordBot,
    emptyPlayer,
    errorColor,
    infoColor,
    hiddenAdminsSet,
    checkTime,
    getDate,
    getGameStats,
    getLastTouchOfTheBall,
    getRole,
    handleActivity,
    stadiumCommand,
    updateTeams,
})));

// Exposed on the resolved `ready` value (see below) purely for
// tools/load-check.js to sanity-check the FULL command wiring — a command
// can be registered in commands.js's own commands object and still have
// `.function` end up undefined if it's never actually threaded through the
// createCommands({...}) call above (see !hide's own bug: added everywhere
// else, forgotten there — the dispatcher called undefined(player, message),
// which threw and — since nothing after that throw ever reached
// onPlayerChat's own `return false` — silently fell through to the native
// chat bubble instead of running the command or showing an error).
return { commands };
}

// Resolves with { commands } on success or the Error itself on failure
// (never rejects) — gives tools/load-check.js an explicit hook to detect a
// failed init without scraping console output for a string, and to
// double-check the command wiring on success. Meaningless in the browser
// (nothing reads a bundled entry point's module.exports there), harmless
// either way — esbuild handles `module` internally for every bundled file
// regardless of the final output format.
const ready = main().catch((err) => {
    console.error('[FATAL] entry.js failed to initialise:', err);
    return err;
});
module.exports = { ready };
