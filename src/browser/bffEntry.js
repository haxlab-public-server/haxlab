/*
 * BFF room's in-page entry point — a genuinely separate bundle from
 * entry.js (see tools/build-bundle.js), not a mode flag on the same one.
 * Same Puppeteer-injection architecture as the main room (see
 * src/browser/entry.js's own docblock) — this runs in the SAME JS realm as
 * the real `room` object HBInit() creates for BFF's own HaxBall room.
 *
 * Deliberately reuses every genuinely economy/club-free module the main
 * room already has (stats/global.js, stats/goalAttribution.js, stats/gk.js,
 * stats/playerStats.js, team/lineup.js, events/misc.js, safeEventHandlers.js,
 * core/constants.js, core/models.js, core/utils.js) — confirmed one by one
 * by reading their factory signatures before deciding to share rather than
 * fork them. What's genuinely BFF-specific (team assembly, map/limits, DB
 * routing, join/leave/game-lifecycle) lives under core/bff/*, deliberately
 * NOT sharing team/balance.js, events/movement.js, events/gameManagement.js,
 * or core/economy.js — see haxchill-second-room-plan project memory for
 * why each of those was forked rather than reused.
 */
const { createBridgedDb } = require('./dbBridgeClient');
const { createBridgedDiscordBot } = require('./discordBridgeClient');

const { roomName, maxPlayers, buildGameConfig } = require('../core/bff/roomConstants');

async function main() {

/* SHARED MUTABLE STATE */
const state = {};
const authArray = [];

const room = HBInit(buildGameConfig(window.__secrets.bffToken, window.__secrets.testMode));

const {
    Team,
    State,
    Role,
    HaxNotification,
    Situation,
    welcomeColor,
    announcementColor,
    infoColor,
    redColor,
    blueColor,
    warningColor,
    errorColor,
    successColor,
    privateMessageColor,
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
    getTimeGame,
    getTimeStats,
    pointDistance,
    getRandomInt,
    generateRoomPassword,
    formatBanRemaining,
    formatVipRemaining,
    getMinutesReport,
    getSecondsReport,
    getTimeEmbed,
    findFirstNumberCharString,
} = require('../core/utils');
const { getIdReport, getRecordingName, fetchRecording } = require('../core/reports');
const wrapEventHandlers = require('../core/safeEventHandlers');
const createChatHelpers = require('../core/chat');

const db = createBridgedDb();
const discordBot = createBridgedDiscordBot({ state, authArray });

/* ROOM BRIDGE — same shape as entry.js's, own roster/relay for BFF */
window.__bffRoomBridge = {
    relayToRoom(username, content) {
        room.sendAnnouncement(`[DISCORD] ${username}: ${content}`, null, announcementColor, 'bold', HaxNotification.CHAT);
    },
    kickByAuth(auth, reason) {
        const target = state.playersAll.find((p) => authArray[p.id]?.[0] === auth);
        if (!target) return null;
        room.kickPlayer(target.id, reason ? `Вы забанены: ${reason}` : 'Вы забанены.', false);
        return { name: target.name };
    },
    getRoster() {
        return state.playersAll.map((p) => ({ id: p.id, name: p.name, auth: authArray[p.id]?.[0] ?? null }));
    },
};

window.addEventListener('error', (event) => {
    console.error('[BFF FATAL] Uncaught exception:', event.error);
    discordBot.sendLog(`🔴 **[BFF] Необработанная ошибка в комнате:**\n\`\`\`${(event.error && event.error.stack) || event.message}\`\`\``);
});
window.addEventListener('unhandledrejection', (event) => {
    console.error('[BFF FATAL] Unhandled rejection:', event.reason);
    discordBot.sendLog(`⚠️ **[BFF] Необработанный reject:**\n\`\`\`${(event.reason && event.reason.stack) || event.reason}\`\`\``);
});

/* ROOM SETUP */
const { bffTrainingMap, bffClassicMap, bffBigMap } = require('../core/bff/stadiums');
const createRoomSetup = require('../core/bff/roomSetup');

state.currentStadium = 'training';
room.setCustomStadium(bffTrainingMap);
room.setTeamsLock(true);
room.setKickRateLimit(6, 12, 4);
state.roomPassword = window.__secrets.bffRoomPassword;
room.setPassword(state.roomPassword != '' ? state.roomPassword : null);

/* OPTIONS */
const teamSize = 4;
const classicScoreLimit = 2;
const classicTimeLimit = 2;
const bigScoreLimit = 4;
const bigTimeLimit = 4;
const debugMode = window.__secrets.testMode === true;
const afkLimit = debugMode ? Infinity : 15;
// Real 10s pause between matches — see haxchill-second-room-plan memory
// ("после любого матча, независимо от размера"). Confirmed value, not a
// placeholder.
const reassembleDelayMs = 10000;

const { applyLimitsForSize, applyTrainingMap } = createRoomSetup({
    room, state, bffTrainingMap, bffClassicMap, bffBigMap,
    classicScoreLimit, classicTimeLimit, bigScoreLimit, bigTimeLimit,
});

/* OVERFLOW PASSWORD — BFF's own numbers (threshold 12, max 14), confirmed
 * 2026-08-14, deliberately smaller than the main room's (14/20). Same
 * module (core/overflowPassword.js), reused as-is — it was already
 * economy-free. */
// Same setting-key names the module itself writes to internally
// (overflowPassword.js's own PASSWORD_SETTING_KEY/PASSWORD_SET_AT_SETTING_KEY
// are hardcoded, not parameterized) — no collision risk with the main
// room's own use of these same key names, since BFF's `db` routes to a
// genuinely separate physical file (see core/bff/dbBridge.js).
const passwordThreshold = 12;
const createOverflowPassword = require('../core/overflowPassword');
const persistedPassword = await db.getSetting('overflowPasswordValue');
const persistedPasswordSetAt = Number(await db.getSetting('overflowPasswordSetAt')) || 0;
const { checkOverflowPassword } = createOverflowPassword({
    room, state, maxPlayers, passwordThreshold, discordBot, generateRoomPassword,
    rotateIntervalMs: 60 * 60 * 1000, db,
    initialPassword: persistedPassword, initialPasswordSetAt: persistedPasswordSetAt,
});

/* OBJECTS */
state.gameState = State.STOP;
state.playSituation = Situation.STOP;
state.playersAll = [];
state.players = [];
state.teamRed = [];
state.teamBlue = [];
state.teamSpec = [];
state.teamRedStats = [];
state.teamBlueStats = [];
state.lastWinner = Team.SPECTATORS;
// Native (connection-based) ban tracking for !banlist/!clearbans (see
// commands/master.js) — separate from the auth-based system (!banauth,
// db.getAuthBans), which is the primary/more robust mechanism.
state.banList = [];
// !voteban session — see core/voteBan.js (reused as-is). Self-contained:
// runs on its own 60s clock, nothing else here ever resets it mid-match.
state.votebanSession = null;
// True only during matchFlow.js's own reassembleDelayMs pause between
// matches — guards against a join/leave landing in that window triggering
// an early reassembly (see matchFlow.js's own comment on assembleMatch).
state.reassembling = false;
// playerId -> the moment they entered the spectator queue (fresh join, or
// benched back after playing) — matchFlow.js's assembleMatch sorts by this
// (oldest first) so waiting players actually rotate in, instead of the
// same early joiners getting reselected every round forever. Stamped on
// join (see core/bff/events.js's onPlayerJoin) and re-stamped whenever
// matchFlow.js benches someone after their match ends.
state.specQueueSince = new Map();

/* AUTH — masters/admins/VIPs are SHARED with the main room (routed to the
 * main room's own db file by the orchestrator's dbBridge.js; from here,
 * `db` just looks like one ordinary bridged database, same as the main
 * room's entry.js). */
state.adminList = (await db.getAdmins()).map((a) => [a.auth, a.playerName]);
state.vipList = (await db.getVips()).map((v) => [v.auth, v.playerName, v.expiresAt]);
const masterList = await db.getMasters();

/* GAME */
// Not displayed anywhere in BFF (no possession%/action-zone% report line —
// see core/bff/report.js's own doc comment), but stats/global.js's
// getGameStats() (reused as-is) unconditionally increments these on every
// tick regardless — omitting them crashed onGameTick continuously
// (`state.possession[0]++` on undefined), silently swallowed by
// safeEventHandlers.js so it never surfaced as a process crash, just a
// tick that never ran handleGK() — caught during the first real live
// Puppeteer/HaxBall test run, invisible to every stubbed/mocked check.
state.possession = [0, 0];
state.actionZoneHalf = [0, 0];
state.lastTouches = Array(2).fill(null);
state.lastTeamTouched = undefined;
state.speedCoefficient = 100 / (5 * (0.99 ** 60 + 1));
state.playerRadius = 15;
state.ballRadius = 10;
state.triggerDistance = state.playerRadius + state.ballRadius + 0.01;

/* AUXILIARY */
state.checkTimeVariable = false;
state.checkStadiumVariable = true;
state.endGameVariable = false;
state.goldenGoal = false;
const hiddenAdminsSet = new Set();
const AFKSet = new Map();

const emptyPlayer = { id: 0 };

/* CHAT MODERATION — spam-flood auto-mute + !mute/!unmute/!mutes/!hide (see
 * core/bff/chatGuard.js). */
const muteArray = new MuteList();
const MutePlayer = createMutePlayerClass({ room, announcementColor, HaxNotification, muteArray });
const muteDuration = 5;
const createBffChatGuard = require('../core/bff/chatGuard');
const chatGuard = createBffChatGuard({
    room, authArray, MutePlayer, muteArray, hiddenAdminsSet,
    announcementColor, errorColor, HaxNotification, muteDuration,
});

/* AFK (voluntary !afk/"jj" toggle — see core/bff/afk.js). Same numbers as
 * the main room's own (never flagged as needing to differ, unlike the
 * capacity/limit numbers that deliberately do). */
const AFKMinSet = new Set();
const AFKCooldownSet = new Set();
const minAFKDuration = 1;
const maxAFKDuration = 15;
const maxAFKDurationVip = 25;
const AFKCooldown = 10;
const maxAFKCount = 4;

/* AUXILIARY FUNCTIONS — composition-root, same convention as entry.js's
 * own inline (not factory-extracted) functions; only exercised via a full
 * bootstrap, not unit-tested directly. */
function getGoalGame() {
    return state.game.scores.red + state.game.scores.blue;
}

function getPlayerComp(player) {
    if (player == null || player.id == 0) return null;
    const comp = state.game.playerComp;
    let index = comp[0].findIndex((c) => c.auth == authArray[player.id][0]);
    if (index != -1) return comp[0][index];
    index = comp[1].findIndex((c) => c.auth == authArray[player.id][0]);
    if (index != -1) return comp[1][index];
    return null;
}

function calculateStadiumVariables() {
    if (state.checkStadiumVariable && state.teamRed.length + state.teamBlue.length > 0) {
        state.checkStadiumVariable = false;
        setTimeout(() => {
            const ballDisc = room.getDiscProperties(0);
            const playerDisc = room.getPlayerDiscProperties(state.teamRed.concat(state.teamBlue)[0].id);
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

function updateTeams() {
    state.playersAll = room.getPlayerList();
    state.players = state.playersAll.filter((p) => !AFKSet.has(p.id));
    state.teamRed = state.players.filter((p) => p.team == Team.RED);
    state.teamBlue = state.players.filter((p) => p.team == Team.BLUE);
    state.teamSpec = state.players.filter((p) => p.team == Team.SPECTATORS);
}

// Hierarchical, same ladder as the main room's getRole() — see
// core/constants.js's Role enum, shared between both rooms.
function getRole(player) {
    const auth = authArray[player.id][0];
    if (masterList.includes(auth)) return Role.MASTER;
    if (state.adminList.some((a) => a[0] == auth)) return Role.ADMIN_PERM;
    if (player.admin) return Role.ADMIN_TEMP;
    if (state.vipList.some((v) => v[0] == auth && (v[2] == null || new Date(v[2]).getTime() > Date.now()))) return Role.VIP;
    return Role.PLAYER;
}

function ghostKickHandle(oldP, newP) {
    room.kickPlayer(oldP.id, 'Дубликат', false);
    room.setPlayerTeam(newP.id, oldP.team);
    room.setPlayerAdmin(newP.id, oldP.admin);
}

// stadiumCommand-shaped adapter for events/misc.js's onStadiumChange, which
// expects to be able to "revert" an unauthorized manual stadium edit by
// re-issuing whatever `!<state.currentStadium>` would have meant — BFF has
// no such chat command (map choice is fully automatic), so this just maps
// the three possible state.currentStadium values back onto roomSetup.js's
// two real functions.
function bffStadiumCommand() {
    if (state.currentStadium === 'training') applyTrainingMap();
    else if (state.currentStadium === 'classic') applyLimitsForSize(1);
    else applyLimitsForSize(3);
}

/* ACTIVITY (AFK) FUNCTIONS — same shape as entry.js's own, minus the
 * chooseMode branch BFF doesn't have. */
function handleActivityPlayer(player) {
    const pComp = getPlayerComp(player);
    if (pComp == null) return;
    pComp.inactivityTicks++;
    if (pComp.inactivityTicks == 60 * ((2 / 3) * afkLimit)) {
        room.sendAnnouncement(
            `⛔ ${player.name}, если вы не активны, вы будете кикнуты через ${afkLimit / 3} секунд.`,
            player.id, warningColor, 'bold', HaxNotification.MENTION
        );
        return;
    }
    if (pComp.inactivityTicks >= 60 * afkLimit) {
        pComp.inactivityTicks = 0;
        room.kickPlayer(player.id, 'AFK', false);
    }
}

function handleActivityPlayerTeamChange(changedPlayer) {
    if (changedPlayer.team == Team.SPECTATORS) {
        const pComp = getPlayerComp(changedPlayer);
        if (pComp != null) pComp.inactivityTicks = 0;
    }
}

function handleActivityStop() {
    for (const player of state.players) {
        const pComp = getPlayerComp(player);
        if (pComp != null) pComp.inactivityTicks = 0;
    }
}

function handleActivity() {
    if (state.gameState === State.PLAY && state.players.length > 1) {
        for (const player of state.teamRed) handleActivityPlayer(player);
        for (const player of state.teamBlue) handleActivityPlayer(player);
    }
}

// Real bug fixed here (reported live 2026-08-14: "меня кикнуло, хотя я
// двигался, как и все"): room.onPlayerActivity — HaxBall's own native
// per-player "did something this tick" signal — was never wired at all.
// Without it, pComp.inactivityTicks (incremented every tick by
// handleActivityPlayer above) never got reset by actual movement/input, so
// it climbed to the kick threshold regardless of how active the player
// really was. The main room's own events/activity.js has this exact
// handler; BFF never reuses that module (too coupled to trophies/clubs/
// economy), so it just never got ported over.
function onPlayerActivity(player) {
    if (state.gameState !== State.STOP) {
        const pComp = getPlayerComp(player);
        if (pComp != null) pComp.inactivityTicks = 0;
    }
}

/* LINEUP (reused as-is, no economy coupling) */
const createLineupHelpers = require('../core/team/lineup');
const { getStartingLineups, handleLineupChangeTeamChange, handleLineupChangeLeave } = createLineupHelpers({
    state, Team, State, Situation, PlayerComposition, authArray,
});

// Same as the main room's own entry.js (state.game = new Game(...), right
// after getStartingLineups exists): initialized unconditionally here, not
// left undefined until the first onGameStart, so getPlayerComp (and
// anything downstream of it, like the AFK-activity handlers) never has to
// special-case "no match has started yet" — a real bug this fixed: the
// very first player ever assigned to a team by matchFlow.js, before any
// match had started, crashed handleActivityPlayerTeamChange with "Cannot
// read properties of undefined (reading 'playerComp')" (caught by
// safeEventHandlers.js, so not a process crash, but the AFK-tracking reset
// silently never ran).
state.game = new Game(room, getStartingLineups);

/* GOAL ATTRIBUTION (reused as-is) */
const createGoalAttribution = require('../core/stats/goalAttribution');
const { getGoalString } = createGoalAttribution({ state, Team, Goal, getTimeGame });

/* GK (reused as-is) */
const createGkHelpers = require('../core/stats/gk');
const { handleGK, getGK } = createGkHelpers({ state, Team, getPlayerComp });

/* GLOBAL STATS (reused as-is) */
const createGlobalStats = require('../core/stats/global');
const { getLastTouchOfTheBall, getGameStats } = createGlobalStats({
    room, state, Team, State, Situation, BallTouch,
    checkGoalKickTouch, getGoalGame, handleGK, pointDistance, updateTeams,
});

/* PLAYER STATS (reused as-is) */
const createPlayerStats = require('../core/stats/playerStats');
const { getGoalsPlayer, getAssistsPlayer, getOwnGoalsPlayer, getCSPlayer, getGametimePlayer, actionReportCountTeam } = createPlayerStats({
    state, Team, authArray, HaxStatistics, getGK, getPlayerComp,
});

/* BFF ROOM STATS (trimmed fork — see core/bff/roomStats.js) */
const createBffRoomStats = require('../core/bff/roomStats');
const bffRoomStats = createBffRoomStats({
    room, state, Team, authArray, db, HaxStatistics, HaxNotification, errorColor, teamSize,
    getAssistsPlayer, getCSPlayer, getGametimePlayer, getGoalsPlayer, getOwnGoalsPlayer,
    getPlayerComp, getTimeStats,
});

/* MATCH REPORT (Discord embed — see core/bff/report.js, forked out of
 * stats/fetch.js: same field builders, minus the possession/action-zone
 * lines BFF's own endGame() never tracks) */
const createBffReport = require('../core/bff/report');
const { fetchSummaryEmbed } = createBffReport({
    Team, state, discordBot, roomName,
    findFirstNumberCharString, actionReportCountTeam,
    getGametimePlayer, getIdReport, getMinutesReport, getRecordingName,
    getSecondsReport, getTimeEmbed,
});

/* GAME FUNCTIONS — checkTime/endGame, same composition-root convention as
 * the main room's own (see entry.js's GAME FUNCTIONS section). Simplified
 * relative to the main room's: no possession%/action-zone%/CS-string
 * display, no coins/bets. Draws are NOT possible, same as the main room
 * (confirmed 2026-08-14) — golden goal kicks in instead: a tie at the time
 * limit just keeps the match going until literally any goal is scored (see
 * checkTime() below and core/bff/events.js's onTeamGoal, which ends the
 * match on ANY goal once state.goldenGoal is set, not just at the score
 * limit). endGame's own Team.SPECTATORS/'draw' branch is now unreachable
 * via checkTime, but left intact — core/bff/rating.js's 'draw' outcome and
 * matchFlow.js's outcome derivation both still technically support it,
 * kept as harmless defensive code rather than ripped out for a case that
 * simply never triggers anymore. */
async function endGame(winner) {
    const scores = room.getScores();
    state.game.scores = scores;
    state.lastWinner = winner;
    state.endGameVariable = true;
    if (winner == Team.RED) {
        room.sendAnnouncement(`✨ Красная команда выиграла ${scores.red} - ${scores.blue} !`, null, redColor, 'bold', HaxNotification.CHAT);
    } else if (winner == Team.BLUE) {
        room.sendAnnouncement(`✨ Синяя команда выиграла ${scores.blue} - ${scores.red} !`, null, blueColor, 'bold', HaxNotification.CHAT);
    } else {
        room.sendAnnouncement('💤 Ничья !', null, announcementColor, 'bold', HaxNotification.CHAT);
    }
}

function checkTime() {
    const scores = room.getScores();
    if (state.game != undefined) state.game.scores = scores;
    if (Math.abs(scores.time - scores.timeLimit) <= 0.01 && scores.timeLimit != 0 && state.playSituation == Situation.PLAY) {
        if (scores.red != scores.blue) {
            if (!state.checkTimeVariable) {
                state.checkTimeVariable = true;
                setTimeout(() => { state.checkTimeVariable = false; }, 3000);
                (scores.red > scores.blue ? endGame(Team.RED) : endGame(Team.BLUE)).then(() => {
                    state.stopTimeout = setTimeout(() => { room.stopGame(); }, 2000);
                });
            }
            return;
        }
        // Tied at the time limit — golden goal, not a draw (confirmed
        // 2026-08-14, same as the main room). This branch only ever fires
        // once: scores.time only sits within 0.01 of timeLimit for a single
        // tick, same self-limiting shape the end-game branch above relies
        // on checkTimeVariable for. onTeamGoal (core/bff/events.js) checks
        // state.goldenGoal and ends the match on the very next goal,
        // regardless of the score limit.
        state.goldenGoal = true;
        room.sendAnnouncement('⚽ Решающий гол !', null, announcementColor, 'bold', HaxNotification.CHAT);
    }
}

/* BFF EVENTS (join/leave/kicked/game-lifecycle — see core/bff/events.js) */
const createBffEvents = require('../core/bff/events');
const createBffMatchFlow = require('../core/bff/matchFlow');

const matchFlow = createBffMatchFlow({
    room, state, Team, State,
    getAuth: (p) => authArray[p.id][0],
    getRating: (auth) => db.getRating(auth),
    saveRating: (auth, playerName, mu, sigma) => db.saveRating(auth, playerName, mu, sigma),
    applyLimitsForSize, applyTrainingMap, teamSize, reassembleDelayMs,
});

const createBffAfk = require('../core/bff/afk');
const afkSystem = createBffAfk({
    room, state, Team, State, Role,
    AFKSet, AFKMinSet, AFKCooldownSet,
    minAFKDuration, maxAFKDuration, maxAFKDurationVip, maxAFKCount, AFKCooldown,
    announcementColor, errorColor, HaxNotification,
    getRole, updateTeams, matchFlow,
});

Object.assign(room, wrapEventHandlers(createBffEvents({
    room, state, authArray, db, Team, State, Situation, Game,
    HaxNotification, Role,
    announcementColor, errorColor, infoColor, welcomeColor, redColor, blueColor,
    masterList, maxPlayers, discordBot,
    getDate, getRole, getGoalString, getPlayerComp, getStartingLineups,
    handleLineupChangeLeave, handleLineupChangeTeamChange,
    ghostKickHandle, updateTeams, calculateStadiumVariables, checkOverflowPassword, endGame,
    matchFlow, bffRoomStats, teamSize,
    fetchSummaryEmbed, fetchRecording,
})));

/* MISCELLANEOUS — events/misc.js is genuinely reused as-is, confirmed
 * economy/club-free by reading its factory signature before deciding not
 * to fork it. */
const createMiscEvents = require('../core/events/misc');
Object.assign(room, wrapEventHandlers(createMiscEvents({
    room, state, HaxNotification, Role, discordBot, emptyPlayer,
    errorColor, infoColor, hiddenAdminsSet,
    checkTime, getDate, getGameStats, getLastTouchOfTheBall, getRole,
    handleActivity, stadiumCommand: bffStadiumCommand, updateTeams,
})));

// onPlayerAdminChange (wired above via misc.js) fires on room join, but the
// activity/lineup team-change hooks below aren't part of misc.js — folded
// directly into onGameStart via bff/events.js already; onPlayerTeamChange's
// activity-reset hook still needs wiring here since misc.js doesn't cover
// team-change at all (only the main room's movement.js did).
const originalTeamChange = room.onPlayerTeamChange;
room.onPlayerTeamChange = wrapEventHandlers({
    onPlayerTeamChange: (changedPlayer, byPlayer) => {
        handleActivityPlayerTeamChange(changedPlayer);
        return originalTeamChange(changedPlayer, byPlayer);
    },
}).onPlayerTeamChange;

const originalGameStop = room.onGameStop;
room.onGameStop = wrapEventHandlers({
    onGameStop: (byPlayer) => {
        handleActivityStop();
        return originalGameStop(byPlayer);
    },
}).onGameStop;

// Nothing else sets room.onPlayerActivity, so no "original" to merge with
// (unlike onPlayerTeamChange/onGameStop above) — see onPlayerActivity's own
// doc comment for why this exists.
Object.assign(room, wrapEventHandlers({ onPlayerActivity }));

/* COMMANDS */
const { computeOrdinal } = require('../core/bff/rating');
const createBffCommands = require('../core/bff/commands');
const { meCommand, topsCommand, renameCommand, helpCommand } = createBffCommands({
    room, state, authArray, db, HaxStatistics, HaxNotification, Role,
    infoColor, errorColor, successColor, getTimeStats, getRole, computeOrdinal, bffRoomStats,
});

// Master-level moderation (bans/admins/VIPs/password/restrictions) — reused
// as-is, confirmed economy/club-free by reading its factory signature.
// db.banAuth/db.getAdmins/etc. route to BFF's own file vs the shared file
// exactly as core/bff/dbBridge.js decides — this module doesn't need to
// know which is which.
const createMasterCommands = require('../core/commands/master');
const {
    clearbansCommand, banListCommand, adminListCommand, setAdminCommand, removeAdminCommand,
    setVipCommand, removeVipCommand, vipListCommand, banAuthCommand, unbanAuthCommand,
    authBanListCommand, playersListCommand, passwordCommand, purgeExpiredVips,
} = createMasterCommands({
    room, state, authArray, db, masterList, announcementColor, errorColor, HaxNotification,
    formatBanRemaining, formatVipRemaining, discordBot,
});
// Same purpose as the main room's own periodic sweep (see entry.js) — makes
// an expired VIP's Discord role actually get revoked promptly, not just
// whenever someone next happens to run a VIP command.
setInterval(() => purgeExpiredVips().catch((err) => console.error('[BFF] purgeExpiredVips failed:', err)), 60 * 60 * 1000);

// !voteban — reused as-is (core/voteBan.js), confirmed economy/club-free by
// reading its factory signature. db.banAuth routes to BFF's own file (see
// core/bff/dbBridge.js), matching the "not shared" rule for auth-bans.
const createVoteBan = require('../core/voteBan');
const { votebanCommand, handleVoteBanMessage } = createVoteBan({
    room, state, authArray, db, Role, getRole, HaxNotification,
    errorColor, warningColor, successColor, announcementColor, discordBot, formatBanRemaining,
});

// !report — reused logic from commands/player.js's reportCommand, forked
// out to avoid that factory's economy/club-tied deps (see core/bff/adminCall.js).
const createBffAdminCall = require('../core/bff/adminCall');
const { reportCommand } = createBffAdminCall({
    room, authArray, db, errorColor, HaxNotification, discordBot, formatBanRemaining,
});

const { getCommand, getTeamArray, teamChat, playerChat } = createChatHelpers({
    room, Team, redColor, blueColor, errorColor, privateMessageColor, HaxNotification,
    getPlayersAll: () => state.playersAll,
    getTeamRed: () => state.teamRed,
    getTeamBlue: () => state.teamBlue,
    getTeamSpec: () => state.teamSpec,
    getCommands: () => commands,
});

// Role.MASTER for every moderation command, matching the main room's own
// commands.js exactly (regular admins get the native HaxBall badge/powers,
// not bot commands) — see core/bff/commands.js's helpCommand for the same
// gating already documented there.
const commands = {
    me: { aliases: ['stat', 'stats', 'ы', 's'], roles: Role.PLAYER, function: meCommand },
    tops: { aliases: ['top'], roles: Role.PLAYER, function: topsCommand },
    rename: { aliases: [], roles: Role.PLAYER, function: renameCommand },
    help: { aliases: ['commands', 'рудз'], roles: Role.PLAYER, function: helpCommand },
    t: { aliases: [], roles: Role.PLAYER, function: teamChat },
    p: { aliases: [], roles: Role.PLAYER, function: playerChat },
    voteban: { aliases: [], roles: Role.PLAYER, function: votebanCommand },
    report: { aliases: ['админ'], roles: Role.PLAYER, function: reportCommand },
    afk: { aliases: ['афк', 'фал'], roles: Role.PLAYER, function: afkSystem.afkCommand },
    afks: { aliases: ['afklist', 'фалы'], roles: Role.PLAYER, function: afkSystem.afksCommand },
    mute: { aliases: ['m'], roles: Role.ADMIN_TEMP, function: chatGuard.muteCommand },
    unmute: { aliases: ['um'], roles: Role.ADMIN_TEMP, function: chatGuard.unmuteCommand },
    mutes: { aliases: [], roles: Role.ADMIN_TEMP, function: chatGuard.muteListCommand },
    hide: { aliases: [], roles: Role.ADMIN_TEMP, function: chatGuard.hideCommand },
    clearbans: { aliases: [], roles: Role.MASTER, function: clearbansCommand },
    banlist: { aliases: [], roles: Role.MASTER, function: banListCommand },
    admins: { aliases: ['adminlist'], roles: Role.MASTER, function: adminListCommand },
    setadmin: { aliases: ['admin'], roles: Role.MASTER, function: setAdminCommand },
    removeadmin: { aliases: ['unadmin'], roles: Role.MASTER, function: removeAdminCommand },
    setvip: { aliases: [], roles: Role.MASTER, function: setVipCommand },
    removevip: { aliases: [], roles: Role.MASTER, function: removeVipCommand },
    vips: { aliases: ['viplist'], roles: Role.MASTER, function: vipListCommand },
    banauth: { aliases: [], roles: Role.MASTER, function: banAuthCommand },
    unbanauth: { aliases: [], roles: Role.MASTER, function: unbanAuthCommand },
    authbans: { aliases: [], roles: Role.MASTER, function: authBanListCommand },
    players: { aliases: [], roles: Role.MASTER, function: playersListCommand },
    password: { aliases: ['pw'], roles: Role.MASTER, function: passwordCommand },
};

// onPlayerChat: !command dispatch (same mechanic as the main room's
// activity.js), plus spam-flood auto-mute, a !voteban bare "1"/"2" vote
// capture, 't'/'т'/'ч'/'@@' bare-word chat shortcuts, "jj" (AFK exit
// shortcut), a mute check, and — for MASTER/ADMIN/VIP only — a role-
// prefixed chat line sent through room.sendAnnouncement; a plain player's
// message is left alone (return true) to render as HaxBall's own native
// chat bubble, same as before this was added. Deliberately NOT reusing
// activity.js itself (confirmed too coupled to trophies/clubs/economy/
// pauseVote/chooseMode/slow-mode/club-and-trophy prefixes/per-viewer
// silence-and-custom-color state BFF doesn't have — see
// core/bff/chatGuard.js, core/bff/afk.js and core/voteBan.js for the
// pieces reused/forked out for this). Same ordering as activity.js:
// command dispatch first (a command always wins over a stray "1"/"2"),
// then the voteban capture, then t/т/ч/@@, then "jj", then the mute gate.
room.onPlayerChat = wrapEventHandlers({
    onPlayerChat: (player, message) => {
        chatGuard.checkSpamFlood(player);
        discordBot.sendLog(`[${getDate()}] 💬 CHAT\n**${player.name}** : ${message}`);
        const msgArray = message.split(/ +/);
        if (msgArray[0][0] == '!') {
            const command = getCommand(msgArray[0].slice(1).toLowerCase());
            if (command != false && commands[command].roles <= getRole(player)) {
                const result = commands[command].function(player, message);
                if (result instanceof Promise) result.catch((err) => console.error(`[BFF] Error in command !${command}:`, err));
            } else {
                room.sendAnnouncement(
                    `Команда, которую вы пытались ввести, не существует для вас. Введите "!help" для получения доступных команд.`,
                    player.id, errorColor, 'bold', HaxNotification.CHAT
                );
            }
            return false;
        }
        if (handleVoteBanMessage(player, message)) {
            return false;
        }
        // 't'/'т'/'ч' and '@@<name> <message>' — bare-word shortcuts for
        // !t/!p, same as activity.js's own (the main room has no !t/!p
        // commands at all, only these — BFF keeps both since !t/!p already
        // shipped here). 'т'/'ч' cover the same physical/muscle-memory slip
        // as typing "t" with the client's text input still on a Cyrillic
        // layout. Each gated individually (not via the shared mute-check
        // below) since teamChat/playerChat don't check mute themselves.
        if (['t', 'т', 'ч'].includes(msgArray[0].toLowerCase())) {
            if (chatGuard.isMuted(player)) {
                chatGuard.announceMuted(player);
                return false;
            }
            teamChat(player, message);
            return false;
        }
        if (msgArray[0].substring(0, 2) === '@@') {
            if (chatGuard.isMuted(player)) {
                chatGuard.announceMuted(player);
                return false;
            }
            playerChat(player, message);
            return false;
        }
        // "jj" — bare word, no ! prefix (same shape as activity.js's own).
        // AFKSet.has() is checked synchronously here (not inside the async
        // jjCommand/exitAfk) specifically so this return value can be
        // decided synchronously, the way HaxBall's onPlayerChat requires —
        // the actual AFK-exit + matchFlow update still happens, just as a
        // caught fire-and-forget continuation.
        if (msgArray[0].toLowerCase() == 'jj' && AFKSet.has(player.id)) {
            const result = afkSystem.jjCommand(player);
            if (result instanceof Promise) result.catch((err) => console.error('[BFF] jjCommand failed:', err));
            return false;
        }
        if (chatGuard.isMuted(player)) {
            chatGuard.announceMuted(player);
            return false;
        }
        // Role-prefixed chat — MASTER/ADMIN/VIP only (see haxchill-vip-
        // and-chat-prefixes memory), everyone else's message is left alone
        // (return true) to render as HaxBall's own native chat bubble.
        // Deliberately NOT intercepting @mentions here (tried, then
        // reverted 2026-08-14): unlike the main room, which never uses the
        // native bubble for anyone, BFF's plain-player messages already go
        // through it — and native HaxBall already plays its own "mention"
        // sound correctly for a native "@name" mention on its own. Manually
        // rerouting those messages through sendAnnouncement only replaced
        // working native behavior with a redundant, worse reimplementation.
        const role = getRole(player);
        const showAdminPrefix = !hiddenAdminsSet.has(player.id);
        let rolePrefix = null;
        let prefixColor = null;
        if (showAdminPrefix && role == Role.MASTER) {
            rolePrefix = '[👑СЗД]';
            prefixColor = masterChatColor;
        } else if (showAdminPrefix && role >= Role.ADMIN_TEMP) {
            rolePrefix = '[🛡️АДМ]';
            prefixColor = adminChatColor;
        } else if (role == Role.VIP) {
            rolePrefix = '[⭐ВИП]';
            prefixColor = vipChatColor;
        }
        if (rolePrefix == null) return true;
        room.sendAnnouncement(`${rolePrefix} ${player.name}: ${message}`, null, prefixColor, 'bold', null);
        return false;
    },
}).onPlayerChat;

return { commands };
}

const ready = main().catch((err) => {
    console.error('[BFF FATAL] bffEntry.js failed to initialise:', err);
    return err;
});
module.exports = { ready };
