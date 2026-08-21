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
// carries the things that come from process.env on the orchestrator side
// (HAXBALL_TOKEN, ROOM_PASSWORD, TEST_MODE) and therefore can't live in
// roomConstants.js, which has to stay safe to bundle into a context with no
// `process` at all.
const room = HBInit(buildGameConfig(window.__secrets.token, window.__secrets.testMode));

const {
    Team,
    State,
    Role,
    HaxNotification,
    Situation,
    Trophies,
    welcomeColor,
    announcementColor,
    infoColor,
    privateMessageColor,
    redColor,
    blueColor,
    warningColor,
    errorColor,
    successColor,
    achievementColor,
    defaultColor,
    masterChatColor,
    adminChatColor,
    helperChatColor,
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
    formatVipRemaining,
    formatCoins,
    renderProgressBar,
    detectCleanSheetWatch,
    formatStreakText,
    formatTrophyLabel,
    encodeLegacyTrophyKey,
    resolveTrophyRank,
    buildBox,
} = require('../core/utils');
const {
    getIdReport,
    getRecordingName,
    fetchRecording,
} = require('../core/reports');
const createChatHelpers = require('../core/chat');
const { recordHeadToHead, checkWinStreakRecord } = require('../core/matchHistory');

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

// Reserves every slot past 14 for people who know the password (shared to
// Discord) rather than anyone who has the room link — see
// core/overflowPassword.js for the activate/rotate/deactivate lifecycle.
// Fixed at 15 regardless of maxPlayers (currently 20, see roomConstants.js)
// — NOT maxPlayers-N, which would silently shrink/grow the password-gated
// zone every time maxPlayers changes.
const passwordThreshold = 15;
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

/* TELEGRAM ACCOUNT LINKING */

// !telegram [code] — links this player's auth to a Telegram chat id, so
// VIPs can pull the current overflow password via /pass (see
// core/telegram.js) instead of watching Discord. Reused as-is by BFF too
// (bffEntry.js instantiates its own copy) — see core/telegramLink.js's own
// doc comment.
const createTelegramLink = require('../core/telegramLink');
const { linkTelegramCommand } = createTelegramLink({
    room, db, authArray, HaxNotification, errorColor, successColor, generateRoomPassword,
});

/* ECONOMY */

// Coins for wins/losses/playtime, spent in !shop on cosmetics (forms +
// goal animations) worn via !equip — see core/economy.js and
// core/shopItems.js (the editable catalog).
const shopItems = require('../core/shopItems');
const { playSmokeAnimation } = require('../core/smokeAnimation');
const { playFireworksAnimation } = require('../core/fireworksAnimation');
const { playBlackholeAnimation } = require('../core/blackholeAnimation');
const createEconomy = require('../core/economy');
const {
    awardMatchCoins,
    tickPlaytime,
    claimDailyBonus,
    applyTeamForms,
    announceTeamForms,
    playGoalAnimation,
    playGoalSizeEffect,
    shopCommand,
    inventoryCommand,
    equipCommand,
    addCoinsCommand,
    giftCoinsCommand,
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
    infoColor,
    achievementColor,
    warningColor,
    formatCoins,
    getRandomInt,
    playSmokeAnimation,
    playFireworksAnimation,
    playBlackholeAnimation,
    Role,
    getRole,
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

// Watched for as "@<name>" (case-insensitive) in chat by events/activity.js
// — see its own onPlayerChat. Empty disables the whole feature.
const mentionWatchName = window.__secrets.mentionWatchName;

/* OPTIONS */

const drawTimeLimit = Infinity;
const teamSize = 4;
// Per-stadium score/time limits, applied whenever stadiumCommand switches
// arenas — classic is the small 1v1/2v2 map, big is the 3v3/4v4 map.
const classicScoreLimit = 2;
const classicTimeLimit = 2;
const bigScoreLimit = 4;
const bigTimeLimit = 4;
const disableBans = false;
// TEST_MODE (npm run test / HaxBot_test.js) — no ghost-kick (see
// events/movement.js's onPlayerJoin) and no AFK-kick, so testing from the
// same account already sitting in the live room doesn't kick either one.
const debugMode = window.__secrets.testMode === true;
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
// Who won the last QUALIFYING (full 4v4) match — kept separate from
// state.lastWinner (requested 2026-08-18: "в 1х1 легко заабузить и
// накрутить" серию побед). state.lastWinner is overwritten on EVERY match
// regardless of size (other systems — ELO, coins — rely on that), so it
// can't double as "who to compare against for streak continuity": a 1v1
// played between two real 4v4s would otherwise silently reset or continue
// the streak based on an irrelevant small match's winner. See endGame's
// own isFullHouse check.
state.streakWinner = Team.SPECTATORS;

/* AUTH */

// Masters and permanent admins are configured in the database (see
// scripts/add-master.js) rather than granted at runtime by any bot command.
state.adminList = (await db.getAdmins()).map((a) => [a.auth, a.playerName]);
// Role.HELPER (2026-08-21) — same DB-configured-only shape as adminList
// above, just its own table/role tier (see getRole() below).
state.helperList = (await db.getHelpers()).map((h) => [h.auth, h.playerName]);
// Third tuple element is the VIP's expiry (ISO string, or null for a
// permanent grant, see !setvip in commands/master.js) — getRole() below
// checks it live on every message, since a grant can expire mid-session
// without a bot restart.
state.vipList = (await db.getVips()).map((v) => [v.auth, v.playerName, v.expiresAt]);
const masterList = await db.getMasters();

// Player clubs (see core/commands/club.js) — same in-memory cache pattern
// as adminList/vipList above, so the chat prefix (events/activity.js) never
// needs a DB round trip per message.
state.clubs = await db.getAllClubs();
state.clubMembers = await db.getAllClubMembers();

// Trophies (!trophy, see core/commands/trophies.js) — state.topPlayers is
// who currently ranks top-3 in each stat (refreshed once per completed
// match, see stats/roomStats.js's updateStats()); state.equippedTrophies is
// each player's own chosen category (auth -> trophy key), same
// in-memory-cache reasoning as clubs/adminList/vipList above.
state.topPlayers = await db.getTopPlayers();
state.equippedTrophies = (await db.getAllEquippedTrophies()).reduce((acc, row) => {
    acc[row.auth] = row.trophy;
    return acc;
}, {});

// Seasons (see db.closeSeason, run manually via scripts/close-season.js) —
// state.currentSeason tags LIVE trophies (e.g. "S1"); state.seasonTrophies is
// every already-closed season's frozen top-3 (never recomputed, unlike
// state.topPlayers), so a player who held rank 1-3 can keep displaying that
// exact title via !trophy long after their live stats reset to 0. Same
// in-memory-cache reasoning as topPlayers/equippedTrophies above — a closed
// season's rows never change, so no per-message DB round trip is needed.
state.currentSeason = await db.getCurrentSeason();
state.seasonTrophies = await db.getSeasonTrophies();

// In-room season-close notice (item #22) — scripts/close-season.js runs
// completely offline (its own docs: "Restart the bot for it to take
// effect"), so there's no live moment to announce FROM; instead, detect
// the change here at boot by comparing against the last season this
// process ever confirmed announcing, and if it moved, tell every player
// who joins for the rest of THIS boot (see movement.js's onPlayerJoin) —
// not just whoever happens to be first. The persisted marker is bumped
// immediately so a crash-and-restart mid-boot doesn't re-trigger it on
// the very next start, but state.newSeasonAnnounceNeeded stays true in
// memory for this process's whole lifetime regardless.
const lastAnnouncedSeason = Number((await db.getSetting('lastAnnouncedSeason')) ?? state.currentSeason);
state.newSeasonAnnounceNeeded = lastAnnouncedSeason !== state.currentSeason;
if (state.newSeasonAnnounceNeeded) {
    await db.setSetting('lastAnnouncedSeason', String(state.currentSeason));
}

// !customcolors (see core/commands/player.js) — auths who've opted out of
// SEEING other players' club custom colors (events/activity.js sends them
// the default color instead, per-viewer, on messages that would otherwise
// use a club's color). Same in-memory-cache reasoning as the above.
state.hiddenCustomColorsSet = new Set(await db.getAllHiddenCustomColors());

// !vipcolor (see core/commands/player.js) — a VIP's own override for their
// role's shared chat color (auth -> color), same in-memory-cache reasoning
// as the above.
state.vipColors = (await db.getAllVipColors()).reduce((acc, row) => {
    acc[row.auth] = row.color;
    return acc;
}, {});

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
state.chooseModePreMatch = false;
state.timeOutCap = undefined;
state.capLeft = false;
state.redCaptainChoice = '';
state.blueCaptainChoice = '';
const chooseTime = 20;

// !up (commands/player.js) — a VIP's claim to become the NEXT captain
// chosen (see team/choosing.js's choosePlayer() and team/balance.js's
// handlePlayersLeave(), the two places an empty side gets auto-filled from
// state.teamSpec[0] — both consume/clear this instead when set). Single
// slot: only one VIP can hold a live claim at a time.
state.priorityCaptainId = null;

state.swapMode = false;
state.swapTurnTeam = null;
state.swapStep = null;
state.swapPendingPlayerId = null;
state.swapTimeout = undefined;
const swapTime = 5;

// player.id -> Date.now() they went AFK — a Map rather than a plain Set so
// !afks (afkListCommand) can show how long each of them has been sitting
// there. Everywhere else only ever reads membership (.has/.size), which
// works identically on a Map.
const AFKSet = new Map();
const AFKMinSet = new Set();
const AFKCooldownSet = new Set();
// Matches !help afk's own advertised numbers (commands.js) — these had
// drifted to 0/30/0 (leftover test/debug values), so non-admins were
// sitting AFK for 30 real minutes before auto-return instead of the
// documented 5, reported live as "people who've been AFK 15+ minutes never
// get kicked back".
const minAFKDuration = 1;
const maxAFKDuration = 15;
// A current VIP+ gets a longer max AFK duration before auto-return (see
// commands/player.js's afkCommand) — re-checked live at the moment they go
// AFK, same as every other per-action VIP perk in this codebase.
const maxAFKDurationVip = 25;
const AFKCooldown = 10;
// Room-capacity cap, not an abuse timer — too many players sitting AFK at
// once starves the room of people actually available to play. Applies to
// everyone, admins included (see afkCommand's own reasoning).
const maxAFKCount = 4;

// !hide toggle (admins/master only) — suppresses the room admin badge and
// the chat prefix without touching adminList/masterList, so the underlying
// role/permissions never change, only the visible indicators. Keyed by
// player.id like AFKSet above (a per-session toggle, not a persisted
// preference — reconnecting resets it, same as AFK does).
const hiddenAdminsSet = new Set();

// !viphide toggle (VIP only) — same shape as hiddenAdminsSet above, but
// simpler: VIP has no native room badge to also suppress, only the chat
// prefix events/activity.js's onPlayerChat already checks. Persisted
// (requested 2026-08-16: survive a restart) and keyed by AUTH — same
// in-memory-cache reasoning as hiddenCustomColorsSet above, and same
// "player.id resets on reconnect" fix !up's cooldown already needed.
const hiddenVipSet = new Set(await db.getAllHiddenVipAuths());

// !silence #<id> — per-VIEWER chat filter: viewerAuth -> Set<targetAuth> of
// players that viewer no longer sees chat from. Persisted (requested
// 2026-08-16: survive a restart) — nobody else's view is affected, enforced
// in events/activity.js's onPlayerChat by skipping delivery to viewers who
// silenced this speaker, never by blocking the message itself.
const silencedAuths = new Map();
for (const { viewerAuth, targetAuth } of await db.getAllSilencedPairs()) {
    if (!silencedAuths.has(viewerAuth)) silencedAuths.set(viewerAuth, new Set());
    silencedAuths.get(viewerAuth).add(targetAuth);
}

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

// !votepause (see core/pauseVote.js) — pauseVotes holds the in-progress
// vote per team (null when none), pauseVoteUsed tracks each team's
// once-per-match allowance; both reset on every onGameStart.
state.pauseVotes = { [Team.RED]: null, [Team.BLUE]: null };
state.pauseVoteUsed = { [Team.RED]: false, [Team.BLUE]: false };
state.pauseVoteUnpauseTimeout = undefined;

// !tip #<id> (see commands/player.js's tipCommand) — once-per-match
// allowance per auth, reset every onGameStart alongside pauseVoteUsed
// above (same convention).
state.tipUsedThisMatch = new Set();

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
    muteByAuth,
    unmuteByAuth,
    warnCommand,
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
    Role,
    announcementColor,
    errorColor,
    warningColor,
    HaxNotification,
    hiddenAdminsSet,
    instantRestart,
    swapButton,
    getRole,
});

// Reaches into __roomBridge (defined earlier, before createAdminCommands
// existed) same as grantVipByAuth below — lets the Discord process mute/
// unmute by auth (!muteauth/!unmuteauth, see discord.js) via
// page.evaluate() from the orchestrator, which has no direct room/state
// access of its own.
window.__roomBridge.muteByAuth = muteByAuth;
window.__roomBridge.unmuteByAuth = unmuteByAuth;

/* MASTER COMMANDS */

const createMasterCommands = require('../core/commands/master');
const {
    clearbansCommand,
    banListCommand,
    adminListCommand,
    setAdminCommand,
    removeAdminCommand,
    helperListCommand,
    setHelperCommand,
    removeHelperCommand,
    setVipCommand,
    removeVipCommand,
    vipListCommand,
    banAuthCommand,
    unbanAuthCommand,
    authBanListCommand,
    restrictCmdCommand,
    unrestrictCmdCommand,
    cmdRestrictionsCommand,
    playersListCommand,
    passwordCommand,
    grantVipByAuth,
    applyVipGrant,
    purgeExpiredVips,
} = createMasterCommands({
    room,
    state,
    authArray,
    db,
    masterList,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatBanRemaining,
    formatVipRemaining,
    discordBot,
});

// Reaches into __roomBridge (defined earlier, before createMasterCommands
// existed) now that grantVipByAuth is actually available — the orchestrator
// calls this via page.evaluate() when the Discord process reports a member
// getting the configured VIP role (see index.js's 'grantVip' handling and
// discordProcess.js/discord.js's guildMemberUpdate wiring).
window.__roomBridge.grantVipByAuth = grantVipByAuth;

// Proactive VIP-expiry sweep — purgeExpiredVips() also runs reactively at
// the top of every VIP command, but that alone would leave an expired VIP's
// Discord role sitting there indefinitely until someone next happens to run
// !setvip/!removevip/!vips. This is what actually makes role revocation
// "automatic" on expiry rather than just "eventually, if anyone asks".
const VIP_EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
    purgeExpiredVips().catch((err) => discordBot.sendLog(`⚠️ Не удалось проверить истекшие VIP: ${err.message}`));
}, VIP_EXPIRY_CHECK_INTERVAL_MS);

/* GAME FUNCTIONS */

// Fraction of the match's own time limit at which a still-intact clean
// sheet starts getting watched (item #14, requested 2026-08-17) — last
// 20% of regulation, same "getting genuinely tense" window the rest of
// this file's late-match handling already cares about.
const CLEAN_SHEET_WATCH_THRESHOLD = 0.8;

function checkTime() {
    const scores = room.getScores();
    if (state.game != undefined) state.game.scores = scores;
    // Live clean-sheet tension (item #14) — see utils.js's own
    // detectCleanSheetWatch for the actual decision logic (kept pure/
    // testable there); this just gates it to once per match and sends the
    // announcement.
    const cleanSheetTeam = detectCleanSheetWatch(scores, state.playSituation, state.cleanSheetWatchAnnounced, CLEAN_SHEET_WATCH_THRESHOLD, Situation, Team);
    if (cleanSheetTeam != null) {
        state.cleanSheetWatchAnnounced = true;
        const teamName = cleanSheetTeam == Team.RED ? 'Красная команда' : 'Синяя команда';
        room.sendAnnouncement(
            `👀 Сухой тайм под угрозой — ${getTimeGame(scores.timeLimit - scores.time)} до конца, ${teamName} пока не пропустила !`,
            null,
            infoColor,
            'small',
            HaxNotification.CHAT
        );
    }
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
    // Real bug fixed here (found 2026-08-16 while porting this same streak
    // display to BFF): the streak counter only ever incremented on a RED
    // win and reset to a flat 1 on every BLUE win, regardless of whether
    // the SAME team had actually just won again — so a blue team on a real
    // 3-win streak displayed "Текущая серия: 1" for every one of those
    // wins, and a red win immediately after ANY blue win kept incrementing
    // from blue's stale count instead of restarting at 1. Compared against
    // state.streakWinner (its own SEPARATE tracking, see that field's own
    // comment), not state.lastWinner — captured BEFORE it's overwritten
    // below, so it still holds who won the last QUALIFYING match.
    const previousStreakWinner = state.streakWinner;
    const scores = room.getScores();
    state.game.scores = scores;
    state.lastWinner = winner;
    state.endGameVariable = true;
    // Streak only tracks genuine full 4v4 matches (requested 2026-08-18 —
    // easy to farm a fake win streak via quick, low-effort 1v1s otherwise).
    // Same "qualifying match" definition roomStats.js's own updateStats()
    // already uses for whether a match even counts towards games/wins/ELO
    // — a match too small to count for stats shouldn't count for the
    // streak either. A non-qualifying match's own winner is announced
    // normally, just without any streak text, and never touches
    // state.streak/state.streakWinner at all — so an odd 1v1 played
    // between two real 4v4s can't reset OR silently continue the streak.
    const isFullHouse = state.teamRedStats.length >= teamSize && state.teamBlueStats.length >= teamSize;
    // Blowout wording (requested 2026-08-21) — a 4+ goal final margin gets
    // called out distinctly from a routine win, same "worth a different
    // headline" reasoning as the comeback/rivalry storylines in
    // gameManagement.js. Draws can't blow out by definition, so this only
    // ever applies inside the RED/BLUE branches below.
    const isBlowout = Math.abs(scores.red - scores.blue) >= 4;
    // Winner/streak text folded into the post-match summary box below
    // (requested 2026-08-21) instead of its own separate announcement —
    // captured here since the streak bookkeeping stays exactly where it
    // was (still needs to happen synchronously, before anything below
    // could read a stale state.streak).
    let summaryColor = announcementColor;
    let winnerLine;
    if (winner == Team.RED) {
        let streakText = '';
        if (isFullHouse) {
            state.streak = previousStreakWinner === Team.RED ? state.streak + 1 : 1;
            state.streakWinner = Team.RED;
            streakText = ` ${formatStreakText(state.streak)}`;
        }
        winnerLine = isBlowout
            ? `🧹 Разгром! Красная команда размазала соперника ${scores.red} - ${scores.blue}${streakText}`
            : `✨ Красная команда выиграла${streakText}`;
        summaryColor = redColor;
    } else if (winner == Team.BLUE) {
        let streakText = '';
        if (isFullHouse) {
            state.streak = previousStreakWinner === Team.BLUE ? state.streak + 1 : 1;
            state.streakWinner = Team.BLUE;
            streakText = ` ${formatStreakText(state.streak)}`;
        }
        winnerLine = isBlowout
            ? `🧹 Разгром! Синяя команда размазала соперника ${scores.blue} - ${scores.red}${streakText}`
            : `✨ Синяя команда выиграла${streakText}`;
        summaryColor = blueColor;
    } else {
        if (isFullHouse) {
            state.streak = 0;
            state.streakWinner = Team.SPECTATORS;
        }
        winnerLine = '💤 Лимит ничьих достигнут !';
    }
    // Head-to-head recording + room-wide win-streak record (items #2/#10/
    // #11/#13, requested 2026-08-17) — see core/matchHistory.js's own doc
    // comments for what each does and why the logic lives there rather
    // than inline here (independent testability: this file is the
    // composition root, not an extracted, requireable core/ module).
    // Wrapped like updateStats()/awardMatchCoins() below: a failure here
    // must never block the rest of endGame().
    try {
        await recordHeadToHead(db, authArray, state.teamRed, state.teamBlue, winner, Team);
    } catch (err) {
        console.error('[endGame] recordHeadToHead failed:', err);
    }
    // isFullHouse-gated (see the streak block above's own comment) — a
    // non-qualifying match never touched state.streak, so checking it again
    // here would either be a harmless no-op or, worse, misattribute an
    // already-set record to whichever captain happened to win this
    // unrelated small match.
    if ((winner == Team.RED || winner == Team.BLUE) && isFullHouse) {
        try {
            const captain = winner == Team.RED ? state.teamRed[0] : state.teamBlue[0];
            await checkWinStreakRecord(db, room, HaxNotification, achievementColor, authArray, captain, state.streak, buildBox);
        } catch (err) {
            console.error('[endGame] win-streak record check failed:', err);
        }
    }
    let possessionRedPct = (state.possession[0] / (state.possession[0] + state.possession[1])) * 100;
    // Dot bar instead of "55% - 45%" (requested 2026-08-21) — reads at a
    // glance rather than requiring the reader to compare two numbers.
    // Anchored to red's share only: the ● run visually IS red's slice,
    // the ○ run IS blue's. No percentage alongside it either (dropped
    // 2026-08-21 — pairing a number with the bar just made the reader
    // check whether it agreed with what they were already seeing instead
    // of trusting the bar itself).
    const possessionFilled = Math.round(possessionRedPct / 10);
    const possessionBar = '●'.repeat(possessionFilled) + '○'.repeat(10 - possessionFilled);
    let possessionString = `🔴 ${possessionBar} 🔵`;
    // Post-match summary box (requested 2026-08-21, matching a style seen
    // on another server) — replaces what used to be 4 separate
    // announcements (winner+streak / possession+action-zone / clean sheet
    // / MVP, added 2026-08-18 for visual hierarchy) with one consolidated
    // box. buildBox (core/utils.js) computes the border from actual
    // content width, same helper the live goal announcement uses — no
    // small-caps for the Russian labels, same reasoning as the goal box
    // (incomplete Cyrillic coverage in Unicode's small-caps block).
    // Action-zone dropped from the display (was in the old small-print
    // line) to keep the box to what the reference format itself shows —
    // still tracked in state.actionZoneHalf either way, just not surfaced
    // here anymore.
    const summaryLines = [
        winnerLine,
        `🔴 ${scores.red} - ${scores.blue} 🔵 ┊ ${getTimeGame(scores.time).slice(1, -1)} ┊ Владение ${possessionString}`,
    ];
    if (getCS(scores).length > 0) {
        summaryLines.push(getCSString(scores));
    }
    // 28-metric advanced analytics (see core/stats/analytics/, !rating) —
    // independent of updateStats()'s quals-only gate, runs for every match
    // that reaches endGame() regardless of team size. Now runs BEFORE
    // updateStats() (requested 2026-08-17: feed the per-match rating into
    // ELO) — updateStats() needs this match's ratings to individually
    // differentiate each player's ELO delta, so it has to have them in hand
    // already. matchRatingsByAuth stays an empty Map (roomStats.js's own
    // per-player fallback) if this block fails, so a detector bug degrades
    // ELO back to the old flat-per-team behavior instead of blocking it.
    let matchRatingsByAuth = new Map();
    try {
        const analyticsReports = await analyzeMatch();
        matchRatingsByAuth = new Map(analyticsReports.map((r) => [r.auth, r.rating]));
        // MVP by rating (requested 2026-08-17) — same scope as the
        // analytics run itself (every match that reaches here, not gated to
        // full 4v4 quals like updateStats()). Ties broken by whoever sorts
        // first — genuinely rare (rating is rounded to 1 decimal from a
        // continuous z-score) and not worth a tiebreak rule of its own.
        if (analyticsReports.length > 0) {
            const mvp = analyticsReports.reduce((best, r) => (r.rating > best.rating ? r : best));
            summaryLines.push(`⭐ MVP: ${mvp.playerName} (${mvp.rating.toFixed(1)}/10)`);
        }
    } catch (err) {
        console.error('[endGame] analyzeMatch failed:', err);
        discordBot.sendLog(`⚠️ Не удалось посчитать продвинутую статистику: ${err.message}`);
    }
    // Per-player goal/assist recap (requested 2026-08-21) — tallied from
    // this match's own state.game.goals. Originally one line per
    // contributor (icons repeated per occurrence), but that meant up to 8
    // lines in a full house where everyone touches a goal — collapsed
    // 2026-08-21 into one line per TEAM instead, "Name (NГ+NА)" per
    // contributor, comma-joined, so the box height stays bounded regardless
    // of roster size.
    const contributionsById = new Map();
    for (const goal of state.game.goals) {
        if (goal.striker != null) {
            const entry = contributionsById.get(goal.striker.id) ?? { name: goal.striker.name, goals: 0, assists: 0 };
            entry.goals++;
            contributionsById.set(goal.striker.id, entry);
        }
        if (goal.assist != null) {
            const entry = contributionsById.get(goal.assist.id) ?? { name: goal.assist.name, goals: 0, assists: 0 };
            entry.assists++;
            contributionsById.set(goal.assist.id, entry);
        }
    }
    // Grouped by final-roster team membership (state.teamRed/teamBlue),
    // not the live goal.striker.team — those are mutable player references
    // that can drift from what they were at the moment of the goal (see
    // state-object doc comments elsewhere in this file) if a player later
    // switches sides. A contributor who left mid-match and isn't on either
    // final roster is silently dropped from the recap — the same "final
    // state, not blow-by-blow history" scope the rest of this box uses.
    const redIds = new Set(state.teamRed.map((p) => p.id));
    const blueIds = new Set(state.teamBlue.map((p) => p.id));
    const redParts = [];
    const blueParts = [];
    for (const [id, entry] of contributionsById) {
        const counts = [];
        if (entry.goals > 0) counts.push(`${entry.goals}Г`);
        if (entry.assists > 0) counts.push(`${entry.assists}А`);
        const label = `${entry.name} (${counts.join('+')})`;
        if (redIds.has(id)) redParts.push(label);
        else if (blueIds.has(id)) blueParts.push(label);
    }
    if (redParts.length > 0) summaryLines.push(`🔴 ${redParts.join(', ')}`);
    if (blueParts.length > 0) summaryLines.push(`🔵 ${blueParts.join(', ')}`);
    room.sendAnnouncement(
        buildBox(summaryLines, 'ИТОГИ МАТЧА'),
        null,
        summaryColor,
        'bold',
        HaxNotification.MENTION
    );
    try {
        await updateStats(matchRatingsByAuth);
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
    try {
        await resolveBets(winner);
    } catch (err) {
        console.error('[endGame] resolveBets failed:', err);
        discordBot.sendLog(`⚠️ Не удалось рассчитать ставки: ${err.message}`);
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
    resolveNextCaptainId,
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

/* BETTING */

// Spectator betting on match outcome, open only during the pre-match
// captain-swap window right below — see core/betting.js.
const createBettingSystem = require('../core/betting');
const {
    betCommand,
    announceOdds,
    refundIfSubbedIn: refundBetIfSubbedIn,
    resolveBets,
} = createBettingSystem({
    room,
    state,
    authArray,
    db,
    Team,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatCoins,
});

/* SWAP FUNCTIONS */

const createSwapHelpers = require('../core/team/swap');
const {
    startSwapPhase,
    cancelSwapPhase,
    swapModeFunction,
} = createSwapHelpers({
    room,
    state,
    Team,
    HaxNotification,
    announcementColor,
    errorColor,
    infoColor,
    swapTime,
    announceOdds,
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
    if (state.helperList.some((h) => h[0] == auth)) return Role.HELPER;
    if (state.adminList.some((a) => a[0] == auth)) return Role.ADMIN_PERM;
    if (player.admin) return Role.ADMIN_TEMP;
    // Checked live rather than trusting the cache alone — a time-limited
    // grant (v[2], see !setvip) can expire mid-session, and this is the
    // only place that runs on every single message. Expired entries are
    // actually purged from state.vipList/the db lazily, by the next VIP
    // command that runs (see purgeExpiredVips in commands/master.js), not
    // here — this check just makes sure nobody gets an extra few hours/days
    // of VIP because nobody happened to run one in the meantime.
    if (state.vipList.some((v) => v[0] == auth && (v[2] == null || new Date(v[2]).getTime() > Date.now()))) return Role.VIP;
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

/* MATCH ANALYTICS FUNCTIONS */

// 28-metric per-match player analytics (see core/stats/analytics/'s own doc
// comments) — main room only, same scope as ELO/!tip. Wired here (after GK
// FUNCTIONS, which is where getGK comes from) rather than earlier: needed by
// its own ShotQualityModel/SweeperDetector detectors internally.
const createMatchAnalytics = require('../core/stats/analytics');
const {
    reset: resetMatchAnalytics,
    recordTick: recordMatchAnalyticsTick,
    analyzeMatch,
} = createMatchAnalytics({
    room,
    state,
    Team,
    State,
    Situation,
    db,
    authArray,
    pointDistance,
    getGK,
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
    buildBox,
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
    printAllRankings,
    printClubRankings,
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
    announcementColor,
    achievementColor,
    successColor,
    warningColor,
    teamSize,
    getAssistsPlayer,
    getCSPlayer,
    getGametimePlayer,
    getGoalsPlayer,
    getOwnGoalsPlayer,
    getPlayerComp,
    getTimeStats,
    applyVipGrant,
    random: Math.random,
    buildBox,
});

/* PRINT FUNCTIONS */

const createPrintStats = require('../core/stats/print');
const {
    printPlayerStats,
} = createPrintStats({
    getTimeStats,
    db,
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
    db,
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
    resolveNextCaptainId,
    stadiumCommand,
    swapButton,
    topButton,
    startSwapPhase,
    cancelSwapPhase,
});

/* PLAYER COMMANDS */

// Wired after TEAM BALANCE FUNCTIONS: afkCommand calls handlePlayersJoin/
// handlePlayersLeave, which only exist once that factory has run.
const createPlayerCommands = require('../core/commands/player');
const {
    leaveCommand,
    helpCommand,
    globalStatsCommand,
    vsCommand,
    tipCommand,
    ratingCommand,
    renameCommand,
    customColorsCommand,
    vipColorCommand,
    vipHideCommand,
    vipHelpCommand,
    linkDiscordCommand,
    topsCommand,
    afkCommand,
    jjCommand,
    afkListCommand,
    silenceCommand,
    reportCommand,
    upCommand,
} = createPlayerCommands({
    room,
    state,
    Team,
    State,
    Role,
    HaxStatistics,
    authArray,
    db,
    AFKSet,
    AFKMinSet,
    AFKCooldownSet,
    minAFKDuration,
    maxAFKDuration,
    maxAFKDurationVip,
    maxAFKCount,
    AFKCooldown,
    silencedAuths,
    hiddenVipSet,
    announcementColor,
    errorColor,
    infoColor,
    successColor,
    achievementColor,
    warningColor,
    vipChatColor,
    adminChatColor,
    masterChatColor,
    HaxNotification,
    getCommand,
    getRole,
    handlePlayersJoin,
    handlePlayersLeave,
    printPlayerStats,
    getTimeStats,
    printRankings,
    printAllRankings,
    printClubRankings,
    updateTeams,
    getCommands: () => commands,
    formatCoins,
    discordBot,
    formatBanRemaining,
    renderProgressBar,
});

/* PAUSE VOTE */

const createPauseVote = require('../core/pauseVote');
const { votepauseCommand, handleVoteMessage, resetPauseVotes } = createPauseVote({
    room,
    state,
    Team,
    State,
    Situation,
    HaxNotification,
    errorColor,
    warningColor,
    successColor,
    redColor,
    blueColor,
    teamSize,
});

/* VOTE BAN */

const createVoteBan = require('../core/voteBan');
const { votebanCommand, handleVoteBanMessage } = createVoteBan({
    room,
    state,
    authArray,
    db,
    Role,
    getRole,
    HaxNotification,
    errorColor,
    warningColor,
    successColor,
    announcementColor,
    discordBot,
    formatBanRemaining,
    renderProgressBar,
});

/* CLUBS */

const createClubCommands = require('../core/commands/club');
const { clubCommand, clubChatCommand } = createClubCommands({
    room,
    state,
    authArray,
    db,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatCoins,
});

/* TROPHIES */

const createTrophyCommands = require('../core/commands/trophies');
const { trophiesCommand } = createTrophyCommands({
    room,
    state,
    authArray,
    db,
    Trophies,
    formatTrophyLabel,
    encodeLegacyTrophyKey,
    resolveTrophyRank,
    announcementColor,
    errorColor,
    HaxNotification,
});

/* MINIGAMES */

const createBlackjackCommands = require('../core/commands/blackjack');
const {
    runPvpBlackjack,
    hitCommand,
    standCommand,
    forfeitOnLeave: forfeitBlackjackOnLeave,
} = createBlackjackCommands({
    room,
    state,
    db,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatCoins,
    getRandomInt,
});

const createPokerCommands = require('../core/commands/poker');
const {
    runPokerPvp,
    joinOpenTable: pokerJoinOpenTable,
    isSeated: pokerIsSeated,
    // Renamed on the way out — core/betting.js's own (currently disabled,
    // see commands.js) spectator match-betting feature already claimed the
    // plain `betCommand` name earlier in this file. Only ONE of the two
    // can ever actually be registered as "!bet" at a time (see
    // commands.js's own commented-out `bet:` entry) — poker's is the live
    // one below.
    betCommand: pokerBetCommand,
    callCommand,
    checkCommand,
    passCommand,
    leaveTableCommand,
    tablePlayersCommand,
    forfeitOnLeave: forfeitPokerOnLeave,
    forfeitOnTeamChange: forfeitPokerOnTeamChange,
} = createPokerCommands({
    room,
    state,
    db,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatCoins,
    getRandomInt,
});

const createMinigameCommands = require('../core/commands/minigames');
const { minigamesCommand, playCommand } = createMinigameCommands({
    room,
    state,
    authArray,
    db,
    Team,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatCoins,
    getRandomInt,
    runPvpBlackjack,
    runPokerPvp,
    pokerJoinOpenTable,
    pokerIsSeated,
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
    vsCommand,
    tipCommand,
    ratingCommand,
    renameCommand,
    customColorsCommand,
    vipColorCommand,
    vipHideCommand,
    vipHelpCommand,
    linkDiscordCommand,
    linkTelegramCommand,
    topsCommand,
    afkCommand,
    afkListCommand,
    silenceCommand,
    restartCommand,
    restartSwapCommand,
    swapCommand,
    kickTeamCommand,
    stadiumCommand,
    muteCommand,
    unmuteCommand,
    muteListCommand,
    hideCommand,
    warnCommand,
    clearbansCommand,
    banListCommand,
    adminListCommand,
    setAdminCommand,
    removeAdminCommand,
    helperListCommand,
    setHelperCommand,
    removeHelperCommand,
    setVipCommand,
    removeVipCommand,
    vipListCommand,
    banAuthCommand,
    unbanAuthCommand,
    authBanListCommand,
    restrictCmdCommand,
    unrestrictCmdCommand,
    cmdRestrictionsCommand,
    playersListCommand,
    passwordCommand,
    teamChat,
    shopCommand,
    inventoryCommand,
    equipCommand,
    addCoinsCommand,
    giftCoinsCommand,
    balanceCommand,
    clubCommand,
    clubChatCommand,
    trophiesCommand,
    votepauseCommand,
    votebanCommand,
    reportCommand,
    upCommand,
    minigamesCommand,
    playCommand,
    hitCommand,
    standCommand,
    // The live "!bet" — poker's, not core/betting.js's own disabled one
    // (see the rename comment above pokerBetCommand's own destructure).
    betCommand: pokerBetCommand,
    callCommand,
    checkCommand,
    passCommand,
    leaveTableCommand,
    tablePlayersCommand,
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
    AFKMinSet,
    AFKCooldownSet,
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
    buildBox,
    applyTeamForms,
    claimDailyBonus,
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
    refundBetIfSubbedIn,
    forfeitBlackjackOnLeave,
    forfeitPokerOnLeave,
    forfeitPokerOnTeamChange,
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
    Trophies,
    adminChatColor,
    helperChatColor,
    commands,
    discordBot,
    errorColor,
    hiddenAdminsSet,
    hiddenVipSet,
    masterChatColor,
    mentionWatchName,
    MutePlayer,
    muteArray,
    silencedAuths,
    vipChatColor,
    checkGoalKickTouch,
    chooseModeFunction,
    swapModeFunction,
    formatBanRemaining,
    formatTrophyLabel,
    resolveTrophyRank,
    getCommand,
    getDate,
    getGoalGame,
    getPlayerComp,
    getRole,
    handleVoteMessage,
    handleVoteBanMessage,
    jjCommand,
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
    resetPauseVotes,
    updateTeams,
    achievementColor,
    infoColor,
    authArray,
    db,
    buildBox,
    resetMatchAnalytics,
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
    recordMatchAnalyticsTick,
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
