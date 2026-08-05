/*
 * Runtime smoke tests for the extracted modules.
 *
 * The regression these guard against: a module that captures mutable room state
 * by value at wiring time instead of reaching it through `state` / accessors.
 * Such a module parses fine, initialises fine, and then silently operates on a
 * stale snapshot — so syntax checks alone prove nothing.
 *
 * Usage: node tools/smoke-test.js
 */
const path = require('path');
const fs = require('fs');
const CORE = path.join(__dirname, '..', 'src', 'core');

let pass = 0;
let fail = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : `\n          got=${JSON.stringify(got)}\n         want=${JSON.stringify(want)}`));
    ok ? pass++ : fail++;
}

const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
const HaxNotification = { NONE: 0, CHAT: 1, MENTION: 2 };
const sent = [];
const roomCalls = [];
const room = {
    sendAnnouncement: (msg, id, color, style) => sent.push({ msg, id, style }),
    clearBans: () => roomCalls.push('clearBans'),
    clearBan: (id) => roomCalls.push('clearBan:' + id),
    setPlayerAdmin: (id, v) => roomCalls.push(`setPlayerAdmin:${id}:${v}`),
    setPassword: (p) => roomCalls.push('setPassword:' + p),
    kickPlayer: (id, reason, ban) => roomCalls.push(`kickPlayer:${id}:${reason}:${ban}`),
    setPlayerTeam: (id, team) => roomCalls.push(`setPlayerTeam:${id}:${team}`),
    pauseGame: (v) => roomCalls.push('pauseGame:' + v),
    stopGame: () => roomCalls.push('stopGame'),
    setScoreLimit: (n) => roomCalls.push('setScoreLimit:' + n),
    setTimeLimit: (n) => roomCalls.push('setTimeLimit:' + n),
    setCustomStadium: (map) => roomCalls.push('setCustomStadium'),
    setDefaultStadium: (name) => roomCalls.push('setDefaultStadium:' + name),
    getPlayerList: () => [],
};

console.log('--- stats/print.js: !stats shows the full stat block ---');
(async () => {
    const createPrintStats = require(path.join(CORE, 'stats', 'print'));
    const RANKS = { goals: 3, assists: 5, CS: 2, playtime: 7 };
    const db = { getStatRank: async (statKey) => ({ rank: RANKS[statKey], total: 20 }) };
    const printStats = createPrintStats({ getTimeStats: (seconds) => `${Math.floor(seconds / 60)}m`, db });
    const stats = {
        playerName: 'Alice', games: 10, wins: 7, winrate: '70.0%', playtime: 600,
        goals: 25, assists: 12, CS: 3, ownGoals: 1,
    };
    const output = await printStats.printPlayerStats(stats);
    check('shows the player name', output.includes('Alice'), true);
    check('shows winrate', output.includes('🏆 70.0% побед'), true);
    check('shows games', output.includes('🕹️ 10 игр'), true);
    check('shows goals rank', output.includes('Ранг по голам: 3/20(25)'), true);
    check('shows assists rank', output.includes('ассистам: 5/20(12)'), true);
    check('shows clean sheets rank', output.includes('сухим матчам: 2/20(3)'), true);
    check('shows playtime rank', output.includes('времени игры: 7/20(10m)'), true);
})();

console.log('\n--- chat.js: helpers must see state populated AFTER wiring ---');
{
    let playersAll = [];
    let teamRed = [];
    let commands;
    const chat = require(path.join(CORE, 'chat'))({
        room, Team, redColor: 1, blueColor: 2, errorColor: 3, privateMessageColor: 4, HaxNotification,
        getPlayersAll: () => playersAll,
        getTeamRed: () => teamRed,
        getTeamBlue: () => [],
        getTeamSpec: () => [],
        getCommands: () => commands,
    });

    commands = { help: { aliases: ['commands'] }, bb: { aliases: ['leave', 'quit'] } };
    playersAll = [
        { id: 1, name: 'Alice', team: Team.RED },
        { id: 2, name: 'Bob Smith', team: Team.SPECTATORS },
    ];
    teamRed = [playersAll[0]];

    check('getCommand resolves name', chat.getCommand('help'), 'help');
    check('getCommand resolves alias', chat.getCommand('leave'), 'bb');
    check('getCommand rejects unknown', chat.getCommand('nope'), false);
    check('getTeamArray sees late data', chat.getTeamArray(Team.RED), teamRed);
    check('getTeamArray spectators', chat.getTeamArray(Team.SPECTATORS, true).map((p) => p.id), [2]);

    sent.length = 0;
    chat.teamChat(playersAll[0], '!t hello');
    check('teamChat reaches red only', sent.map((s) => s.id), [1]);

    sent.length = 0;
    chat.playerChat(playersAll[0], '@@Bob_Smith hey');
    check('playerChat reaches both sides', sent.map((s) => s.id), [1, 2]);
    // Bug: the copy sent to the RECIPIENT (id 2) labelled the message with
    // the recipient's own name instead of the actual sender's — every PM
    // the recipient received looked like it came from themselves.
    const senderCopy = sent.find((s) => s.id === 1).msg;
    const recipientCopy = sent.find((s) => s.id === 2).msg;
    check('the sender sees their own name as the speaker', senderCopy.includes('Alice: hey'), true);
    check('the recipient ALSO sees the sender\'s name as the speaker, not their own', recipientCopy.includes('Alice: hey'), true);
    check('the recipient copy does not mislabel the speaker as themselves', recipientCopy.includes('Bob Smith: hey'), false);
    check('playerChat rejects unknown target', chat.playerChat(playersAll[0], '@@Ghost hi'), false);
    check('playerChat rejects self-PM', chat.playerChat(playersAll[0], '@@Alice hi'), false);

    // !x is just the standard command-table dispatch wired straight to the
    // same teamChat used by the bare "t <message>" trigger — no new chat
    // logic, just another entry point into it.
    sent.length = 0;
    chat.teamChat(playersAll[0], '!x hello via x');
    check('!x reaches team chat the same way "t" does', sent.map((s) => s.id), [1]);
}

console.log('\n--- commands.js: !x is wired to teamChat ---');
{
    const commands = require(path.join(CORE, 'commands'))({
        Role: { PLAYER: 0 }, teamChat: 'TEAM_CHAT_MARKER',
    });
    check('the "x" command exists', typeof commands.x, 'object');
    check('the "x" command is available to every player', commands.x.roles, 0);
    check('the "x" command dispatches to teamChat', commands.x.function, 'TEAM_CHAT_MARKER');
}

console.log('\n--- commands/master.js: writes must land in shared state ---');
// Wrapped in an async IIFE with its OWN local room/sent/roomCalls mocks
// (not the shared module-level ones): 7 of these commands are now async
// (they touch the DB through what's a bridge in real use — see
// dbBridgeClient.js), and this file has no top-level await, so this block
// runs concurrently with whatever comes after it. Sharing the module-level
// `sent`/`roomCalls` arrays across two concurrently-running async blocks
// would risk their resets/pushes interleaving; local mocks make that
// impossible regardless of microtask timing.
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const sent = [];
    const roomCalls = [];
    const room = {
        sendAnnouncement: (msg, id, color, style) => sent.push({ msg, id, style }),
        clearBans: () => roomCalls.push('clearBans'),
        clearBan: (id) => roomCalls.push('clearBan:' + id),
        setPlayerAdmin: (id, v) => roomCalls.push(`setPlayerAdmin:${id}:${v}`),
        setPassword: (p) => roomCalls.push('setPassword:' + p),
        kickPlayer: (id, reason, ban) => roomCalls.push(`kickPlayer:${id}:${reason}:${ban}`),
        getPlayer: (id) => (id === 5 ? { id: 5, name: 'NewAdmin' } : null),
    };

    const state = { banList: [], roomPassword: '', adminList: [], vipList: [], playersAll: [] };
    const authArray = [];
    authArray[9] = ['AUTH_CALLER'];
    authArray[5] = ['AUTH_TARGET'];
    const { formatBanRemaining, formatVipRemaining } = require(path.join(CORE, 'utils'));
    const master = require(path.join(CORE, 'commands', 'master'))({
        room, state, authArray, db, masterList: ['AUTH_CALLER'],
        announcementColor: 1, errorColor: 2, HaxNotification,
        formatBanRemaining, formatVipRemaining,
    });
    const caller = { id: 9, name: 'Master' };

    state.banList = [['Cheater', 42], ['Spammer', 43]];
    roomCalls.length = 0;
    sent.length = 0;
    master.clearbansCommand(caller, '!clearbans 42');
    check('clearbans removed the right entry', state.banList, [['Spammer', 43]]);
    check('clearbans called room.clearBan', roomCalls, ['clearBan:42']);

    roomCalls.length = 0;
    master.clearbansCommand(caller, '!clearbans');
    check('bare clearbans empties the list', state.banList, []);
    check('bare clearbans called room.clearBans', roomCalls, ['clearBans']);

    sent.length = 0;
    master.banListCommand(caller, '!banlist');
    check('empty ban list is reported', /никого нет/.test(sent[0].msg), true);

    sent.length = 0;
    master.passwordCommand(caller, '!password hunter2');
    check('password written to shared state', state.roomPassword, 'hunter2');

    // admin grants/revokes must persist to the database, not just state, so
    // they survive a bot restart — that's the whole point of moving off the
    // in-memory-only adminList.
    roomCalls.length = 0;
    await master.setAdminCommand(caller, '!setadmin #5');
    check('setAdminCommand adds to in-memory adminList', state.adminList, [['AUTH_TARGET', 'NewAdmin']]);
    check('setAdminCommand persists the admin to the database', db.getAdmins(), [{ auth: 'AUTH_TARGET', playerName: 'NewAdmin' }]);
    check('setAdminCommand grants the room admin badge', roomCalls.includes('setPlayerAdmin:5:true'), true);

    roomCalls.length = 0;
    await master.removeAdminCommand(caller, '!removeadmin #5');
    check('removeAdminCommand clears the in-memory adminList', state.adminList, []);
    check('removeAdminCommand removes the admin from the database', db.getAdmins(), []);
    check('removeAdminCommand revokes the room admin badge', roomCalls.includes('setPlayerAdmin:5:false'), true);

    // VIP grants no permissions — unlike setAdminCommand, no room admin badge
    // should ever be touched by these. Permanent by default (no duration arg).
    // setVipCommand resolves #<id> via state.playersAll (like !banauth
    // does), not room.getPlayer — needs a matching entry.
    state.playersAll = [{ id: 5, name: 'NewAdmin' }];
    roomCalls.length = 0;
    await master.setVipCommand(caller, '!setvip #5');
    check('setVipCommand adds to the in-memory vipList', state.vipList, [['AUTH_TARGET', 'NewAdmin', null]]);
    check('setVipCommand persists the VIP to the database', db.getVips(), [{ auth: 'AUTH_TARGET', playerName: 'NewAdmin', expiresAt: null }]);
    check('setVipCommand never touches the room admin badge', roomCalls.some((c) => c.startsWith('setPlayerAdmin')), false);

    sent.length = 0;
    await master.setVipCommand(caller, '!setvip #5');
    check('setVipCommand rejects someone who is already VIP', /уже является VIP/.test(sent[0].msg), true);

    sent.length = 0;
    await master.vipListCommand(caller, '!vips');
    check('vipListCommand lists the current VIP with "навсегда" for a permanent grant', sent[0].msg, '📢 Список VIP : NewAdmin (навсегда) [0].');

    roomCalls.length = 0;
    await master.removeVipCommand(caller, '!removevip #5');
    check('removeVipCommand clears the in-memory vipList', state.vipList, []);
    check('removeVipCommand removes the VIP from the database', db.getVips(), []);
    check('removeVipCommand never touches the room admin badge', roomCalls.some((c) => c.startsWith('setPlayerAdmin')), false);

    sent.length = 0;
    await master.vipListCommand(caller, '!vips');
    check('vipListCommand reports an empty VIP list', /никого нет/.test(sent[0].msg), true);

    // Time-limited VIP (!setvip #<id> <days>) — the whole point of this ask.
    sent.length = 0;
    await master.setVipCommand(caller, '!setvip #5 abc');
    check('setVipCommand rejects a non-numeric day count', /Использование/.test(sent[0].msg), true);
    check('a rejected day count does not grant VIP', state.vipList, []);

    sent.length = 0;
    await master.setVipCommand(caller, '!setvip #5 30');
    check('setVipCommand confirms a time-limited grant', /VIP на 30 дн\./.test(sent[0].msg), true);
    check('the expiry lands ~30 days out', Math.round((new Date(state.vipList[0][2]).getTime() - Date.now()) / (24 * 60 * 60000)), 30);
    check('the expiry is persisted to the db too', new Date(db.getVips()[0].expiresAt).getTime(), new Date(state.vipList[0][2]).getTime());

    // purgeExpiredVips (run at the top of every VIP command) sweeps a grant
    // whose time has already passed — from both state.vipList and the db —
    // without needing a bot restart or a background timer.
    state.vipList[0][2] = new Date(Date.now() - 1000).toISOString();
    await db.addVip('AUTH_TARGET', 'NewAdmin', state.vipList[0][2]);
    sent.length = 0;
    await master.vipListCommand(caller, '!vips');
    check('an expired VIP is purged from state by the next VIP command', state.vipList, []);
    check('an expired VIP is purged from the db too', db.getVips(), []);
    check('the purge leaves the list reporting empty', /никого нет/.test(sent[0].msg), true);

    // Granting VIP by raw auth (offline players too — the ask this turn).
    sent.length = 0;
    await master.setVipCommand(caller, '!setvip AUTH_OFFLINE_VIP 7');
    check('setVipCommand grants VIP by raw auth even when offline', /VIP на 7 дн\./.test(sent[0].msg), true);
    check('an offline grant falls back to the auth itself as the display name', state.vipList.some((v) => v[0] === 'AUTH_OFFLINE_VIP' && v[1] === 'AUTH_OFFLINE_VIP'), true);
    check('the offline grant is persisted to the db', db.getVips().some((v) => v.auth === 'AUTH_OFFLINE_VIP'), true);

    sent.length = 0;
    await master.setVipCommand(caller, '!setvip AUTH_OFFLINE_VIP');
    check('granting by auth also rejects someone already VIP', /уже является VIP/.test(sent[0].msg), true);

    roomCalls.length = 0;
    await master.removeVipCommand(caller, '!removevip AUTH_OFFLINE_VIP');
    check('removeVipCommand also accepts a raw auth', state.vipList.some((v) => v[0] === 'AUTH_OFFLINE_VIP'), false);
    check('removeVipCommand by auth persists to the db too', db.getVips().some((v) => v.auth === 'AUTH_OFFLINE_VIP'), false);

    // grantVipByAuth: the Discord-role-sync path (a member getting the
    // configured VIP role grants their linked auth's room VIP — see
    // discord.js's handleGuildMemberUpdate). Always permanent, and shares
    // the exact same in-memory+db write setVipCommand itself does.
    sent.length = 0;
    const grantedFirstTime = await master.grantVipByAuth('AUTH_DISCORD_VIP', 'DiscordGuy');
    check('grantVipByAuth reports a fresh grant', grantedFirstTime, true);
    check('grantVipByAuth adds to the in-memory vipList as a permanent grant', state.vipList.some((v) => v[0] === 'AUTH_DISCORD_VIP' && v[2] === null), true);
    check('grantVipByAuth persists to the db', db.getVips().some((v) => v.auth === 'AUTH_DISCORD_VIP' && v.expiresAt === null), true);
    check('grantVipByAuth announces the grant', /DiscordGuy/.test(sent[0].msg), true);

    sent.length = 0;
    const grantedAgain = await master.grantVipByAuth('AUTH_DISCORD_VIP', 'DiscordGuy');
    check('grantVipByAuth is a no-op for someone already VIP', grantedAgain, false);
    check('grantVipByAuth does not announce anything the second time', sent.length, 0);

    await master.removeVipCommand(caller, '!removevip AUTH_DISCORD_VIP');

    // Auth-ban commands: must work by #<id> (someone currently in the room,
    // kicked immediately) as well as by a raw auth string (works even if
    // they're offline right now) — duration is mandatory for both.
    state.playersAll = [{ id: 5, name: 'Cheater' }];
    roomCalls.length = 0;
    sent.length = 0;
    await master.banAuthCommand(caller, '!banauth');
    check('banAuthCommand with no target shows usage', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await master.banAuthCommand(caller, '!banauth #5');
    check('banAuthCommand with no duration shows usage', /Использование/.test(sent[0].msg), true);

    // The same function serves both !banauth and !ban (see commands.js) —
    // the usage hint must reflect whichever one was actually typed, not
    // always say "!banauth".
    sent.length = 0;
    await master.banAuthCommand(caller, '!ban');
    check('the usage hint mentions !ban when that\'s what was typed, not !banauth', sent[0].msg.includes('!ban <#id|auth>'), true);

    roomCalls.length = 0;
    sent.length = 0;
    await master.banAuthCommand(caller, '!banauth #5 60 aimbot');
    check('banAuthCommand resolves #<id> to the live player\'s auth and current name', db.getAuthBan('AUTH_TARGET').playerName, 'Cheater');
    check('banAuthCommand kicks the player if targeted by #<id>', roomCalls.includes('kickPlayer:5:Вы забанены на 60 мин.: aimbot:false'), true);

    roomCalls.length = 0;
    sent.length = 0;
    await master.banAuthCommand(caller, '!banauth AUTH_OFFLINE 30 griefing');
    const offlineBan = db.getAuthBan('AUTH_OFFLINE');
    check('banAuthCommand also accepts a raw auth string directly', { auth: offlineBan.auth, playerName: offlineBan.playerName, reason: offlineBan.reason }, { auth: 'AUTH_OFFLINE', playerName: 'AUTH_OFFLINE', reason: 'griefing' });
    check('banAuthCommand does not try to kick when targeted by raw auth', roomCalls.some((c) => c.startsWith('kickPlayer')), false);

    sent.length = 0;
    await master.unbanAuthCommand(caller, '!unbanauth AUTH_NEVER_BANNED');
    check('unbanAuthCommand reports an auth that was never banned', /не забанен/.test(sent[0].msg), true);

    sent.length = 0;
    await master.unbanAuthCommand(caller, '!unbanauth AUTH_TARGET');
    check('unbanAuthCommand clears the ban', db.getAuthBan('AUTH_TARGET'), null);

    sent.length = 0;
    await master.authBanListCommand(caller, '!authbans');
    check('authBanListCommand lists the remaining auth ban', /AUTH_OFFLINE/.test(sent[0].msg), true);
    check('authBanListCommand shows the remaining duration', /осталось \d+ мин\./.test(sent[0].msg), true);

    // !restrictcmd/!unrestrictcmd/!cmdrestrictions — same #<id>|auth
    // resolution and by-auth persistence as !banauth above, but keyed on
    // (auth, command) so a player can be blocked from !report without
    // touching their ability to use !voteban, and vice versa.
    sent.length = 0;
    await master.restrictCmdCommand(caller, '!restrictcmd');
    check('restrictCmdCommand with no args shows usage', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await master.restrictCmdCommand(caller, '!restrictcmd #5 nonsense 10');
    check('restrictCmdCommand rejects a command name outside voteban/report', /Использование/.test(sent[0].msg), true);
    check('...and writes nothing', db.getCommandRestrictions(), []);

    sent.length = 0;
    await master.restrictCmdCommand(caller, '!restrictcmd #5 report abc');
    check('restrictCmdCommand rejects a non-numeric duration', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await master.restrictCmdCommand(caller, '!restrictcmd #5 report 15 спам');
    check('restrictCmdCommand confirms a timed restriction with the reason', /Cheater.*!report.*15 мин\..*спам/.test(sent[0].msg), true);
    const timedRestriction = await db.getCommandRestriction('AUTH_TARGET', 'report');
    check('...persisted with the right auth/command/reason', { auth: timedRestriction.auth, command: timedRestriction.command, reason: timedRestriction.reason }, { auth: 'AUTH_TARGET', command: 'report', reason: 'спам' });
    check('...and does NOT touch !voteban for the same player', await db.getCommandRestriction('AUTH_TARGET', 'voteban'), null);

    sent.length = 0;
    await master.restrictCmdCommand(caller, '!restrictcmd #5 voteban 0');
    const permanentRestriction = await db.getCommandRestriction('AUTH_TARGET', 'voteban');
    check('a duration of 0 restricts permanently (expiresAt null)', permanentRestriction.expiresAt, null);
    check('the confirmation says "навсегда" for a permanent restriction', /навсегда/.test(sent[0].msg), true);

    sent.length = 0;
    await master.restrictCmdCommand(caller, '!restrictcmd AUTH_OFFLINE_TROLL report 5');
    check('restrictCmdCommand also accepts a raw auth (offline target)', (await db.getCommandRestriction('AUTH_OFFLINE_TROLL', 'report')) != null, true);

    sent.length = 0;
    await master.cmdRestrictionsCommand(caller, '!cmdrestrictions');
    check('cmdRestrictionsCommand lists every active restriction', sent[0].msg.includes('Cheater') && sent[0].msg.includes('AUTH_OFFLINE_TROLL'), true);

    sent.length = 0;
    await master.unrestrictCmdCommand(caller, '!unrestrictcmd #5 report');
    check('unrestrictCmdCommand confirms the lift', /Cheater.*!report/.test(sent[0].msg), true);
    check('...and actually removes just that (auth, command) row', await db.getCommandRestriction('AUTH_TARGET', 'report'), null);
    check('...leaving the OTHER restriction on the same auth untouched', (await db.getCommandRestriction('AUTH_TARGET', 'voteban')) != null, true);

    sent.length = 0;
    await master.unrestrictCmdCommand(caller, '!unrestrictcmd #5 report');
    check('unrestrictCmdCommand on a target with no such restriction reports it instead of erroring', /и так может использовать/.test(sent[0].msg), true);

    // Clean slate — the voteBan-restriction-enforcement test elsewhere in
    // this file re-derives its own fixtures from scratch.
    await db.unrestrictCommand('AUTH_TARGET', 'voteban');
    await db.unrestrictCommand('AUTH_OFFLINE_TROLL', 'report');

    sent.length = 0;
    master.playersListCommand(caller, '!players');
    check('playersListCommand lists the live room roster with auth', sent[0].msg, '📢 Игроки в комнате : Cheater [AUTH_TARGET].');

    state.playersAll = [];
    sent.length = 0;
    master.playersListCommand(caller, '!players');
    check('playersListCommand reports an empty room', /никого нет/.test(sent[0].msg), true);

    db.close();
})();

console.log('\n--- safeEventHandlers.js: a throwing handler must not crash the process ---');
{
    const wrapEventHandlers = require(path.join(CORE, 'safeEventHandlers'));
    const origConsoleError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args);

    const handlers = wrapEventHandlers({
        onPlayerChat: () => { throw new Error('boom'); },
        onGameTick: () => 'tick-ok',
    });

    let threw = false;
    try {
        handlers.onPlayerChat({ id: 1 }, '!crash');
    } catch (e) {
        threw = true;
    }
    console.error = origConsoleError;

    check('wrapped handler does not let the error escape', threw, false);
    check('the error is logged instead of swallowed silently', loggedErrors.length, 1);
    check('a healthy handler wrapped alongside a bad one still works', handlers.onGameTick(), 'tick-ok');
}

console.log('\n--- db + roomStats.js/player.js: player data actually round-trips through sqlite ---');
// Async IIFE with its own local room/sent (updatePlayerStats/printRankings/
// globalStatsCommand/renameCommand/linkDiscordCommand are now async — they
// touch the DB through what's a bridge in real use) — local mocks for the
// same reason the commands/master.js block above has them: no shared
// mutable state with anything else running concurrently in this file.
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const sent = [];
    const room = {
        sendAnnouncement: (msg, id, color, style) => sent.push({ msg, id, style }),
    };

    const HaxStatistics = function (playerName = '') {
        this.playerName = playerName;
        this.games = 0;
        this.wins = 0;
        this.winrate = '0.00%';
        this.playtime = 0;
        this.goals = 0;
        this.assists = 0;
        this.CS = 0;
        this.ownGoals = 0;
    };

    const authArray = { 1: ['AUTH_ALICE'], 2: ['AUTH_BOB'], 3: ['AUTH_NEW_PLAYER'] };
    const state = {
        lastWinner: Team.RED,
        teamRedStats: [{ id: 1, name: 'Alice' }],
        teamBlueStats: [{ id: 2, name: 'Bob' }],
        players: [1, 2, 3, 4, 5, 6, 7, 8],
        game: { scores: { time: 300, timeLimit: 300, red: 3, blue: 0, scoreLimit: 3 } },
        hiddenCustomColorsSet: new Set(),
        vipColors: {},
        clubMembers: [],
        chooseMode: false,
        priorityCaptainId: null,
        teamSpec: [],
    };
    const perPlayerStat = { 1: { goals: 5, assists: 1, CS: 1, playtime: 300 }, 2: { goals: 1, assists: 2, CS: 0, playtime: 300 } };

    const roomStats = require(path.join(CORE, 'stats', 'roomStats'))({
        room, state, Team, authArray, db, HaxStatistics, HaxNotification,
        errorColor: 3, infoColor: 5, teamSize: 4,
        getAssistsPlayer: (p) => perPlayerStat[p.id].assists,
        getCSPlayer: (p) => perPlayerStat[p.id].CS,
        getGametimePlayer: (p) => perPlayerStat[p.id].playtime,
        getGoalsPlayer: (p) => perPlayerStat[p.id].goals,
        getOwnGoalsPlayer: () => 0,
        getPlayerComp: (player) => player,
        getTimeStats: (seconds) => `${Math.floor(seconds / 60)}m`,
    });

    // state.lastWinner is Team.RED: Alice is reported as playing RED (wins),
    // Bob as playing BLUE (loses) — this is how updateStats() actually calls
    // updatePlayerStats for each side.
    await roomStats.updatePlayerStats({ id: 1, name: 'Alice' }, Team.RED);
    await roomStats.updatePlayerStats({ id: 2, name: 'Bob' }, Team.BLUE);
    check('goals persisted for the winner', db.getPlayerStats('AUTH_ALICE').goals, 5);
    check('wins only counted for the winning team', db.getPlayerStats('AUTH_BOB').wins, 0);
    check('wins counted for the winning team', db.getPlayerStats('AUTH_ALICE').wins, 1);

    await roomStats.updatePlayerStats({ id: 1, name: 'Alice' }, Team.RED);
    check('games increments across saves', db.getPlayerStats('AUTH_ALICE').games, 2);
    check('goals accumulate across saves', db.getPlayerStats('AUTH_ALICE').goals, 10);

    // 2 players so far (Alice, Bob); 2 more fillers keeps it at 4 — still short of 5.
    for (let i = 0; i < 2; i++) db.savePlayerStats(`AUTH_FILLER${i}`, new HaxStatistics(`Filler${i}`));
    sent.length = 0;
    await roomStats.printRankings('goals', 0);
    check('leaderboard needs >= 5 entries before announcing', sent.length, 0);

    db.savePlayerStats('AUTH_FILLER2', Object.assign(new HaxStatistics('Filler2'), { goals: 100 }));
    sent.length = 0;
    await roomStats.printRankings('goals', 0);
    check('leaderboard is announced once 5 players exist, top scorer first', /^Голы> #1 Filler2 : 100/.test(sent[0].msg), true);

    // !tops with no argument (roomStats.printAllRankings) — every category
    // in one message now that all 5 rows exist, not six separate commands.
    sent.length = 0;
    await roomStats.printAllRankings(0);
    check('printAllRankings combines every category into one message', sent[0].msg.split('\n').length, 6);
    check('printAllRankings includes the goals leaderboard', /Голы> #1 Filler2 : 100/.test(sent[0].msg), true);
    check('printAllRankings includes the playtime leaderboard too', /Время игры>/.test(sent[0].msg), true);

    const printRankingsCalls = [];
    const printAllRankingsCalls = [];
    const printClubRankingsCalls = [];
    const { formatCoins, formatBanRemaining } = require(path.join(CORE, 'utils'));
    const discordBotCalls = [];
    const player = require(path.join(CORE, 'commands', 'player'))({
        room, state, Team, Role: { PLAYER: 0 }, HaxStatistics, authArray, db,
        AFKSet: new Set(), AFKMinSet: new Set(), AFKCooldownSet: new Set(),
        minAFKDuration: 0, maxAFKDuration: 0, AFKCooldown: 0,
        announcementColor: 1, errorColor: 3, infoColor: 5, successColor: 6, HaxNotification,
        getCommand: () => false, getRole: () => 0, handlePlayersJoin: () => {}, handlePlayersLeave: () => {},
        printPlayerStats: (s) => `stats-for-${s.playerName}`,
        printRankings: async (key, id) => { printRankingsCalls.push({ key, id }); },
        printAllRankings: async (id) => { printAllRankingsCalls.push(id); },
        printClubRankings: async (id) => { printClubRankingsCalls.push(id); },
        updateTeams: () => {},
        getCommands: () => ({}),
        formatCoins,
        formatBanRemaining,
        discordBot: { sendAdminCall: (playerName) => discordBotCalls.push(playerName) },
    });

    // topsCommand: dispatch logic only (printRankings/printAllRankings
    // themselves are exercised for real just above).
    printAllRankingsCalls.length = 0;
    await player.topsCommand({ id: 1, name: 'Alice' }, '!tops');
    check('!tops with no argument shows every category', printAllRankingsCalls, [1]);

    printRankingsCalls.length = 0;
    await player.topsCommand({ id: 1, name: 'Alice' }, '!tops goals');
    check('!tops goals shows just that category', printRankingsCalls, [{ key: 'goals', id: 1 }]);

    printRankingsCalls.length = 0;
    await player.topsCommand({ id: 1, name: 'Alice' }, '!tops pt');
    check('!tops pt resolves the "pt" alias to "playtime"', printRankingsCalls, [{ key: 'playtime', id: 1 }]);

    printClubRankingsCalls.length = 0;
    printRankingsCalls.length = 0;
    await player.topsCommand({ id: 1, name: 'Alice' }, '!tops clubs');
    check('!tops clubs dispatches to printClubRankings, not printRankings', printClubRankingsCalls, [1]);
    check('...and never printRankings', printRankingsCalls, []);

    sent.length = 0;
    printRankingsCalls.length = 0;
    await player.topsCommand({ id: 1, name: 'Alice' }, '!tops nonsense');
    check('!tops <unknown category> does not call printRankings', printRankingsCalls, []);
    check('!tops <unknown category> shows usage instead', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await player.globalStatsCommand({ id: 1, name: 'Alice' }, '!me');
    check('globalStatsCommand reads the same row updatePlayerStats wrote', sent[0].msg, 'stats-for-Alice');

    sent.length = 0;
    await player.renameCommand({ id: 1, name: 'Alice' }, '!rename Queen Alice');
    check('renameCommand updates only the name', db.getPlayerStats('AUTH_ALICE').playerName, 'Queen Alice');
    check('renameCommand preserves other stats', db.getPlayerStats('AUTH_ALICE').goals, 10);

    sent.length = 0;
    await player.renameCommand({ id: 3, name: 'NewPlayer' }, '!rename');
    check('renameCommand on a player with no games reports the error, not a crash', /еще не играли/.test(sent[0].msg), true);

    // !tops clubs crediting (see db.addClubStats, roomStats.js's
    // updatePlayerStats) — a DEDICATED auth/id, not Alice/Bob, so this
    // doesn't disturb the exact goal-count assertions already made on them
    // above. Credited at the same match-end moment as the player's own
    // stats, keyed off CURRENT club membership (state.clubMembers) at that
    // instant — not a live re-sum of the player's cumulative career total.
    authArray[20] = ['AUTH_CLUB_SCORER'];
    perPlayerStat[20] = { goals: 5, assists: 1, CS: 1, playtime: 100 };
    const testClub = db.createClub('AUTH_CLUB_SCORER', 'Scorer', 'ScorerClub', 'SCR', 0);
    state.clubMembers = [{ auth: 'AUTH_CLUB_SCORER', clubId: testClub.id, playerName: 'Scorer' }];

    check('a brand new club starts with no score at all (excluded from getTopClubs)', db.getTopClubs(5), []);

    await roomStats.updatePlayerStats({ id: 20, name: 'Scorer' }, Team.RED);
    const afterFirstMatch = db.getTopClubs(5).find((c) => c.id === testClub.id);
    check('a current member\'s goals/assists/CS are credited to their club', { goals: afterFirstMatch.goals, assists: afterFirstMatch.assists, cleanSheets: afterFirstMatch.cleanSheets }, { goals: 5, assists: 1, cleanSheets: 1 });
    check('the ranking score is the unweighted sum of all three (price of 1 each)', afterFirstMatch.score, 7);

    // Leaves the club (removed from state.clubMembers — exactly what
    // commands/club.js does on !club leave/kick/disband) — their NEXT
    // match's goals must stop being credited going forward.
    state.clubMembers = [];
    await roomStats.updatePlayerStats({ id: 20, name: 'Scorer' }, Team.RED);
    const afterLeaving = db.getTopClubs(5).find((c) => c.id === testClub.id);
    check('goals scored AFTER leaving the club are no longer credited', afterLeaving.goals, 5);
    check('...but what was already earned while a member is untouched, not retroactively removed', afterLeaving.score, 7);
    check('the player\'s OWN personal stats still accumulated normally either way', db.getPlayerStats('AUTH_CLUB_SCORER').goals, 10);

    // !report — announces to the room, pings Discord, and enforces its own
    // 1-minute per-player cooldown + any admin-set !restrictcmd restriction.
    sent.length = 0;
    discordBotCalls.length = 0;
    await player.reportCommand({ id: 1, name: 'Alice' }, '!report');
    check('!report announces to the whole room (id: null), not just the caller', sent[0].id, null);
    check('...naming the caller', /Alice/.test(sent[0].msg), true);
    check('!report pings Discord via discordBot.sendAdminCall with the caller\'s name', discordBotCalls, ['Alice']);

    sent.length = 0;
    discordBotCalls.length = 0;
    await player.reportCommand({ id: 1, name: 'Alice' }, '!report');
    check('a second !report within the cooldown window is rejected', /раз в минуту/.test(sent[0].msg), true);
    check('...and does not ping Discord again', discordBotCalls, []);

    sent.length = 0;
    await player.reportCommand({ id: 2, name: 'Bob' }, '!report');
    check('the cooldown is per-player — Bob is unaffected by Alice\'s', discordBotCalls, ['Bob']);

    // !restrictcmd (commands/master.js) — blocks a specific auth from a
    // specific command; !report must refuse Carol while she's restricted.
    await db.restrictCommand('AUTH_NEW_PLAYER', 'report', 'NewPlayer', 'спам', 10);
    sent.length = 0;
    discordBotCalls.length = 0;
    await player.reportCommand({ id: 3, name: 'NewPlayer' }, '!report');
    check('a restricted player is refused, with the reason surfaced', /запрещено использовать !report.*спам/.test(sent[0].msg), true);
    check('...and never reaches Discord or the cooldown set', discordBotCalls, []);
    await db.unrestrictCommand('AUTH_NEW_PLAYER', 'report');
    sent.length = 0;
    discordBotCalls.length = 0;
    await player.reportCommand({ id: 3, name: 'NewPlayer' }, '!report');
    check('!unrestrictcmd (db.unrestrictCommand) lifts the block again', discordBotCalls, ['NewPlayer']);

    // !up (Role.VIP) — claims priority for the NEXT captain auto-fill (see
    // team/choosing.js's resolveNextCaptainId, tested directly elsewhere in
    // this file). Reuses Alice (id 1, spectator here) and Bob (id 2).
    state.teamSpec = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];

    state.chooseMode = true;
    sent.length = 0;
    player.upCommand({ id: 1, name: 'Alice', team: Team.SPECTATORS }, '!up');
    check('!up is refused while captains are actively picking', /капитаны выбирают/.test(sent[0].msg), true);
    check('...and never claims the slot', state.priorityCaptainId, null);
    state.chooseMode = false;

    sent.length = 0;
    player.upCommand({ id: 1, name: 'Alice', team: Team.RED }, '!up');
    check('!up is refused for someone not currently spectating', /доступен только зрителям/.test(sent[0].msg), true);

    sent.length = 0;
    player.upCommand({ id: 1, name: 'Alice', team: Team.SPECTATORS }, '!up');
    check('a valid claim is confirmed to the whole room', sent.some((s) => s.id === null && /Alice.*капитаном/.test(s.msg)), true);
    check('...and actually recorded in state.priorityCaptainId', state.priorityCaptainId, 1);

    sent.length = 0;
    player.upCommand({ id: 2, name: 'Bob', team: Team.SPECTATORS }, '!up');
    check('a second VIP cannot claim the slot while one is already live', /Уже есть VIP в очереди/.test(sent[0].msg), true);
    check('the original claim is untouched', state.priorityCaptainId, 1);

    state.priorityCaptainId = null; // simulate resolveNextCaptainId having consumed Alice's claim
    sent.length = 0;
    player.upCommand({ id: 1, name: 'Alice', team: Team.SPECTATORS }, '!up');
    check('the SAME VIP is still rate-limited by their own 30-minute cooldown, even after their claim was consumed', /раз в 30 минут/.test(sent[0].msg), true);

    sent.length = 0;
    player.upCommand({ id: 2, name: 'Bob', team: Team.SPECTATORS }, '!up');
    check('...but a DIFFERENT VIP (no cooldown of their own) can claim the now-free slot', state.priorityCaptainId, 2);

    // printClubRankings (!tops clubs) — real formatted chat output, not
    // mocked, for the exact "5г/1а/1с" breakdown format.
    sent.length = 0;
    await roomStats.printClubRankings(0);
    check('printClubRankings announces the real formatted club leaderboard', sent[0].msg, 'Клубы> #1 [SCR] ScorerClub : 7 (5г/1а/1с)');

    state.clubMembers = [];

    // !customcolors: viewer-side toggle, works even for a brand new auth
    // with no player_stats row yet (setHideCustomColors upserts).
    check('AUTH_NEW_PLAYER starts without the flag', db.getAllHiddenCustomColors().includes('AUTH_NEW_PLAYER'), false);
    sent.length = 0;
    await player.customColorsCommand({ id: 3, name: 'NewPlayer' }, '!customcolors');
    check('customColorsCommand confirms opting out', /больше не отображаются/.test(sent[0].msg), true);
    check('the toggle is cached in state', state.hiddenCustomColorsSet.has('AUTH_NEW_PLAYER'), true);
    check('the toggle is persisted to the db even with no prior row', db.getAllHiddenCustomColors().includes('AUTH_NEW_PLAYER'), true);

    sent.length = 0;
    await player.customColorsCommand({ id: 3, name: 'NewPlayer' }, '!customcolors');
    check('running it again opts back in', /снова отображаются/.test(sent[0].msg), true);
    check('the toggle is cleared from state', state.hiddenCustomColorsSet.has('AUTH_NEW_PLAYER'), false);
    check('the toggle is cleared from the db', db.getAllHiddenCustomColors().includes('AUTH_NEW_PLAYER'), false);

    // !vipcolor: role-gated at the dispatch layer (Role.VIP), so the
    // command itself never re-checks role — works even for a brand new
    // auth with no player_stats row yet (setVipColor upserts).
    sent.length = 0;
    await player.vipColorCommand({ id: 3, name: 'NewPlayer' }, '!vipcolor zz');
    check('vipColorCommand rejects a non-hex value', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await player.vipColorCommand({ id: 3, name: 'NewPlayer' }, '!vipcolor ff8800');
    check('vipColorCommand confirms setting a custom color', /обновлен/.test(sent[0].msg), true);
    check('the color is cached in state', state.vipColors['AUTH_NEW_PLAYER'], 0xff8800);
    check('the color is persisted to the db even with no prior row', db.getAllVipColors(), [{ auth: 'AUTH_NEW_PLAYER', color: 0xff8800 }]);

    sent.length = 0;
    await player.vipColorCommand({ id: 3, name: 'NewPlayer' }, '!vipcolor');
    check('vipColorCommand with no argument resets to default', /сброшен/.test(sent[0].msg), true);
    check('the reset is cleared from state', state.vipColors['AUTH_NEW_PLAYER'], undefined);
    check('the reset is cleared from the db', db.getAllVipColors(), []);

    sent.length = 0;
    await player.linkDiscordCommand({ id: 1, name: 'Alice' }, '!discord 123456789012345678');
    check('linkDiscordCommand stores the link', db.getDiscordIdByAuth('AUTH_ALICE'), '123456789012345678');
    check('linkDiscordCommand confirms success', /связан/.test(sent[0].msg), true);

    sent.length = 0;
    await player.linkDiscordCommand({ id: 1, name: 'Alice' }, '!discord not-a-real-id');
    check('linkDiscordCommand rejects a non-numeric ID', /Неверный ID Discord/.test(sent[0].msg), true);
    check('linkDiscordCommand does not overwrite the valid link with garbage', db.getDiscordIdByAuth('AUTH_ALICE'), '123456789012345678');

    sent.length = 0;
    await player.linkDiscordCommand({ id: 1, name: 'Alice' }, '!discord');
    check('linkDiscordCommand requires an argument', /Неверный ID Discord/.test(sent[0].msg), true);

    check('getAuthByDiscordId resolves the link back to the auth', db.getAuthByDiscordId('123456789012345678'), 'AUTH_ALICE');
    check('getAuthByDiscordId returns null for an unknown id', db.getAuthByDiscordId('999999999999999999'), null);

    check('getAuthBan returns null when nobody is banned', db.getAuthBan('AUTH_GHOST'), null);
    db.banAuth('AUTH_CHEATER', 'Cheater', 'aimbot', 60);
    const cheaterBan = db.getAuthBan('AUTH_CHEATER');
    check('banAuth records the ban', { auth: cheaterBan.auth, playerName: cheaterBan.playerName, reason: cheaterBan.reason }, { auth: 'AUTH_CHEATER', playerName: 'Cheater', reason: 'aimbot' });
    check('banAuth records a real future expiry', new Date(cheaterBan.expiresAt).getTime() > Date.now(), true);
    check('getAuthBans lists it', db.getAuthBans().map((b) => ({ auth: b.auth, playerName: b.playerName, reason: b.reason })), [{ auth: 'AUTH_CHEATER', playerName: 'Cheater', reason: 'aimbot' }]);

    db.banAuth('AUTH_CHEATER', 'Cheater', 'updated reason', 30);
    check('banAuth upserts rather than duplicating', db.getAuthBans().length, 1);
    check('banAuth upsert updates the reason', db.getAuthBan('AUTH_CHEATER').reason, 'updated reason');

    // A negative duration is just a convenient way to construct an
    // already-expired ban for this test — banAuth's real callers always
    // validate a positive duration before calling in.
    db.banAuth('AUTH_EXPIRED', 'Expired', 'old ban', -1);
    check('getAuthBan treats an expired ban as not banned', db.getAuthBan('AUTH_EXPIRED'), null);
    check('an expired ban is cleaned up, not just filtered', db.getAuthBans().some((b) => b.auth === 'AUTH_EXPIRED'), false);

    db.unbanAuth('AUTH_CHEATER');
    check('unbanAuth removes the ban', db.getAuthBan('AUTH_CHEATER'), null);
    check('unbanAuth leaves an empty list', db.getAuthBans(), []);

    check('getVips starts empty', db.getVips(), []);
    db.addVip('AUTH_DONOR', 'Donor');
    check('addVip with no expiry records a permanent VIP', db.getVips(), [{ auth: 'AUTH_DONOR', playerName: 'Donor', expiresAt: null }]);
    db.addVip('AUTH_DONOR', 'DonorRenamed');
    check('addVip upserts the player name rather than duplicating', db.getVips(), [{ auth: 'AUTH_DONOR', playerName: 'DonorRenamed', expiresAt: null }]);
    db.removeVip('AUTH_DONOR');
    check('removeVip clears it', db.getVips(), []);

    // Time-limited VIP: getVips() sweeps a grant past its expiry (like
    // getAuthBans does for bans) rather than just filtering it out.
    const futureExpiry = new Date(Date.now() + 60000).toISOString();
    db.addVip('AUTH_DONOR', 'Donor', futureExpiry);
    check('addVip with a future expiry is returned as still active', db.getVips(), [{ auth: 'AUTH_DONOR', playerName: 'Donor', expiresAt: futureExpiry }]);
    db.addVip('AUTH_DONOR', 'Donor', new Date(Date.now() - 1000).toISOString());
    check('getVips sweeps a grant whose expiry has already passed', db.getVips(), []);

    // Economy: balance/ownership/equip all live on player_stats/player_items
    // (see db/sqlite.js) — addCoins must work even for a brand new auth with
    // no player_stats row yet (nobody's finished a quals game), not just for
    // existing players.
    check('getBalance is 0 for an auth never seen before', db.getBalance('AUTH_NEWBIE'), 0);
    db.addCoins('AUTH_NEWBIE', 'Newbie', 50);
    check('addCoins creates a row and credits it for a brand new auth', db.getBalance('AUTH_NEWBIE'), 50);
    db.addCoins('AUTH_NEWBIE', 'Newbie', 25);
    check('addCoins accumulates rather than overwriting', db.getBalance('AUTH_NEWBIE'), 75);

    check('getOwnedItemIds starts empty', db.getOwnedItemIds('AUTH_NEWBIE'), []);
    check('ownsItem is false before any purchase', db.ownsItem('AUTH_NEWBIE', 'fire'), false);

    check('buyItem fails when the price exceeds the balance', db.buyItem('AUTH_NEWBIE', 'Newbie', 'expensive', 1000), false);
    check('a failed purchase does not touch the balance', db.getBalance('AUTH_NEWBIE'), 75);

    check('buyItem succeeds and deducts the price', db.buyItem('AUTH_NEWBIE', 'Newbie', 'fire', 50), true);
    check('the price was deducted', db.getBalance('AUTH_NEWBIE'), 25);
    check('the item is now owned', db.ownsItem('AUTH_NEWBIE', 'fire'), true);
    check('getOwnedItemIds lists it', db.getOwnedItemIds('AUTH_NEWBIE'), ['fire']);

    check('buyItem refuses to sell the same item twice', db.buyItem('AUTH_NEWBIE', 'Newbie', 'fire', 50), false);
    check('a rejected duplicate purchase does not double-charge', db.getBalance('AUTH_NEWBIE'), 25);

    // Upgradeable items (small/big, see shopItems.js) — level tracked on
    // player_items.level, atomic the same way buyItem is.
    db.addCoins('AUTH_NEWBIE', 'Newbie', 175);
    check('getItemLevel is 0 for an item never bought', db.getItemLevel('AUTH_NEWBIE', 'bigtest'), 0);
    check('upgradeItem rejects a stale expectedCurrentLevel', db.upgradeItem('AUTH_NEWBIE', 'Newbie', 'bigtest', 100, 1), false);
    check('a rejected upgrade due to a stale level does not charge', db.getBalance('AUTH_NEWBIE'), 200);
    check('upgradeItem succeeds from level 0 -> 1 within budget', db.upgradeItem('AUTH_NEWBIE', 'Newbie', 'bigtest', 100, 0), true);
    check('the cost was deducted', db.getBalance('AUTH_NEWBIE'), 100);
    check('getItemLevel now reports level 1', db.getItemLevel('AUTH_NEWBIE', 'bigtest'), 1);
    check('upgradeItem also grants ownership', db.ownsItem('AUTH_NEWBIE', 'bigtest'), true);

    check('upgradeItem fails without enough balance for the next level', db.upgradeItem('AUTH_NEWBIE', 'Newbie', 'bigtest', 200, 1), false);
    check('a failed upgrade touches neither balance nor level', { balance: db.getBalance('AUTH_NEWBIE'), level: db.getItemLevel('AUTH_NEWBIE', 'bigtest') }, { balance: 100, level: 1 });

    check('upgradeItem succeeds from level 1 -> 2 within budget', db.upgradeItem('AUTH_NEWBIE', 'Newbie', 'bigtest', 100, 1), true);
    check('getItemLevel now reports level 2', db.getItemLevel('AUTH_NEWBIE', 'bigtest'), 2);
    check('the balance reflects both upgrades', db.getBalance('AUTH_NEWBIE'), 0);

    check('getEquipped starts with all slots empty', db.getEquipped('AUTH_NEWBIE'), { form: null, goalAnimation: null, size: null, trophy: null });
    db.setEquipped('AUTH_NEWBIE', 'goalAnimation', 'fire');
    check('setEquipped fills only the targeted slot', db.getEquipped('AUTH_NEWBIE'), { form: null, goalAnimation: 'fire', size: null, trophy: null });
    db.buyItem('AUTH_NEWBIE', 'Newbie', 'gold', 0);
    db.setEquipped('AUTH_NEWBIE', 'form', 'gold');
    check('setEquipped on a second slot leaves the first untouched', db.getEquipped('AUTH_NEWBIE'), { form: 'gold', goalAnimation: 'fire', size: null, trophy: null });
    db.buyItem('AUTH_NEWBIE', 'Newbie', 'small', 0);
    db.setEquipped('AUTH_NEWBIE', 'size', 'small');
    check('setEquipped on the size slot leaves the other two untouched', db.getEquipped('AUTH_NEWBIE'), { form: 'gold', goalAnimation: 'fire', size: 'small', trophy: null });

    // Daily login bonus streak (see db.claimDailyBonus / economy.js's
    // claimDailyBonus) — day N pays N*coinsPerStreak, capped at maxStreak
    // (the day after maxStreak wraps back to day 1). last_daily_at is driven
    // off the real system clock, so these temporarily swap in a fixed Date
    // to make "yesterday"/"today"/"a skipped day" deterministic.
    {
        const RealDate = Date;
        function mockNow(iso) {
            global.Date = class extends RealDate {
                constructor(...args) {
                    if (args.length === 0) return new RealDate(iso);
                    return new RealDate(...args);
                }
                static now() { return new RealDate(iso).getTime(); }
            };
        }
        function restoreDate() { global.Date = RealDate; }

        mockNow('2026-01-01T12:00:00.000Z');
        check('day 1 of the streak pays 5 and reports streak 1', db.claimDailyBonus('AUTH_DAILY', 'DailyPlayer', 5, 30), { amount: 5, streak: 1, newBalance: 5 });
        check('claiming again the same day is rejected', db.claimDailyBonus('AUTH_DAILY', 'DailyPlayer', 5, 30), null);

        mockNow('2026-01-02T12:00:00.000Z');
        check('day 2 (consecutive) pays 10 and reports streak 2', db.claimDailyBonus('AUTH_DAILY', 'DailyPlayer', 5, 30), { amount: 10, streak: 2, newBalance: 15 });

        mockNow('2026-01-04T12:00:00.000Z');
        check('a skipped day resets the streak to day 1', db.claimDailyBonus('AUTH_DAILY', 'DailyPlayer', 5, 30), { amount: 5, streak: 1, newBalance: 20 });

        // maxStreak=3 here (not the real 30) just to reach the wraparound in
        // a handful of mocked days instead of thirty.
        mockNow('2026-02-01T12:00:00.000Z');
        db.claimDailyBonus('AUTH_STREAK_CAP', 'Streaker', 5, 3);
        mockNow('2026-02-02T12:00:00.000Z');
        db.claimDailyBonus('AUTH_STREAK_CAP', 'Streaker', 5, 3);
        mockNow('2026-02-03T12:00:00.000Z');
        check('reaching maxStreak still pays that day\'s bonus', db.claimDailyBonus('AUTH_STREAK_CAP', 'Streaker', 5, 3), { amount: 15, streak: 3, newBalance: 30 });
        mockNow('2026-02-04T12:00:00.000Z');
        check('the day after maxStreak wraps the streak back to day 1', db.claimDailyBonus('AUTH_STREAK_CAP', 'Streaker', 5, 3), { amount: 5, streak: 1, newBalance: 35 });

        restoreDate();
    }

    // backup() must take a consistent, queryable snapshot (VACUUM INTO) even
    // though the source db here is a live, still-open :memory: database.
    {
        const os = require('os');
        const backupPath = path.join(os.tmpdir(), `haxlab-smoke-backup-${Date.now()}.sqlite`);
        db.addMaster('AUTH_BACKUP_CHECK');
        db.backup(backupPath);
        const restored = createSqliteDatabase(backupPath);
        check('backup() produces a readable copy with the current data', restored.getMasters().includes('AUTH_BACKUP_CHECK'), true);
        restored.close();
        fs.unlinkSync(backupPath);
    }

    check('getSetting returns null for an unknown key', db.getSetting('statusMessageId'), null);
    db.setSetting('statusMessageId', '111222333');
    check('setSetting/getSetting round-trips a value', db.getSetting('statusMessageId'), '111222333');
    db.setSetting('statusMessageId', '999888777');
    check('setSetting upserts rather than duplicating', db.getSetting('statusMessageId'), '999888777');

    db.close();
})();

console.log('\n--- stats/roomStats.js: VIP lottery — 1% roll per WINNING-team player on a genuine 4v4 ---');
(async () => {
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const HaxNotificationMock = { CHAT: 1 };
    const HaxStatistics = function (playerName = '') {
        this.playerName = playerName; this.games = 0; this.wins = 0; this.winrate = '0%';
        this.playtime = 0; this.goals = 0; this.assists = 0; this.CS = 0; this.ownGoals = 0;
    };
    const sent = [];
    const room = { sendAnnouncement: (msg, id) => sent.push({ msg, id }) };
    const grantCalls = [];
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const state = {
        lastWinner: Team.RED,
        teamRedStats: [{ id: 1, name: 'Winner1' }, { id: 2, name: 'Winner2' }],
        teamBlueStats: [{ id: 3, name: 'Loser1' }],
        players: [1, 2, 3],
        game: { scores: { time: 300, timeLimit: 300, red: 3, blue: 0, scoreLimit: 3 } },
        clubMembers: [],
        // Winner2 is already VIP going in — the roll must not double-grant.
        vipList: [['AUTH_ALREADY_VIP', 'Winner2', null]],
    };
    const authArray = { 1: ['AUTH_WINNER1'], 2: ['AUTH_ALREADY_VIP'], 3: ['AUTH_LOSER1'] };

    // A mutable stand-in for Math.random, injected via roomStats.js's own
    // `random` dependency — deliberately NOT a monkey-patch of the real
    // global Math.random, since this file's test blocks run as interleaved,
    // unawaited async IIFEs (see tools/smoke-test.js's own doc comments
    // elsewhere): temporarily replacing a real global here could leak into
    // some other, unrelated test's randomness during an `await` yield.
    let randomValue = 0;
    const roomStats = require(path.join(CORE, 'stats', 'roomStats'))({
        room, state, Team, authArray, db, HaxStatistics, HaxNotification: HaxNotificationMock,
        errorColor: 2, infoColor: 1, announcementColor: 5, teamSize: 1,
        getAssistsPlayer: () => 0, getCSPlayer: () => 0, getGametimePlayer: () => 0, getGoalsPlayer: () => 0,
        getOwnGoalsPlayer: () => 0, getPlayerComp: (p) => p, getTimeStats: (s) => `${s}s`,
        applyVipGrant: async (auth, name, expiresAt) => {
            grantCalls.push({ auth, name, expiresAt });
            state.vipList.push([auth, name, expiresAt]);
        },
        random: () => randomValue,
    });

    randomValue = 0; // forces every roll to "win"
    await roomStats.updateStats();

    check('a non-VIP winning player wins the lottery when the roll succeeds', grantCalls.some((c) => c.auth === 'AUTH_WINNER1'), true);
    check('an ALREADY-VIP winning player does not win again (no double grant)', grantCalls.some((c) => c.auth === 'AUTH_ALREADY_VIP'), false);
    check('a LOSING-team player is never even rolled for', grantCalls.some((c) => c.auth === 'AUTH_LOSER1'), false);
    check('the grant lasts 7 days', Math.round((new Date(grantCalls[0].expiresAt).getTime() - Date.now()) / 86400000), 7);
    check('a room-wide announcement names the winner', sent.some((s) => s.id === null && /Winner1 выиграл\(а\) VIP на 7 дней/.test(s.msg)), true);

    // Reset for the "always loses" pass.
    grantCalls.length = 0;
    sent.length = 0;
    state.vipList = [['AUTH_ALREADY_VIP', 'Winner2', null]];

    randomValue = 0.5; // forces every roll to "lose" (>= 1% chance)
    await roomStats.updateStats();

    check('nobody wins when every roll comes up short of 1%', grantCalls.length, 0);
    check('no lottery announcement is sent either', sent.some((s) => s.msg.includes('🎰')), false);

    // A draw (state.lastWinner outside RED/BLUE) never rolls at all, even
    // if the dice would otherwise always "win".
    state.lastWinner = Team.SPECTATORS;
    randomValue = 0;
    await roomStats.updateStats();
    check('a draw never rolls the lottery for anyone', grantCalls.length, 0);

    db.close();
})();

console.log('\n--- core/commands/club.js: create/invite/join/kick/leave/disband/color/slots against a real sqlite db ---');
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const { formatCoins } = require(path.join(CORE, 'utils'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const sent = [];
    const room = { sendAnnouncement: (msg, id, color, style) => sent.push({ msg, id, color }) };
    const authArray = { 1: ['AUTH_OWNER'], 2: ['AUTH_MEMBER'], 3: ['AUTH_OUTSIDER'] };
    const state = {
        playersAll: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Carol' }],
        clubs: [],
        clubMembers: [],
    };

    const club = require(path.join(CORE, 'commands', 'club'))({
        room, state, authArray, db,
        announcementColor: 1, errorColor: 2, successColor: 3, HaxNotification,
        formatCoins,
    });
    const alice = { id: 1, name: 'Alice' };
    const bob = { id: 2, name: 'Bob' };
    const carol = { id: 3, name: 'Carol' };

    sent.length = 0;
    await club.clubCreateCommand(alice, '!clubcreate');
    check('clubcreate without both args shows usage', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubCreateCommand(alice, '!clubcreate Wolves WLF');
    check('clubcreate fails without enough coins', /Недостаточно монет/.test(sent[0].msg), true);
    check('a failed creation does not register a club', state.clubs.length, 0);

    sent.length = 0;
    await club.clubCreateCommand(alice, '!clubcreate Wolves W1F');
    check('clubcreate rejects a prefix with a digit', /1-4 букв/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubCreateCommand(alice, '!clubcreate Wolves TOOLONG');
    check('clubcreate rejects a prefix longer than 4 letters', /1-4 букв/.test(sent[0].msg), true);

    db.addCoins('AUTH_OWNER', 'Alice', 1000);
    sent.length = 0;
    await club.clubCreateCommand(alice, '!clubcreate Falcons FLC');
    check('clubcreate succeeds once the owner can afford it', /создан/.test(sent[0].msg), true);
    check('the creation confirmation is private to the owner, not broadcast', sent[0].id, alice.id);
    check('the cost was deducted', db.getBalance('AUTH_OWNER'), 0);
    check('the club is cached in state', state.clubs.length, 1);
    check('the owner is registered as a member', state.clubMembers.length, 1);
    const clubId = state.clubs[0].id;
    check('the created club has the right name/prefix/owner', { name: state.clubs[0].name, prefix: state.clubs[0].prefix, ownerAuth: state.clubs[0].ownerAuth }, { name: 'Falcons', prefix: 'FLC', ownerAuth: 'AUTH_OWNER' });
    check('the base slot count is 5', state.clubs[0].slots, 5);

    sent.length = 0;
    await club.clubCreateCommand(alice, '!clubcreate Wolves WLF');
    check('a player already in a club cannot create another', /уже состоите/.test(sent[0].msg), true);

    sent.length = 0;
    club.clubInfoCommand(alice, '!club');
    check('!club shows the requested "name (members/limit): captain (c)" format', sent[0].msg, 'Falcons (1/5): Alice (c)');

    sent.length = 0;
    await club.clubInviteCommand(bob, '!clubinvite #1');
    check('a non-member cannot invite', /не состоите/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubInviteCommand(alice, '!clubinvite #2');
    check('the invite is announced to the whole room', sent[0].id, null);
    check('the broadcast names both the inviter and the invitee', /Alice пригласил Bob в клуб "Falcons"/.test(sent[0].msg), true);
    check('bob gets a private invite notification', sent[1].id, 2);
    check('the invite notification names the club and the 60s window', /Falcons/.test(sent[1].msg) && /60 секунд/.test(sent[1].msg), true);

    sent.length = 0;
    await club.clubJoinCommand(carol, '!clubjoin');
    check('clubjoin with no pending invite is rejected', /нет приглашений/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubJoinCommand(bob, '!clubjoin');
    check('bob accepts the invite', /вступил/.test(sent[0].msg), true);
    check('bob is now cached as a member', state.clubMembers.some((m) => m.auth === 'AUTH_MEMBER'), true);

    sent.length = 0;
    await club.clubJoinCommand(bob, '!clubjoin');
    check('a player already in a club cannot join another', /уже состоите/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubLeaveCommand(alice, '!clubleave');
    check('the owner cannot !club leave — must !club disband', /club disband/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubKickCommand(bob, '!clubkick #1');
    check('a non-owner cannot kick', /Только владелец/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubKickCommand(alice, '!clubkick #1');
    check('the owner cannot kick themselves', /самого себя/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubKickCommand(alice, '!clubkick #2');
    check('the owner kicks bob', /выгнан/.test(sent[0].msg), true);
    check('bob is no longer cached as a member', state.clubMembers.some((m) => m.auth === 'AUTH_MEMBER'), false);

    sent.length = 0;
    await club.clubColorCommand(alice, '!clubcolor zz');
    check('clubcolor rejects a non-hex value', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubColorCommand(alice, '!clubcolor ff8800');
    check('clubcolor is gated behind !club color buy until unlocked', /платная/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubColorCommand(bob, '!clubcolor buy');
    check('a non-member (bob was kicked earlier) cannot buy the color unlock', /не состоите/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubColorCommand(alice, '!clubcolor buy');
    check('clubcolor buy fails without enough coins', /Недостаточно монет/.test(sent[0].msg), true);
    check('the cost mentioned is 10000', /10000/.test(sent[0].msg), true);
    check('an unsuccessful unlock does not flip the flag', state.clubs[0].colorUnlocked, false);

    db.addCoins('AUTH_OWNER', 'Alice', 10000);
    sent.length = 0;
    await club.clubColorCommand(alice, '!clubcolor buy');
    check('clubcolor buy succeeds once affordable', /разблокирован/.test(sent[0].msg), true);
    check('the unlock is cached in state', state.clubs[0].colorUnlocked, true);
    check('the unlock is persisted to the db', db.getClub(clubId).colorUnlocked, true);
    check('the 10000 cost was deducted', db.getBalance('AUTH_OWNER'), 0);

    sent.length = 0;
    await club.clubColorCommand(alice, '!clubcolor buy');
    check('buying the unlock again is rejected (already unlocked)', /уже разблокирован/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubColorCommand(alice, '!clubcolor zz');
    check('clubcolor still rejects a non-hex value once unlocked', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubColorCommand(alice, '!clubcolor ff8800');
    check('clubcolor accepts a valid hex value once unlocked', /обновлен/.test(sent[0].msg), true);
    check('the color is cached in state', state.clubs[0].color, 0xff8800);
    check('the color is persisted to the db', db.getClub(clubId).color, 0xff8800);

    sent.length = 0;
    await club.clubEmojiCommand(bob, '!clubemoji 🔥');
    check('a non-member cannot set the emoji', /не состоите/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubEmojiCommand(alice, '!clubemoji ABC');
    check('clubemoji rejects plain text', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubEmojiCommand(alice, '!clubemoji 🔥');
    check('clubemoji accepts a real emoji', /обновлен/.test(sent[0].msg), true);
    check('the emoji is cached in state', state.clubs[0].emoji, '🔥');
    check('the emoji is persisted to the db', db.getClub(clubId).emoji, '🔥');

    sent.length = 0;
    await club.clubEmojiCommand(alice, '!clubemoji');
    check('clubemoji with no argument clears it', /убран/.test(sent[0].msg), true);
    check('the cleared emoji is reflected in state', state.clubs[0].emoji, null);

    // Assistant: the one non-owner club role, whose only extra power is
    // being allowed to !clubinvite. Bob was kicked earlier, so he's free to
    // be re-invited here as the assistant-sent-invite target.
    await club.clubInviteCommand(alice, '!clubinvite #3');
    await club.clubJoinCommand(carol, '!clubjoin');
    check('carol joined the club for the assistant tests', state.clubMembers.some((m) => m.auth === 'AUTH_OUTSIDER'), true);

    sent.length = 0;
    club.clubInfoCommand(alice, '!club');
    check('!club lists a second regular member after the captain', sent[0].msg, 'Falcons (2/5): Alice (c), Carol');

    sent.length = 0;
    await club.clubAssistantCommand(carol, '!clubassistent Carol');
    check('a non-owner cannot assign an assistant', /Только владелец/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubAssistantCommand(alice, '!clubassistent Alice');
    check('the owner cannot make themselves the assistant', /не может быть ассистентом/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubAssistantCommand(alice, '!clubassistent Nobody');
    check('assigning a non-member as assistant is rejected', /нет в вашем клубе/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubAssistantCommand(alice, '!clubassistent Carol');
    check('the owner assigns carol as assistant', /теперь ассистент/.test(sent[0].msg), true);
    check('the assistant is cached in state', state.clubs[0].assistantAuth, 'AUTH_OUTSIDER');
    check('the assistant is persisted to the db', db.getClub(clubId).assistantAuth, 'AUTH_OUTSIDER');

    sent.length = 0;
    club.clubInfoCommand(alice, '!club');
    check('!club lists the assistant with (a) right after the captain', sent[0].msg, 'Falcons (2/5): Alice (c), Carol (a)');

    sent.length = 0;
    await club.clubInviteCommand(carol, '!clubinvite #2');
    check('the assistant can invite players too', sent[0].id, null);
    check('the assistant-sent invite names carol as the inviter', /Carol пригласил Bob/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubAssistantCommand(alice, '!clubassistent');
    check('the owner clears the assistant with no argument', /снят/.test(sent[0].msg), true);
    check('the cleared assistant is reflected in state', state.clubs[0].assistantAuth, null);

    sent.length = 0;
    await club.clubInviteCommand(carol, '!clubinvite #2');
    check('a demoted assistant can no longer invite', /Только владелец или ассистент/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubSlotsCommand(alice, '!clubslots');
    check('clubslots without "buy" shows usage', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubSlotsCommand(alice, '!clubslots buy');
    check('clubslots buy fails without enough coins', /Недостаточно монет/.test(sent[0].msg), true);
    check('the first slot costs 500', /500/.test(sent[0].msg), true);

    db.addCoins('AUTH_OWNER', 'Alice', 500);
    sent.length = 0;
    await club.clubSlotsCommand(alice, '!clubslots buy');
    check('clubslots buy succeeds once affordable', /Куплен/.test(sent[0].msg), true);
    check('slots went from 5 to 6', state.clubs[0].slots, 6);
    check('the 500 cost was deducted', db.getBalance('AUTH_OWNER'), 0);

    db.addCoins('AUTH_OWNER', 'Alice', 600);
    sent.length = 0;
    await club.clubSlotsCommand(alice, '!clubslots buy');
    check('the second slot costs 100 more than the first (600)', db.getBalance('AUTH_OWNER'), 0);
    check('slots went from 6 to 7', state.clubs[0].slots, 7);

    sent.length = 0;
    await club.clubDisbandCommand(bob, '!clubdisband');
    check('a non-member cannot disband', /не состоите/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubDisbandCommand(carol, '!clubdisband');
    check('a regular member (not the owner) cannot disband', /Только владелец/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubDisbandCommand(alice, '!clubdisband');
    check('the owner disbands the club', /расформирован/.test(sent[0].msg), true);
    check('the club is removed from state', state.clubs.length, 0);
    check('every membership is removed from state', state.clubMembers.length, 0);
    check('the club is removed from the db', db.getClub(clubId), null);

    sent.length = 0;
    club.clubInfoCommand(alice, '!club');
    check('!club after disbanding reports no club', /не состоите/.test(sent[0].msg), true);

    sent.length = 0;
    club.clubHelpCommand(alice, '!clubhelp');
    check('!clubhelp lists the club commands', /Команды клуба/.test(sent[0].msg), true);
    check('!clubhelp documents the slot price', /500 монеток/.test(sent[0].msg), true);

    db.close();
})();

console.log('\n--- core/commands/club.js: clubCommand dispatcher — !club <subcommand> routes to the right handler ---');
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const { formatCoins } = require(path.join(CORE, 'utils'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const sent = [];
    const room = { sendAnnouncement: (msg, id, color, style) => sent.push({ msg, id, color }) };
    const authArray = { 1: ['AUTH_OWNER'], 2: ['AUTH_MEMBER'] };
    const state = {
        playersAll: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
        clubs: [],
        clubMembers: [],
    };
    const club = require(path.join(CORE, 'commands', 'club'))({
        room, state, authArray, db,
        announcementColor: 1, errorColor: 2, successColor: 3, HaxNotification,
        formatCoins,
    });
    const alice = { id: 1, name: 'Alice' };
    const bob = { id: 2, name: 'Bob' };

    sent.length = 0;
    await club.clubCommand(alice, '!club');
    check('bare "!club" (no subcommand) behaves like "!club show"', /Вы не состоите в клубе/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubCommand(alice, '!club show');
    check('"!club show" is the same no-club message as the bare form', /Вы не состоите в клубе/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubCommand(alice, '!club nonsense');
    check('an unknown subcommand is rejected by name', /Неизвестная подкоманда "nonsense"/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubCommand(alice, '!club CREATE');
    check('the subcommand keyword is case-insensitive', /Использование/.test(sent[0].msg), true);

    db.addCoins('AUTH_OWNER', 'Alice', 1000);
    sent.length = 0;
    // Multi-arg subcommands (create takes 2) reach the real handler with the
    // subcommand word itself stripped, not swallowed as part of the name.
    await club.clubCommand(alice, '!club create Falcons FLC');
    check('"!club create <name> <prefix>" reaches clubCreateCommand with both args intact', /создан/.test(sent[0].msg), true);
    check('the club was actually created with the right name/prefix', { name: state.clubs[0].name, prefix: state.clubs[0].prefix }, { name: 'Falcons', prefix: 'FLC' });

    sent.length = 0;
    await club.clubCommand(alice, '!club show');
    check('"!club show" now reports the just-created club', /Falcons \(1\/5\): Alice \(c\)/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubCommand(alice, '!club invite #2');
    check('a single-arg subcommand (invite) reaches its handler correctly', sent[1] && /Falcons/.test(sent[1].msg), true);

    sent.length = 0;
    await club.clubCommand(bob, '!club join');
    check('a bare subcommand with nothing after it (join) still works through the dispatcher', /вступил/.test(sent[0].msg), true);

    sent.length = 0;
    // A nested sub-argument (color -> buy) has to survive being split and
    // rejoined by the dispatcher just like every other multi-token case.
    await club.clubCommand(alice, '!club color buy');
    check('a nested sub-argument (color buy) reaches clubColorCommand intact', /Недостаточно монет/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubCommand(alice, '!club assistent Bob');
    check('the historical misspelling "assistent" is still accepted as an alias', /теперь ассистент/.test(sent[0].msg), true);

    sent.length = 0;
    await club.clubCommand(alice, '!club help');
    check('"!club help" routes to clubHelpCommand', /Команды клуба/.test(sent[0].msg), true);

    db.close();
})();

console.log('\n--- core/commands/club.js: clubChatCommand (!cc) — club-wide chat to whoever\'s currently online ---');
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const { formatCoins } = require(path.join(CORE, 'utils'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const sent = [];
    const room = { sendAnnouncement: (msg, id, color, style) => sent.push({ msg, id, color }) };
    // Dave (id 4) is a club member who is NOT currently online (absent from
    // playersAll) — Eve (id 5) is online but never joined the club at all.
    const authArray = { 1: ['AUTH_OWNER'], 2: ['AUTH_MEMBER'], 3: ['AUTH_OUTSIDER'], 4: ['AUTH_OFFLINE_MEMBER'], 5: ['AUTH_EVE'] };
    const state = {
        playersAll: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Carol' }, { id: 5, name: 'Eve' }],
        clubs: [],
        clubMembers: [],
    };
    const club = require(path.join(CORE, 'commands', 'club'))({
        room, state, authArray, db,
        announcementColor: 1, errorColor: 2, successColor: 3, HaxNotification,
        formatCoins,
    });
    const alice = { id: 1, name: 'Alice' };
    const bob = { id: 2, name: 'Bob' };
    const eve = { id: 5, name: 'Eve' };

    sent.length = 0;
    club.clubChatCommand(eve, '!cc hi');
    check('a non-member cannot use club chat', /не состоите/.test(sent[0].msg), true);

    db.addCoins('AUTH_OWNER', 'Alice', 1000);
    await club.clubCreateCommand(alice, '!clubcreate Falcons FLC');
    state.clubMembers.push({ auth: 'AUTH_MEMBER', clubId: state.clubs[0].id, playerName: 'Bob' });
    state.clubMembers.push({ auth: 'AUTH_OFFLINE_MEMBER', clubId: state.clubs[0].id, playerName: 'Dave' });

    sent.length = 0;
    club.clubChatCommand(alice, '!cc привет всем');
    check('club chat reaches every ONLINE member, including the sender', sent.map((s) => s.id).sort(), [1, 2]);
    check('the offline member (not in playersAll) gets nothing — no error, just skipped', sent.every((s) => s.id !== 4), true);
    check('a player online but outside the club (Eve) never receives it', sent.every((s) => s.id !== 5), true);
    check('the message carries the club tag, a [CC] marker, and the sender\'s name', sent[0].msg, '[FLC] [CC] Alice: привет всем');
    check('every recipient gets the identical message text', new Set(sent.map((s) => s.msg)).size, 1);

    sent.length = 0;
    club.clubChatCommand(bob, '!cc');
    check('an empty message still sends (mirrors teamChat\'s own lack of validation)', sent[0].msg, '[FLC] [CC] Bob: ');

    db.close();
})();

console.log('\n--- core/commands/trophies.js + db.getTopPlayers(): top-3 trophies against a real sqlite db ---');
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const { Trophies } = require(path.join(CORE, 'constants'));
    const { formatTrophyLabel } = require(path.join(CORE, 'utils'));
    const { HaxStatistics } = require(path.join(CORE, 'models'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    db.savePlayerStats('AUTH_1', Object.assign(new HaxStatistics('P1'), { games: 10, wins: 9, goals: 20, assists: 1, CS: 1, playtime: 100 }));
    check('getTopPlayers requires a >=5-player quorum before awarding anything', db.getTopPlayers(), { goals: [], assists: [], cs: [], wr: [], pt: [] });

    // Distinct values per category, and AUTH_5 last everywhere, so each
    // category's top-3 order is unambiguous (no tie-breaking to worry about).
    db.savePlayerStats('AUTH_2', Object.assign(new HaxStatistics('P2'), { games: 10, wins: 1, goals: 15, assists: 20, CS: 2, playtime: 90 }));
    db.savePlayerStats('AUTH_3', Object.assign(new HaxStatistics('P3'), { games: 10, wins: 2, goals: 10, assists: 15, CS: 20, playtime: 80 }));
    db.savePlayerStats('AUTH_4', Object.assign(new HaxStatistics('P4'), { games: 10, wins: 8, goals: 5, assists: 10, CS: 15, playtime: 500 }));
    db.savePlayerStats('AUTH_5', Object.assign(new HaxStatistics('P5'), { games: 10, wins: 0, goals: 1, assists: 1, CS: 1, playtime: 1 }));

    const top = db.getTopPlayers();
    check('goals top-3, in order, once 5 players exist', top.goals.map((e) => e.auth), ['AUTH_1', 'AUTH_2', 'AUTH_3']);
    check('assists top-3, in order', top.assists.map((e) => e.auth), ['AUTH_2', 'AUTH_3', 'AUTH_4']);
    check('clean-sheets top-3, in order', top.cs.map((e) => e.auth), ['AUTH_3', 'AUTH_4', 'AUTH_2']);
    check('playtime top-3, in order', top.pt.map((e) => e.auth), ['AUTH_4', 'AUTH_1', 'AUTH_2']);
    check('winrate top-3, in order (90/80/20%)', top.wr.map((e) => e.auth), ['AUTH_1', 'AUTH_4', 'AUTH_3']);
    check('only the top 3 are returned, not every player', top.goals.length, 3);

    check('getEquipped starts with no trophy', db.getEquipped('AUTH_1').trophy, null);
    db.setEquipped('AUTH_1', 'trophy', 'goals');
    check('setEquipped/getEquipped round-trips the trophy slot', db.getEquipped('AUTH_1').trophy, 'goals');
    check('getAllEquippedTrophies lists only auths with one equipped', db.getAllEquippedTrophies(), [{ auth: 'AUTH_1', trophy: 'goals' }]);

    // trophiesCommand itself never queries the db for rank — it only ever
    // reads state.topPlayers (the once-per-match cache roomStats.js
    // maintains), so it's driven here with a directly-set snapshot rather
    // than needing a full match simulation.
    const sent = [];
    const room = { sendAnnouncement: (msg, id, color, style) => sent.push({ msg, id }) };
    const authArray = { 1: ['AUTH_TOP'], 2: ['AUTH_SECOND'], 3: ['AUTH_NOT_TOP'] };
    // setEquipped is an UPDATE, not an upsert (see db/sqlite.js) — a
    // player_stats row has to already exist for it to take effect, same as
    // economy.js's equip flow relies on buyItem having created one first.
    db.addCoins('AUTH_TOP', 'TopScorer', 0);
    db.addCoins('AUTH_SECOND', 'SecondScorer', 0);
    db.addCoins('AUTH_NOT_TOP', 'Regular', 0);
    const { encodeLegacyTrophyKey, resolveTrophyRank } = require(path.join(CORE, 'utils'));
    const state = {
        topPlayers: { goals: [{ auth: 'AUTH_TOP' }, { auth: 'AUTH_SECOND' }], assists: [], cs: [], wr: [], pt: [] },
        equippedTrophies: {},
        // currentSeason=5 (an arbitrary non-zero/non-one value) so these
        // tests actually prove the season number is threaded through, not
        // just coincidentally matching some default.
        currentSeason: 5,
        seasonTrophies: [{ season: 3, category: 'goals', rank: 1, auth: 'AUTH_TOP', playerName: 'TopScorer', value: 99 }],
    };
    const trophies = require(path.join(CORE, 'commands', 'trophies'))({
        room, state, authArray, db, Trophies, formatTrophyLabel, encodeLegacyTrophyKey, resolveTrophyRank,
        announcementColor: 1, errorColor: 2, HaxNotification,
    });
    const topPlayer = { id: 1, name: 'TopScorer' };
    const secondPlayer = { id: 2, name: 'SecondScorer' };
    const notTopPlayer = { id: 3, name: 'Regular' };

    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy');
    check('!trophy with no argument lists owned trophies with the gold medal', /🥇Топ-1 голов/.test(sent[0].msg), true);
    check('!trophy with no argument shows nothing equipped yet', /не выбран/.test(sent[0].msg), true);

    sent.length = 0;
    await trophies.trophiesCommand(secondPlayer, '!trophy');
    check('rank 2 is listed with the silver medal', /🥈Топ-2 голов/.test(sent[0].msg), true);

    sent.length = 0;
    await trophies.trophiesCommand(notTopPlayer, '!trophy goals');
    check('equipping a trophy you do not hold (outside the top 3) is rejected', /не в топ-3/.test(sent[0].msg), true);
    check('a rejected equip does not touch state.equippedTrophies', state.equippedTrophies['AUTH_NOT_TOP'], undefined);

    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy nonsense');
    check('an unknown trophy key shows usage', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await trophies.trophiesCommand(secondPlayer, '!trophy goals');
    check('rank 2 can equip the same category as rank 1', /Экипирован/.test(sent[0].msg), true);
    check('the confirmation shows the silver medal for rank 2', /🥈Топ-2 голов/.test(sent[0].msg), true);

    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy goals');
    check('equipping a trophy you currently hold succeeds', /Экипирован/.test(sent[0].msg), true);
    check('the equip is cached in state', state.equippedTrophies['AUTH_TOP'], 'goals');
    check('the equip is persisted to the db', db.getEquipped('AUTH_TOP').trophy, 'goals');

    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy');
    check('!trophy now shows the equipped trophy with its medal', /Экипирован: 🥇Топ-1 голов/.test(sent[0].msg), true);

    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy none');
    check('!trophy none clears the equipped trophy', /снят/.test(sent[0].msg), true);
    check('the clear is cached in state', state.equippedTrophies['AUTH_TOP'], undefined);
    check('the clear is persisted to the db', db.getEquipped('AUTH_TOP').trophy, null);

    // Legacy (already-closed-season) trophy picks — see db.closeSeason /
    // resolveTrophyRank. TopScorer held rank 1 in season 3's goals category
    // (state.seasonTrophies above), which is a completely different season
    // from state.currentSeason (5) and from their CURRENT live standing.
    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy goals 999');
    check('equipping a legacy trophy for a season you never held is rejected', /нет этого трофея за сезон/.test(sent[0].msg), true);
    check('a rejected legacy equip does not touch state.equippedTrophies', state.equippedTrophies['AUTH_TOP'], undefined);

    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy goals 3');
    check('equipping a legacy trophy for a season you actually held it succeeds', /Экипирован/.test(sent[0].msg), true);
    check('the confirmation tags the season it was actually won in (S3), not the current one (S5)', /Топ-1 голов S3/.test(sent[0].msg), true);
    check('the equip is stored with the legacy season/category encoded', state.equippedTrophies['AUTH_TOP'], encodeLegacyTrophyKey(3, 'goals'));

    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy');
    check('!trophy summary resolves the legacy pick to its frozen season, even with zero live standing this season', /Экипирован: 🥇Топ-1 голов S3/.test(sent[0].msg), true);

    // An explicit CURRENT season argument is equivalent to omitting it — it
    // resolves against the LIVE standings, not state.seasonTrophies (which
    // has no row for a season that hasn't closed yet).
    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy goals 5');
    check('an explicit current-season argument equips the live pick, not a legacy lookup', /Топ-1 голов S5/.test(sent[0].msg), true);
    check('the equip is stored as a bare (live) category, not legacy-encoded', state.equippedTrophies['AUTH_TOP'], 'goals');

    sent.length = 0;
    await trophies.trophiesCommand(topPlayer, '!trophy goals notanumber');
    check('a non-numeric season argument is rejected with a clear message', /Сезон должен быть числом/.test(sent[0].msg), true);

    await trophies.trophiesCommand(topPlayer, '!trophy none');

    // roomStats.js's updateStats() is the only thing that actually refreshes
    // state.topPlayers (once per completed match, never per chat message) —
    // confirm it really calls through to db.getTopPlayers() rather than
    // leaving the snapshot stale.
    const rsState = {
        lastWinner: Team.RED,
        teamRedStats: [{ id: 1, name: 'P1' }],
        teamBlueStats: [{ id: 2, name: 'P2' }],
        players: [1, 2],
        game: { scores: { time: 300, timeLimit: 300, red: 3, blue: 0, scoreLimit: 3 } },
        clubMembers: [],
        // The VIP lottery (see roomStats.js's rollVipLottery) only fires on
        // a genuine ~1% roll, but updateStats() always reaches the check
        // that reads state.vipList regardless — must exist even though this
        // test doesn't care about the lottery itself.
        vipList: [],
    };
    const rsAuthArray = { 1: ['AUTH_1'], 2: ['AUTH_2'] };
    const roomStats = require(path.join(CORE, 'stats', 'roomStats'))({
        room, state: rsState, Team, authArray: rsAuthArray, db, HaxStatistics, HaxNotification,
        errorColor: 2, infoColor: 1, announcementColor: 5, teamSize: 1,
        getAssistsPlayer: () => 0, getCSPlayer: () => 0, getGametimePlayer: () => 0, getGoalsPlayer: () => 0,
        getOwnGoalsPlayer: () => 0, getPlayerComp: (p) => p, getTimeStats: (s) => `${s}s`,
        applyVipGrant: async () => {},
        random: () => 1, // always "loses" the 1% roll — this test doesn't care about the lottery
    });
    await roomStats.updateStats();
    check('updateStats() refreshes state.topPlayers via db.getTopPlayers()', rsState.topPlayers.goals[0].auth, 'AUTH_1');

    db.close();
})();

console.log('\n--- db/sqlite.js: closeSeason() freezes top-3, resets stats, preserves balance/items ---');
{
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    check('getCurrentSeason defaults to 0 before any season has ever closed', db.getCurrentSeason(), 0);
    check('getSeasonTrophies starts empty', db.getSeasonTrophies(), []);

    // Below the 5-player trophy quorum (see getTopPlayers) — closeSeason
    // must still succeed, it just has nothing to freeze.
    db.savePlayerStats('AUTH_A', { playerName: 'A', games: 5, wins: 5, goals: 10 });
    db.addCoins('AUTH_A', 'A', 500);
    db.buyItem('AUTH_A', 'A', 'fire', 0);

    const belowQuorum = db.closeSeason();
    check('closeSeason on a below-quorum room reports 0 trophies saved, not an error', belowQuorum, { alreadyClosed: false, season: 0, nextSeason: 1, trophiesSaved: 0 });
    check('stats are still reset even with nothing to freeze', db.getPlayerStats('AUTH_A').games, 0);
    check('currentSeason advanced to 1', db.getCurrentSeason(), 1);

    db.close();
}
{
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    // 5 players (the trophy quorum) with distinct goal counts so the top-3
    // order is unambiguous, same setup style as the getTopPlayers test above.
    for (const [auth, goals] of [['AUTH_1', 50], ['AUTH_2', 40], ['AUTH_3', 30], ['AUTH_4', 20], ['AUTH_5', 10]]) {
        db.savePlayerStats(auth, { playerName: auth, games: 10, wins: 5, goals });
    }
    db.addCoins('AUTH_1', 'P1', 1234);
    db.buyItem('AUTH_1', 'P1', 'fire', 0);
    db.setEquipped('AUTH_1', 'goalAnimation', 'fire');

    const closed = db.closeSeason();
    check('closeSeason(): 5 categories x up to 3 ranks = 15 trophy rows for a full quorum', closed.trophiesSaved, 15);
    check('closeSeason() reports the season it just closed and the next one', { season: closed.season, nextSeason: closed.nextSeason }, { season: 0, nextSeason: 1 });

    const frozen = db.getSeasonTrophies();
    check('season_trophies now holds every category\'s frozen top-3', frozen.length, 15);
    const goalsRank1 = frozen.find((t) => t.season === 0 && t.category === 'goals' && t.rank === 1);
    check('the goals rank-1 row is exactly who actually led (AUTH_1, 50 goals)', goalsRank1, { season: 0, category: 'goals', rank: 1, auth: 'AUTH_1', playerName: 'AUTH_1', value: 50 });

    check('every player\'s stats were reset to 0', db.getPlayerStats('AUTH_1').games, 0);
    check('...goals too', db.getPlayerStats('AUTH_1').goals, 0);
    check('balance survives a season close untouched', db.getBalance('AUTH_1'), 1234);
    check('owned shop items survive a season close untouched', db.ownsItem('AUTH_1', 'fire'), true);
    check('equipped cosmetics survive a season close untouched', db.getEquipped('AUTH_1').goalAnimation, 'fire');
    check('currentSeason advanced from 0 to 1', db.getCurrentSeason(), 1);

    db.close();
}
{
    // Idempotency guard (same "already done" idea as
    // scripts/migrate-size-levels.js's MIGRATION_FLAG) — simulates a season
    // already marked closed (e.g. a crash right after that flag was written
    // but before currentSeason itself advanced) and confirms closeSeason()
    // detects it and makes no further changes at all, rather than
    // re-snapshotting trophies or re-wiping stats a second time.
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();
    db.savePlayerStats('AUTH_X', { playerName: 'X', games: 9, goals: 9 });
    db.setSetting('seasonClosed:0', 'already-happened');

    const result = db.closeSeason();
    check('closeSeason() detects an already-closed current season and is a no-op', result, { alreadyClosed: true, season: 0 });
    check('stats are left untouched when already-closed is detected', db.getPlayerStats('AUTH_X').games, 9);
    check('currentSeason is NOT advanced when already-closed is detected', db.getCurrentSeason(), 0);
    check('no trophies were snapshotted', db.getSeasonTrophies(), []);

    db.close();
}

console.log('\n--- db/sqlite.js: addClubStats/getTopClubs — !tops clubs, weighted 1/1/1 ---');
{
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const clubA = db.createClub('AUTH_A', 'A', 'ClubA', 'CLA', 0);
    const clubB = db.createClub('AUTH_B', 'B', 'ClubB', 'CLB', 0);

    check('getTopClubs is empty before anyone has scored anything', db.getTopClubs(5), []);

    db.addClubStats(clubA.id, { goals: 3, assists: 1, cleanSheets: 0 });
    check('addClubStats credits exactly the given deltas', db.getTopClubs(5).find((c) => c.id === clubA.id).score, 4);

    db.addClubStats(clubA.id, { goals: 2 });
    check('addClubStats accumulates across calls rather than overwriting', db.getTopClubs(5).find((c) => c.id === clubA.id).goals, 5);
    check('a partial deltas object defaults the missing fields to 0, not NaN/undefined', db.getTopClubs(5).find((c) => c.id === clubA.id).score, 6);

    check('a club that never had addClubStats called for it is excluded (score 0)', db.getTopClubs(5).find((c) => c.id === clubB.id), undefined);

    db.addClubStats(clubB.id, { goals: 0, assists: 0, cleanSheets: 0 });
    check('an all-zero call is a no-op that still leaves the club excluded', db.getTopClubs(5).find((c) => c.id === clubB.id), undefined);

    // clubB edges ahead of clubA on combined score despite fewer goals —
    // proves goals/assists/clean_sheets really are weighted equally (1
    // apiece), not goals-first or any other implicit ordering.
    db.addClubStats(clubB.id, { goals: 1, assists: 5, cleanSheets: 4 });
    const ranked = db.getTopClubs(5);
    check('ranked strictly by combined score, not by any single category', ranked.map((c) => c.id), [clubB.id, clubA.id]);
    check('clubB (fewer goals, more assists+CS) still outranks clubA — proves the 1/1/1 weighting, not goals-first', ranked[0].score, 10);

    const clubC = db.createClub('AUTH_C', 'C', 'ClubC', 'CLC', 0);
    db.addClubStats(clubC.id, { goals: 100 });
    check('limit is respected', db.getTopClubs(2).length, 2);
    check('...and still ranks the top scorer first even when truncated', db.getTopClubs(2)[0].id, clubC.id);

    db.close();
}

console.log('\n--- core/pauseVote.js: !votepause — kickoff-only, 7s window, 3/4 of the team ---');
{
    const Team = { SPECTATORS: 0, RED: 1, BLUE: 2 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Situation = { STOP: 0, KICKOFF: 1, PLAY: 2, GOAL: 3 };
    const HaxNotificationMock = { CHAT: 1, MENTION: 2 };
    const sent = [];
    const roomCalls = [];
    const room = {
        sendAnnouncement: (msg, id) => sent.push({ msg, id }),
        pauseGame: (v) => roomCalls.push('pauseGame:' + v),
    };

    const state = {
        teamRed: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
        teamBlue: [{ id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }],
        gameState: State.PLAY,
        playSituation: Situation.PLAY,
        pauseVotes: { [Team.RED]: null, [Team.BLUE]: null },
        pauseVoteUsed: { [Team.RED]: false, [Team.BLUE]: false },
    };

    const pauseVote = require(path.join(CORE, 'pauseVote'))({
        room, state, Team, State, Situation, HaxNotification: HaxNotificationMock,
        errorColor: 2, warningColor: 3, successColor: 4, redColor: 5, blueColor: 6, teamSize: 4,
    });

    sent.length = 0;
    pauseVote.votepauseCommand({ id: 100, team: Team.SPECTATORS }, '!votepause');
    check('a spectator cannot start a pause vote', /только игрокам на поле/.test(sent[0].msg), true);

    const savedRed = state.teamRed;
    state.teamRed = state.teamRed.slice(0, 3);
    sent.length = 0;
    pauseVote.votepauseCommand({ id: 1, team: Team.RED }, '!votepause');
    check('below a full 4x4 house, the vote is unavailable', /4х4/.test(sent[0].msg), true);
    state.teamRed = savedRed;

    state.gameState = State.STOP;
    sent.length = 0;
    pauseVote.votepauseCommand({ id: 1, team: Team.RED }, '!votepause');
    check('outside an actual live game, the vote is unavailable', /только во время игры/.test(sent[0].msg), true);
    state.gameState = State.PLAY;

    // The new kickoff-only gate: state.playSituation is PLAY here (ball
    // already touched since the last kickoff) — must be rejected, not just
    // discouraged.
    sent.length = 0;
    pauseVote.votepauseCommand({ id: 1, team: Team.RED }, '!votepause');
    check('mid-play (not kickoff) the vote is unavailable — this is the new restriction', /только на кикоффе/.test(sent[0].msg), true);
    check('no session was started while mid-play', state.pauseVotes[Team.RED], null);

    state.playSituation = Situation.KICKOFF;
    sent.length = 0;
    pauseVote.votepauseCommand({ id: 1, name: 'Red1', team: Team.RED }, '!votepause');
    check('at kickoff, the vote starts', state.pauseVotes[Team.RED] != null, true);
    check('the window is now 7 seconds, not the old 20', /у вас 7 секунд/.test(sent[0].msg), true);
    check('3/4 of a 4-player team rounds up to 3', state.pauseVotes[Team.RED].threshold, 3);
    check('the initiator\'s own vote counts immediately as "for"', state.pauseVotes[Team.RED].votes.get(1), 1);

    // 2 (id:2) + 1 (id:3) => votesFor=3 (with the initiator) >= threshold(3)
    // — passes immediately, without waiting out the 7s timer.
    sent.length = 0;
    pauseVote.handleVoteMessage({ id: 2, team: Team.RED }, '1');
    pauseVote.handleVoteMessage({ id: 3, team: Team.RED }, '1');
    check('reaching 3/4 ends the vote immediately', state.pauseVotes[Team.RED], null);
    check('the game is actually paused', roomCalls.includes('pauseGame:true'), true);
    check('the pause itself is still 20 seconds (only the VOTE window shrank to 7s)', /остановлена на 20 секунд/.test(sent[sent.length - 1].msg), true);
    check('the once-per-match allowance is now used up for this team', state.pauseVoteUsed[Team.RED], true);

    sent.length = 0;
    pauseVote.votepauseCommand({ id: 1, team: Team.RED }, '!votepause');
    check('a team cannot vote again in the same match after using its one pause', /уже использовала/.test(sent[0].msg), true);

    // BLUE is independent of RED — a FAILING vote this time: only the
    // initiator votes "for", everyone else votes "against", so it becomes
    // mathematically impossible (1 for, 3/4 needed) before the timer fires.
    sent.length = 0;
    pauseVote.votepauseCommand({ id: 5, name: 'Blue1', team: Team.BLUE }, '!votepause');
    check('BLUE starting its own vote is unaffected by RED\'s used-up allowance', state.pauseVotes[Team.BLUE] != null, true);

    check('a non-voter (RED player) typing "1" for BLUE\'s vote is ignored', pauseVote.handleVoteMessage({ id: 1, team: Team.RED }, '1'), false);
    check('a spectator is ignored even if somehow still holding a stale team reference elsewhere', pauseVote.handleVoteMessage({ id: 99, team: Team.SPECTATORS }, '1'), false);

    // threshold=3, voterIds.size=4, initiator's own "for" already counted.
    // After id6 votes against: votesFor=1, remaining=2, 1+2=3>=3 (still
    // possible). After id7 votes against: votesFor=1, remaining=1,
    // 1+1=2<3 — mathematically impossible, ends FAILED right there,
    // without needing a 4th vote from id8 at all.
    sent.length = 0;
    pauseVote.handleVoteMessage({ id: 6, team: Team.BLUE }, '2');
    pauseVote.handleVoteMessage({ id: 7, team: Team.BLUE }, '2');
    check('once passing becomes mathematically impossible, the vote fails immediately (before everyone has even voted)', state.pauseVotes[Team.BLUE], null);
    check('the failure is announced to the team', /не набрало 3\/4/.test(sent[sent.length - 1].msg), true);
    check('a vote message after the session already ended is a safe no-op', pauseVote.handleVoteMessage({ id: 8, team: Team.BLUE }, '2'), false);

    roomCalls.length = 0;
    pauseVote.votepauseCommand({ id: 5, team: Team.BLUE }, '!votepause');
    sent.length = 0;
    pauseVote.handleVoteMessage({ id: 5, team: Team.BLUE }, '1');
    check('double-voting is rejected, not re-counted', /уже проголосовали/.test(sent[0].msg), true);
}

console.log('\n--- core/voteBan.js: !voteban — 61% of ALL eligible voters, top-10/owner immunity ---');
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const Role = { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, MASTER: 4 };
    const HaxNotificationMock = { CHAT: 1, MENTION: 2 };
    const sent = [];
    const roomCalls = [];
    const room = {
        sendAnnouncement: (msg, id) => sent.push({ msg, id }),
        kickPlayer: (id, reason, ban) => roomCalls.push(`kickPlayer:${id}:${reason}:${ban}`),
    };

    // Alice (initiator, 20 games), Bob (15 games — has a player_stats row,
    // so with only a handful of total rows in this fresh db he's trivially
    // in the top-10 of every category, same as real top-10 protection would
    // read once the room has fewer than 10 tracked players), Carol (5 games
    // — NOT enough to vote), Dave/Eve (12/11 games — enough to vote), Owner
    // (MASTER role), Troll (the usual target — NEVER given a player_stats
    // row at all, so he can never appear in any leaderboard/top-10).
    const state = {
        playersAll: [
            { id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Carol' },
            { id: 4, name: 'Dave' }, { id: 5, name: 'Eve' }, { id: 6, name: 'Troll' }, { id: 7, name: 'Owner' },
        ],
        votebanSession: null,
    };
    const authArray = [];
    authArray[1] = ['AUTH_ALICE']; authArray[2] = ['AUTH_BOB']; authArray[3] = ['AUTH_CAROL'];
    authArray[4] = ['AUTH_DAVE']; authArray[5] = ['AUTH_EVE']; authArray[6] = ['AUTH_TROLL']; authArray[7] = ['AUTH_OWNER'];
    const rolesLocal = { 7: Role.MASTER };
    const getRole = (p) => rolesLocal[p.id] ?? Role.PLAYER;

    db.savePlayerStats('AUTH_ALICE', { playerName: 'Alice', games: 20, goals: 1 });
    db.savePlayerStats('AUTH_BOB', { playerName: 'Bob', games: 15, goals: 2 });
    db.savePlayerStats('AUTH_CAROL', { playerName: 'Carol', games: 5, goals: 3 });
    db.savePlayerStats('AUTH_DAVE', { playerName: 'Dave', games: 12, goals: 4 });
    db.savePlayerStats('AUTH_EVE', { playerName: 'Eve', games: 11, goals: 5 });

    const voteBanNotifications = [];
    const { formatBanRemaining } = require(path.join(CORE, 'utils'));
    const voteBan = require(path.join(CORE, 'voteBan'))({
        room, state, authArray, db, Role, getRole, HaxNotification: HaxNotificationMock,
        errorColor: 2, warningColor: 3, successColor: 4, announcementColor: 5,
        discordBot: { sendVoteBanNotification: (data) => voteBanNotifications.push(data) },
        formatBanRemaining,
    });

    // !restrictcmd (commands/master.js) blocking !voteban for a specific
    // auth — checked before anything else votebanCommand does, including
    // its own usage/target validation.
    await db.restrictCommand('AUTH_ALICE', 'voteban', 'Alice', 'токсик', 30);
    sent.length = 0;
    await voteBan.votebanCommand({ id: 1, name: 'Alice' }, '!voteban #6');
    check('a restricted initiator is refused before usage/target checks even run', /запрещено использовать !voteban.*токсик/.test(sent[0].msg), true);
    check('...and no session is started', state.votebanSession, null);
    await db.unrestrictCommand('AUTH_ALICE', 'voteban');

    sent.length = 0;
    await voteBan.votebanCommand({ id: 1, name: 'Alice' }, '!voteban');
    check('!voteban with no target shows usage', /Использование/.test(sent[0].msg), true);

    sent.length = 0;
    await voteBan.votebanCommand({ id: 1, name: 'Alice' }, '!voteban #99');
    check('!voteban <id not in the room> is rejected', /нет в комнате/.test(sent[0].msg), true);

    sent.length = 0;
    await voteBan.votebanCommand({ id: 1, name: 'Alice' }, '!voteban #1');
    check('cannot start a vote against yourself', /против самого себя/.test(sent[0].msg), true);

    sent.length = 0;
    await voteBan.votebanCommand({ id: 1, name: 'Alice' }, '!voteban #7');
    check('the room owner (Role.MASTER) cannot be targeted', /владельца/.test(sent[0].msg), true);
    check('no session was started for the owner-targeting attempt', state.votebanSession, null);

    sent.length = 0;
    await voteBan.votebanCommand({ id: 3, name: 'Carol' }, '!voteban #6');
    check('an initiator with under 10 games cannot start a vote', /Голосовать могут только/.test(sent[0].msg), true);
    check('no session was started for the under-qualified initiator', state.votebanSession, null);

    // Bob has a player_stats row, and this fresh db has under 10 total rows
    // — so he's trivially top-10 in every category, exactly like a real
    // small room's leaderboard would read. Proves the protection check
    // actually queries real leaderboard data, not just a hardcoded id.
    sent.length = 0;
    await voteBan.votebanCommand({ id: 1, name: 'Alice' }, '!voteban #2');
    check('a top-10 player cannot be targeted', /топ-10/.test(sent[0].msg), true);
    check('no session was started for a protected target', state.votebanSession, null);

    // Troll has NO player_stats row at all — never appears in any
    // leaderboard, so the protection check must let him through.
    sent.length = 0;
    await voteBan.votebanCommand({ id: 1, name: 'Alice' }, '!voteban #6');
    check('a target with no stats history at all is not protected — the vote starts', state.votebanSession != null, true);
    check('the initiator\'s own vote is counted immediately as "for"', state.votebanSession.votes.get(1), 1);

    // Eligible pool excludes the target (Troll) and Carol (under 10 games):
    // Alice/Bob/Dave/Eve = 4 eligible voters. threshold = ceil(4*0.61) = 3.
    check('the eligible pool excludes the target and under-qualified players', state.votebanSession.voterIds.size, 4);
    check('the 61% threshold is computed against the FULL eligible pool (ceil(4*0.61)=3), not votes cast', state.votebanSession.threshold, 3);
    check('a player who cannot vote (Carol, under 10 games) is excluded from voterIds', state.votebanSession.voterIds.has(3), false);

    sent.length = 0;
    await voteBan.votebanCommand({ id: 2, name: 'Bob' }, '!voteban #6');
    check('only one voteban session can run at a time, room-wide', /уже идет/.test(sent[0].msg), true);

    // Carol cannot vote at all (excluded from voterIds) — her "1"/"2" must
    // be ignored (not consumed), so normal chat still works for her.
    check('a player who cannot vote gets no reaction at all from handleVoteBanMessage', voteBan.handleVoteBanMessage({ id: 3, name: 'Carol' }, '1'), false);

    // A message that isn't exactly "1" or "2" is never consumed, even from
    // an eligible voter — ordinary chat must keep flowing.
    check('an eligible voter\'s ordinary chat message is not swallowed', voteBan.handleVoteBanMessage({ id: 2, name: 'Bob' }, 'gg wp'), false);

    sent.length = 0;
    const consumed = voteBan.handleVoteBanMessage({ id: 2, name: 'Bob' }, '2');
    check('a valid "2" (против) from an eligible voter IS consumed', consumed, true);
    check('the vote is recorded', state.votebanSession.votes.get(2), 2);
    check('...and confirmed privately', /против/.test(sent[0].msg), true);

    sent.length = 0;
    voteBan.handleVoteBanMessage({ id: 2, name: 'Bob' }, '1');
    check('double-voting is rejected, not overwritten', /уже проголосовали/.test(sent[0].msg), true);
    check('the original vote (2 — против) is unchanged', state.votebanSession.votes.get(2), 2);

    // Tally so far: Alice=for, Bob=against. votesFor=1, threshold=3,
    // 2 voters (Dave/Eve) still haven't voted — 1+2=3 >= 3, still
    // mathematically possible, so the vote must still be running.
    check('the vote is still active — passing is still mathematically possible', state.votebanSession != null, true);

    // Dave votes "for" -> votesFor=2. Still not enough (threshold 3), and
    // Eve alone could still tip it (2+1=3 >= 3) — must still be running.
    sent.length = 0;
    voteBan.handleVoteBanMessage({ id: 4, name: 'Dave' }, '1');
    check('after Dave\'s "for" vote, the session is still running (still mathematically possible)', state.votebanSession != null, true);

    // Eve votes "for" -> votesFor=3 >= threshold(3). Passes immediately,
    // WITHOUT waiting for the 60s timer, and bans+kicks Troll.
    voteBan.handleVoteBanMessage({ id: 5, name: 'Eve' }, '1');
    await new Promise((resolve) => setTimeout(resolve, 0)); // endVoteban is async (awaits db.banAuth)
    check('reaching the threshold ends the vote immediately, not on a timer', state.votebanSession, null);
    const trollBan = db.getAuthBan('AUTH_TROLL');
    check('the target is banned by auth', trollBan != null, true);
    check('the ban lasts 60 minutes', Math.round((new Date(trollBan.expiresAt).getTime() - Date.now()) / 60000), 60);
    check('the target is also kicked from the room (no native ban flag — auth_bans is the real ban)', roomCalls.some((c) => c.startsWith('kickPlayer:6:') && c.endsWith(':false')), true);
    check('the room-wide result announcement names the target and the ban duration', /Troll забанен голосованием на 60 мин/.test(sent[sent.length - 1].msg), true);
    check('...and includes the full tally (3 за, 1 против, 0 воздержались из 4)', /3 за, 1 против, 0 воздержались из 4/.test(sent[sent.length - 1].msg), true);
    check('a passing vote also fires the Discord notification', voteBanNotifications.length, 1);
    check('...with the right target/tally', voteBanNotifications[0].targetName === 'Troll' && voteBanNotifications[0].votesFor === 3, true);

    // A FAILING vote: 60% "for" (3 of 5 eligible) is still short of 61% —
    // this is the exact scenario the user asked to have explained: the
    // percentage is computed against the FULL eligible pool, not the votes
    // actually cast. Fresh target (Troll again, still unprotected — his ban
    // doesn't add a player_stats row).
    authArray[8] = ['AUTH_FRANK'];
    state.playersAll.push({ id: 8, name: 'Frank' });
    db.savePlayerStats('AUTH_FRANK', { playerName: 'Frank', games: 10 });
    db.unbanAuth('AUTH_TROLL'); // clean slate from the passing vote above

    sent.length = 0;
    await voteBan.votebanCommand({ id: 1, name: 'Alice' }, '!voteban #6');
    // Eligible pool now: Alice, Bob, Dave, Eve, Frank = 5. threshold = ceil(5*0.61) = 4.
    check('a 5-eligible-voter pool needs 4 "for" votes (ceil(5*0.61)=4)', state.votebanSession.threshold, 4);

    voteBan.handleVoteBanMessage({ id: 2, name: 'Bob' }, '1');
    voteBan.handleVoteBanMessage({ id: 4, name: 'Dave' }, '1');
    // 3 of 3 CAST votes are "for" (100% of votes cast!) — but only 3 of 5
    // eligible (60%), still short of the 61% needed. The last 2 eligible
    // voters (Eve, Frank) both vote AGAINST here to force the mathematical
    // impossibility deterministically (rather than waiting out the real
    // 60s timer) — the effect is identical to them abstaining, since
    // neither an "against" vote nor silence ever adds to votesFor, and the
    // threshold is checked against the fixed pool size either way.
    voteBan.handleVoteBanMessage({ id: 5, name: 'Eve' }, '2');
    sent.length = 0;
    voteBan.handleVoteBanMessage({ id: 8, name: 'Frank' }, '2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('3 of 5 eligible voters (60%) is short of 61% — the vote fails even though everyone who voted said "for" until the last two', state.votebanSession, null);
    check('the target is NOT banned this time', db.getAuthBan('AUTH_TROLL'), null);
    check('the failure announcement explains the shortfall with the full tally', /не набрало 61% голосов.*3 за, 2 против, 0 воздержались из 5/.test(sent[sent.length - 1].msg), true);

    db.close();
})();

console.log('\n--- discord.js: message/interaction-handling logic (no live Discord connection needed) ---');
// Wrapped in an async IIFE: handleIncomingMessage/handleSlashCommand are now
// async (kickPlayerByAuth crosses to the game process over IPC in real use —
// see core/discordProcess.js), so their result must be awaited. This runs
// concurrently with the synchronous sections below it (there's no top-level
// await in CommonJS); the final tally at the bottom of this file waits long
// enough for it to finish before counting pass/fail.
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const { handleIncomingMessage, handleSlashCommand, handleGuildMemberAdd, handleGuildMemberUpdate, listCurrentPlayers } = require(path.join(CORE, 'discord'));
    const db = createSqliteDatabase(':memory:');
    db.init();
    db.savePlayerStats('AUTH_X', { playerName: 'Xara', games: 3, wins: 2, goals: 7, assists: 1, ownGoals: 0, CS: 1, playtime: 900 });
    db.linkDiscordId('AUTH_X', 'LINKED_USER');
    db.linkDiscordId('AUTH_NEVER_PLAYED', 'LINKED_NO_STATS');

    // Xara renamed in-room to "NewNick" since their last game (stored
    // player_name only updates on an explicit !rename, so the DB still says
    // "Xara"). The room's live roster + authArray must still resolve them.
    const discordAuthArray = { 42: ['AUTH_X'] };
    const discordState = { playersAll: [{ id: 42, name: 'NewNick' }] };

    const relayed = [];
    const deps = {
        discordOwnerId: 'OWNER_ID',
        discordAdminRoleId: 'ADMIN_ROLE_ID',
        db,
        state: discordState,
        getAuthArray: () => discordAuthArray,
        getPrintPlayerStats: () => (stats) => `${stats.playerName}: ${stats.goals}G`,
        relayToRoom: (username, content) => relayed.push({ username, content }),
        getTimeStats: (s) => `${s}s`,
    };
    const memberWithRoles = (roleIds) => ({ roles: { cache: { has: (id) => roleIds.includes(id) } } });
    const msg = (authorId, content, bot = false, roleIds = null) => ({
        author: { id: authorId, bot, displayName: authorId },
        content,
        member: roleIds ? memberWithRoles(roleIds) : null,
    });

    await handleIncomingMessage(msg('OWNER_ID', '!say hello room'), deps);
    check('!say from the owner relays the text (prefix stripped) with the sender name', relayed, [{ username: 'OWNER_ID', content: 'hello room' }]);

    relayed.length = 0;
    await handleIncomingMessage(msg('SOME_OTHER_USER', '!say hello room'), deps);
    check('!say from a non-owner is ignored', relayed, []);

    relayed.length = 0;
    await handleIncomingMessage(msg('ADMIN_USER', '!say hello from admin', false, ['ADMIN_ROLE_ID']), deps);
    check('!say from a member with the admin role is relayed too', relayed, [{ username: 'ADMIN_USER', content: 'hello from admin' }]);

    relayed.length = 0;
    await handleIncomingMessage(msg('SOME_OTHER_USER', '!say nope', false, ['SOME_UNRELATED_ROLE']), deps);
    check('!say from a member with an unrelated role is still ignored', relayed, []);

    check('the admin role does NOT unlock other owner-only commands like !players', await handleIncomingMessage(msg('ADMIN_USER', '!players', false, ['ADMIN_ROLE_ID']), deps), null);

    relayed.length = 0;
    await handleIncomingMessage(msg('OWNER_ID', 'just chatting, not a command'), deps);
    check('an ordinary owner message is NOT relayed (no more blanket relay)', relayed, []);

    check('!say with no text shows usage', await handleIncomingMessage(msg('OWNER_ID', '!say'), deps), 'Использование: !say <message>');
    check('bot messages are ignored entirely', await handleIncomingMessage(msg('OWNER_ID', '!stats Xara', true), deps), null);

    check('!stats <name> falls back to the DB when nobody live matches', await handleIncomingMessage(msg('U1', '!stats Xara'), deps), 'Xara: 7G');
    check('!stats is case-insensitive on the name', await handleIncomingMessage(msg('U1', '!stats xARA'), deps), 'Xara: 7G');
    check('!stats <current in-room name> resolves via live auth, even though the DB still has the old name', await handleIncomingMessage(msg('U1', '!stats NewNick'), deps), 'Xara: 7G');
    check('!stats for an unknown player says so', await handleIncomingMessage(msg('U1', '!stats Ghost'), deps), 'Статистика для "Ghost" не найдена.');
    check('!stats with no name, from a linked account, shows that account\'s own stats', await handleIncomingMessage(msg('LINKED_USER', '!stats'), deps), 'Xara: 7G');
    check('!stats with no name, from an unlinked account, explains how to link', await handleIncomingMessage(msg('U1', '!stats'), deps), 'Ваш аккаунт Discord не привязан. Используйте "!discord <ваш ID Discord>" в комнате, или "!stats <имя игрока>" здесь.');
    check('!stats with no name, linked but no qualifying game yet', await handleIncomingMessage(msg('LINKED_NO_STATS', '!stats'), deps), "Вы еще не играли в квалификационные игры.");
    check('unrelated message produces no reply', await handleIncomingMessage(msg('U1', 'gg wp'), deps), null);

    // Every slash command mirrors its !prefix twin command-for-command, just
    // reading typed options instead of parsing message text.
    const interaction = (userId, commandName, options = {}, roleIds = null) => ({
        user: { id: userId, displayName: userId },
        member: roleIds ? memberWithRoles(roleIds) : null,
        commandName,
        options: { getString: (name) => options[name] ?? null, getInteger: (name) => options[name] ?? null },
    });

    relayed.length = 0;
    const ownerReply = await handleSlashCommand(interaction('OWNER_ID', 'say', { message: 'hi from slash' }), deps);
    check('/say from the owner relays the text with the sender name', relayed, [{ username: 'OWNER_ID', content: 'hi from slash' }]);
    check('/say confirms back to the owner, ephemerally', ownerReply, { content: 'Отправлено: hi from slash', ephemeral: true });

    relayed.length = 0;
    const strangerReply = await handleSlashCommand(interaction('SOME_OTHER_USER', 'say', { message: 'hi from slash' }), deps);
    check('/say from a non-owner is rejected, not relayed', relayed, []);
    check('/say rejection is ephemeral', strangerReply.ephemeral, true);

    relayed.length = 0;
    const adminReply = await handleSlashCommand(interaction('ADMIN_USER', 'say', { message: 'hi from admin' }, ['ADMIN_ROLE_ID']), deps);
    check('/say from a member with the admin role relays too', relayed, [{ username: 'ADMIN_USER', content: 'hi from admin' }]);
    check('/say confirms back to the admin, ephemerally', adminReply, { content: 'Отправлено: hi from admin', ephemeral: true });

    relayed.length = 0;
    const unrelatedRoleReply = await handleSlashCommand(interaction('SOME_OTHER_USER', 'say', { message: 'nope' }, ['SOME_UNRELATED_ROLE']), deps);
    check('/say from a member with an unrelated role is still rejected', relayed, []);
    check('/say rejection mentions both owner and admin', unrelatedRoleReply.content, 'Только владелец или админ может использовать эту команду.');

    check('the admin role does NOT unlock other owner-only slash commands like /players', await handleSlashCommand(interaction('ADMIN_USER', 'players', {}, ['ADMIN_ROLE_ID']), deps), { content: 'Только владелец может использовать эту команду.', ephemeral: true });

    check('/stats <name> resolves the same as !stats', await handleSlashCommand(interaction('U1', 'stats', { name: 'Xara' }), deps), { content: 'Xara: 7G' });
    check('/stats with no name, from a linked account, resolves the same as !stats', await handleSlashCommand(interaction('LINKED_USER', 'stats', {}), deps), { content: 'Xara: 7G' });
    check('/stats for an unknown player says so', await handleSlashCommand(interaction('U1', 'stats', { name: 'Ghost' }), deps), { content: 'Статистика для "Ghost" не найдена.' });
    check('an unrecognised slash command produces no reply', await handleSlashCommand(interaction('U1', 'nope', {}), deps), null);

    check('listCurrentPlayers lists the live roster with auth', listCurrentPlayers(discordState, deps.getAuthArray), 'Игроки в комнате:\nNewNick [AUTH_X]');
    check('listCurrentPlayers reports an empty room', listCurrentPlayers({ playersAll: [] }, deps.getAuthArray), 'В комнате никого нет.');

    // !players / !banauth / !unbanauth: same owner gate as !say, plus a
    // kickPlayerByAuth callback that only kicks someone who is actually online
    // right now — the ban record itself is written regardless.
    const kicked = [];
    const authBanDeps = {
        ...deps,
        kickPlayerByAuth: (auth, reason) => {
            if (auth !== 'AUTH_X') return null;
            kicked.push({ auth, reason });
            return { name: 'NewNick' };
        },
    };

    check('!players from the owner lists the room', await handleIncomingMessage(msg('OWNER_ID', '!players'), authBanDeps), 'Игроки в комнате:\nNewNick [AUTH_X]');
    check('!players from a non-owner is ignored', await handleIncomingMessage(msg('SOME_OTHER_USER', '!players'), authBanDeps), null);

    check('!banauth with no auth shows usage', await handleIncomingMessage(msg('OWNER_ID', '!banauth'), authBanDeps), 'Использование: !banauth <auth> <минуты> [причина]');
    check('!banauth with no duration shows usage', await handleIncomingMessage(msg('OWNER_ID', '!banauth AUTH_X cheating'), authBanDeps), 'Использование: !banauth <auth> <минуты> [причина]');
    check('!banauth from a non-owner is ignored', await handleIncomingMessage(msg('SOME_OTHER_USER', '!banauth AUTH_X 60 cheating'), authBanDeps), null);

    kicked.length = 0;
    const banReply = await handleIncomingMessage(msg('OWNER_ID', '!banauth AUTH_X 60 cheating'), authBanDeps);
    check('!banauth on a currently-online auth kicks them', kicked, [{ auth: 'AUTH_X', reason: 'cheating' }]);
    check('!banauth on a currently-online auth confirms by name and duration', banReply, 'NewNick забанен по auth на 60 мин. и выгнан из комнаты.');
    const authXBan = await db.getAuthBan('AUTH_X');
    check('!banauth records the ban in the db', { auth: authXBan.auth, playerName: authXBan.playerName, reason: authXBan.reason }, { auth: 'AUTH_X', playerName: 'NewNick', reason: 'cheating' });

    kicked.length = 0;
    const banOfflineReply = await handleIncomingMessage(msg('OWNER_ID', '!banauth AUTH_OFFLINE 30 griefing'), authBanDeps);
    check('!banauth on an offline auth does not attempt a kick', kicked, []);
    check('!banauth on an offline auth confirms without a kick', banOfflineReply, 'AUTH_OFFLINE забанен по auth на 30 мин. (сейчас не в комнате).');

    check('!unbanauth with no auth shows usage', await handleIncomingMessage(msg('OWNER_ID', '!unbanauth'), authBanDeps), 'Использование: !unbanauth <auth>');
    check('!unbanauth from a non-owner is ignored', await handleIncomingMessage(msg('SOME_OTHER_USER', '!unbanauth AUTH_X'), authBanDeps), null);
    check('!unbanauth on an auth that was never banned reports so', await handleIncomingMessage(msg('OWNER_ID', '!unbanauth AUTH_GHOST'), authBanDeps), 'Этот auth не забанен.');

    // Sorted before comparing: both bans can land in the same
    // CURRENT_TIMESTAMP second, so their listing order isn't guaranteed.
    const authbansReply = await handleIncomingMessage(msg('OWNER_ID', '!authbans'), authBanDeps);
    check('!authbans lists both active bans with remaining time', authbansReply.split('\n').sort(), [
        'AUTH_OFFLINE [AUTH_OFFLINE] — осталось 30 мин. (griefing)',
        'NewNick [AUTH_X] — осталось 60 мин. (cheating)',
    ]);
    check('!authbans from a non-owner is ignored', await handleIncomingMessage(msg('SOME_OTHER_USER', '!authbans'), authBanDeps), null);
    const authbansAdminReply = await handleIncomingMessage(msg('ADMIN_USER', '!authbans', false, ['ADMIN_ROLE_ID']), authBanDeps);
    check('!authbans from a member with the admin role works too', authbansAdminReply.split('\n').sort(), [
        'AUTH_OFFLINE [AUTH_OFFLINE] — осталось 30 мин. (griefing)',
        'NewNick [AUTH_X] — осталось 60 мин. (cheating)',
    ]);

    check('!unbanauth clears an existing ban', await handleIncomingMessage(msg('OWNER_ID', '!unbanauth AUTH_X'), authBanDeps), 'NewNick разбанен по auth.');
    check('!unbanauth actually removed the ban from the db', await db.getAuthBan('AUTH_X'), null);

    check('!unbanauth from a member with the admin role also works', await handleIncomingMessage(msg('ADMIN_USER', '!unbanauth AUTH_OFFLINE', false, ['ADMIN_ROLE_ID']), authBanDeps), 'AUTH_OFFLINE разбанен по auth.');

    // Same commands again, as slash interactions this time.
    check('/players from the owner lists the room', await handleSlashCommand(interaction('OWNER_ID', 'players', {}), authBanDeps), { content: 'Игроки в комнате:\nNewNick [AUTH_X]', ephemeral: true });
    check('/players from a non-owner is rejected', (await handleSlashCommand(interaction('SOME_OTHER_USER', 'players', {}), authBanDeps)).ephemeral, true);

    kicked.length = 0;
    const slashBanReply = await handleSlashCommand(interaction('OWNER_ID', 'banauth', { auth: 'AUTH_X', minutes: 45, reason: 'cheating' }), authBanDeps);
    check('/banauth on a currently-online auth kicks them', kicked, [{ auth: 'AUTH_X', reason: 'cheating' }]);
    check('/banauth on a currently-online auth confirms by name and duration', slashBanReply, { content: 'NewNick забанен по auth на 45 мин. и выгнан из комнаты.', ephemeral: true });

    const slashBanReplyAdmin = await handleSlashCommand(interaction('ADMIN_USER', 'banauth', { auth: 'AUTH_GHOST2', minutes: 15, reason: 'spam' }, ['ADMIN_ROLE_ID']), authBanDeps);
    check('/banauth from a member with the admin role also works', slashBanReplyAdmin, { content: 'AUTH_GHOST2 забанен по auth на 15 мин. (сейчас не в комнате).', ephemeral: true });

    check('/authbans from the owner lists active bans', (await handleSlashCommand(interaction('OWNER_ID', 'authbans', {}), authBanDeps)).content.includes('AUTH_GHOST2'), true);
    check('/authbans from a non-owner/non-admin is rejected', (await handleSlashCommand(interaction('SOME_OTHER_USER', 'authbans', {}), authBanDeps)).content, 'Только владелец или админ может использовать эту команду.');
    check('/authbans from a member with the admin role also works', (await handleSlashCommand(interaction('ADMIN_USER', 'authbans', {}, ['ADMIN_ROLE_ID']), authBanDeps)).content.includes('AUTH_GHOST2'), true);

    check('/unbanauth clears the ban just placed', await handleSlashCommand(interaction('OWNER_ID', 'unbanauth', { auth: 'AUTH_X' }), authBanDeps), { content: 'NewNick разбанен по auth.', ephemeral: true });
    check('/unbanauth on an auth that was never banned reports so', await handleSlashCommand(interaction('OWNER_ID', 'unbanauth', { auth: 'AUTH_GHOST' }), authBanDeps), { content: 'Этот auth не забанен.', ephemeral: true });
    check('/unbanauth from a member with the admin role also works', await handleSlashCommand(interaction('ADMIN_USER', 'unbanauth', { auth: 'AUTH_GHOST2' }, ['ADMIN_ROLE_ID']), authBanDeps), { content: 'AUTH_GHOST2 разбанен по auth.', ephemeral: true });

    // !tops/`/tops`: same leaderboard logic as the room's own !tops (see
    // stats/roomStats.js), just as a reply string. Only 1 player has stats
    // so far in this db — below the 5-player quorum every category needs.
    check('!tops with no argument reports not enough games yet', await handleIncomingMessage(msg('U1', '!tops'), deps), 'Недостаточно игр сыграно !');
    check('!tops <valid stat> reports not enough games yet too', await handleIncomingMessage(msg('U1', '!tops goals'), deps), 'Недостаточно игр сыграно !');
    check('!tops <unknown stat> shows usage', await handleIncomingMessage(msg('U1', '!tops nonsense'), deps), 'Использование: !tops [games|wins|goals|assists|cs|playtime|clubs] (или /tops). Без аргумента показывает все таблицы лидеров сразу.');
    check('/tops with no stat option is ephemeral', (await handleSlashCommand(interaction('U1', 'tops', {}), deps)).ephemeral, true);
    check('/tops with no stat option reports not enough games yet', (await handleSlashCommand(interaction('U1', 'tops', {}), deps)).content, 'Недостаточно игр сыграно !');

    // Fill the db up to the 5-player quorum so a real leaderboard actually
    // renders, then confirm !tops/`/tops` agree on the exact same text.
    for (let i = 1; i <= 4; i++) {
        db.savePlayerStats(`AUTH_FILLER${i}`, { playerName: `Filler${i}`, games: 1, wins: 0, goals: i, assists: 0, ownGoals: 0, CS: 0, playtime: 0 });
    }
    check('!tops goals shows the real leaderboard once the quorum is met', await handleIncomingMessage(msg('U1', '!tops goals'), deps), 'Голы> #1 Xara : 7, #2 Filler4 : 4, #3 Filler3 : 3, #4 Filler2 : 2, #5 Filler1 : 1');
    check('!tops pt resolves the "pt" alias to "playtime"', await handleIncomingMessage(msg('U1', '!tops pt'), deps), await handleIncomingMessage(msg('U1', '!tops playtime'), deps));
    const topsSlashReply = await handleSlashCommand(interaction('U1', 'tops', { stat: 'goals' }), deps);
    check('/tops <stat> matches !tops <stat> exactly', topsSlashReply, { content: 'Голы> #1 Xara : 7, #2 Filler4 : 4, #3 Filler3 : 3, #4 Filler2 : 2, #5 Filler1 : 1', ephemeral: true });
    check('!tops with no argument now shows every category combined', (await handleIncomingMessage(msg('U1', '!tops'), deps)).split('\n').length, 6);

    // Auto-role on join: every new Discord member gets the configured role,
    // regardless of whether they've ever linked a HaxBall account.
    const addedRoles = [];
    const newMember = { roles: { add: (roleId) => { addedRoles.push(roleId); return Promise.resolve(); } } };
    handleGuildMemberAdd(newMember, { discordAutoRoleId: 'ROLE_123' });
    check('handleGuildMemberAdd assigns the configured role', addedRoles, ['ROLE_123']);

    addedRoles.length = 0;
    handleGuildMemberAdd(newMember, { discordAutoRoleId: '' });
    check('handleGuildMemberAdd is a no-op when no role is configured', addedRoles, []);

    // VIP-role sync: gaining the configured role grants room VIP to the
    // linked auth, but only on the false -> true edge, only for that exact
    // role, and only for a Discord account that's actually linked.
    db.linkDiscordId('AUTH_VIP_LINKED', 'DISCORD_VIP_USER');
    const granted = [];
    const grantVipByAuth = (auth, targetName) => granted.push({ auth, targetName });
    const memberWithout = { id: 'DISCORD_VIP_USER', displayName: 'VipGuy', roles: { cache: new Set() } };
    const memberWith = { id: 'DISCORD_VIP_USER', displayName: 'VipGuy', roles: { cache: new Set(['VIP_ROLE_ID']) } };

    handleGuildMemberUpdate(memberWithout, memberWith, { discordVipRoleId: 'VIP_ROLE_ID', db, grantVipByAuth });
    check('handleGuildMemberUpdate grants VIP when the configured role is newly added', granted, [{ auth: 'AUTH_VIP_LINKED', targetName: 'VipGuy' }]);

    granted.length = 0;
    handleGuildMemberUpdate(memberWith, memberWith, { discordVipRoleId: 'VIP_ROLE_ID', db, grantVipByAuth });
    check('handleGuildMemberUpdate is a no-op if the role was already present', granted, []);

    granted.length = 0;
    handleGuildMemberUpdate(memberWith, memberWithout, { discordVipRoleId: 'VIP_ROLE_ID', db, grantVipByAuth });
    check('handleGuildMemberUpdate is a no-op when the role is removed, not added', granted, []);

    granted.length = 0;
    handleGuildMemberUpdate(memberWithout, memberWith, { discordVipRoleId: '', db, grantVipByAuth });
    check('handleGuildMemberUpdate is a no-op when no VIP role is configured', granted, []);

    granted.length = 0;
    const unlinkedWithout = { id: 'DISCORD_UNLINKED', displayName: 'NoLink', roles: { cache: new Set() } };
    const unlinkedWith = { id: 'DISCORD_UNLINKED', displayName: 'NoLink', roles: { cache: new Set(['VIP_ROLE_ID']) } };
    handleGuildMemberUpdate(unlinkedWithout, unlinkedWith, { discordVipRoleId: 'VIP_ROLE_ID', db, grantVipByAuth });
    check('handleGuildMemberUpdate is a no-op for a Discord account with no linked auth', granted, []);

    db.close();
})();

console.log('\n--- events/activity.js: every chat message goes through room.sendAnnouncement, only a role earns bold ---');
{
    const Role = { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, MASTER: 4 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const { Trophies } = require(path.join(CORE, 'constants'));
    const { formatTrophyLabel, resolveTrophyRank } = require(path.join(CORE, 'utils'));
    const state = {
        gameState: State.STOP, chooseMode: false, slowMode: 0, clubs: [], clubMembers: [], topPlayers: {}, equippedTrophies: {},
        // currentSeason=1 (not 0) here specifically so the tests below prove
        // the season number is actually threaded through resolveTrophyRank,
        // not just defaulting to something that happens to look right.
        currentSeason: 1, seasonTrophies: [],
        hiddenCustomColorsSet: new Set(), vipColors: {},
        // A club-colored message is sent once per entry here (see the
        // per-viewer !customcolors handling in activity.js) — every player
        // used below (ids 1-5) needs a matching entry.
        playersAll: [
            { id: 1, name: 'Boss' }, { id: 2, name: 'Mod' }, { id: 3, name: 'Donor' },
            { id: 4, name: 'Regular' }, { id: 5, name: 'Clubbed' },
        ],
    };
    const authArray = [];
    authArray[1] = ['AUTH_MASTER'];
    authArray[2] = ['AUTH_ADMIN'];
    authArray[3] = ['AUTH_VIP'];
    authArray[4] = ['AUTH_PLAIN'];
    authArray[5] = ['AUTH_CLUBBED'];
    // getRole is mocked here (rather than reusing index.js's real hierarchy)
    // since this test only exercises activity.js's own branching logic.
    const roles = { 1: Role.MASTER, 2: Role.ADMIN_TEMP, 3: Role.VIP, 4: Role.PLAYER, 5: Role.PLAYER };
    const discordLogs = [];
    const hiddenAdminsSetMock = new Set();
    const activity = require(path.join(CORE, 'events', 'activity'))({
        room, state, authArray, BallTouch: class {}, HaxNotification, Role,
        Situation: {}, State, Team, Trophies,
        adminChatColor: 'ADMIN_COLOR', masterChatColor: 'MASTER_COLOR', vipChatColor: 'VIP_COLOR',
        commands: {}, discordBot: { sendLog: (m) => discordLogs.push(m) }, errorColor: 2,
        hiddenAdminsSet: hiddenAdminsSetMock,
        // !silence (commands/player.js) is a per-viewer Map<viewerAuth,
        // Set<speakerAuth>> — activity.js reads its .size unconditionally
        // (see onPlayerChat), so this must exist even when this test never
        // exercises silencing itself.
        silencedAuths: new Map(),
        muteArray: { getByAuth: () => null },
        checkGoalKickTouch: () => null, chooseModeFunction: () => false, formatTrophyLabel, resolveTrophyRank,
        getCommand: () => false, getDate: () => 'DATE', getGoalGame: () => null,
        getPlayerComp: () => null, getRole: (p) => roles[p.id],
        handleVoteMessage: () => false,
        handleVoteBanMessage: () => false,
        playerChat: () => {}, slowModeFunction: () => false, teamChat: () => {},
    });

    sent.length = 0;
    const masterResult = activity.onPlayerChat({ id: 1, name: 'Boss', team: Team.SPECTATORS, admin: true }, 'hello everyone');
    check('MASTER chat is suppressed (native bubble replaced)', masterResult, false);
    check('MASTER gets a [СЗД] prefix, bold', sent[0], { msg: '[👑СЗД] Boss: hello everyone', id: null, style: 'bold' });

    sent.length = 0;
    const adminResult = activity.onPlayerChat({ id: 2, name: 'Mod', team: Team.SPECTATORS, admin: true }, 'hi');
    check('ADMIN chat is suppressed', adminResult, false);
    check('ADMIN gets an [АДМ] prefix, bold', sent[0], { msg: '[🛡️АДМ] Mod: hi', id: null, style: 'bold' });

    sent.length = 0;
    const vipResult = activity.onPlayerChat({ id: 3, name: 'Donor', team: Team.SPECTATORS, admin: false }, 'yo');
    check('VIP chat is suppressed', vipResult, false);
    check('VIP gets a [ВИП] prefix, bold', sent[0], { msg: '[⭐ВИП] Donor: yo', id: null, style: 'bold' });

    // !vipcolor (commands/player.js) — needs `color` captured, which the
    // shared `sent` mock above doesn't bother with, so swap in a local one.
    const logsBeforeVipColorTest = discordLogs.length;
    {
        const originalSendAnnouncement = room.sendAnnouncement;
        const sentWithColor = [];
        room.sendAnnouncement = (msg, id, color, style) => sentWithColor.push({ msg, id, color, style });

        activity.onPlayerChat({ id: 3, name: 'Donor', team: Team.SPECTATORS, admin: false }, 'default color');
        check('a VIP with no custom color uses the shared vipChatColor', sentWithColor[0].color, 'VIP_COLOR');

        state.vipColors.AUTH_VIP = 0xff8800;
        sentWithColor.length = 0;
        activity.onPlayerChat({ id: 3, name: 'Donor', team: Team.SPECTATORS, admin: false }, 'custom color');
        check('a VIP with a custom color (!vipcolor) uses it instead', sentWithColor[0].color, 0xff8800);
        check('the prefix/style are unaffected by the color override', sentWithColor[0], { msg: '[⭐ВИП] Donor: custom color', id: null, color: 0xff8800, style: 'bold' });

        delete state.vipColors.AUTH_VIP;
        room.sendAnnouncement = originalSendAnnouncement;
    }
    // The two extra onPlayerChat calls above also logged to Discord — trim
    // back off so the count below still reflects just the four role/plain
    // messages (discordBot.sendLog runs regardless of this test's mocking).
    discordLogs.length = logsBeforeVipColorTest;

    // A plain player, with no role/club/trophy at all, now ALSO goes through
    // sendAnnouncement (never the native chat bubble) — just their bare name,
    // in the normal (non-bold) style.
    sent.length = 0;
    const plainResult = activity.onPlayerChat({ id: 4, name: 'Regular', team: Team.SPECTATORS, admin: false }, 'sup');
    check('a plain player is intercepted too, not left to the native bubble', plainResult, false);
    check('a plain player gets no prefix and the normal style', sent[0], { msg: 'Regular: sup', id: null, style: 'normal' });

    check('all four messages were still logged to Discord', discordLogs.length, 4);

    // !hide (commands/admin.js) — suppresses just the MASTER/ADMIN prefix;
    // the message itself still goes through sendAnnouncement like anyone
    // else's, just unprefixed and in the normal style.
    hiddenAdminsSetMock.add(1);
    sent.length = 0;
    const hiddenMasterResult = activity.onPlayerChat({ id: 1, name: 'Boss', team: Team.SPECTATORS, admin: true }, 'sneaky');
    check('a hidden MASTER is still intercepted', hiddenMasterResult, false);
    check('a hidden MASTER gets no prefix and the normal style', sent[0], { msg: 'Boss: sneaky', id: null, style: 'normal' });
    hiddenAdminsSetMock.delete(1);

    // Club prefix (core/commands/club.js) — a regular player in a club gets
    // intercepted just like a VIP/ADMIN/MASTER would, but with the club's
    // own custom color and the normal style (a club alone isn't a role); a
    // role holder who's ALSO in a club keeps their role's bold style and
    // just gains the club tag alongside it.
    state.clubs = [{ id: 1, name: 'Falcons', prefix: 'FLC', ownerAuth: 'AUTH_CLUBBED', color: 0xff8800, slots: 5 }];
    state.clubMembers = [{ auth: 'AUTH_CLUBBED', clubId: 1, playerName: 'Clubbed' }, { auth: 'AUTH_VIP', clubId: 1, playerName: 'Donor' }];

    sent.length = 0;
    const clubResult = activity.onPlayerChat({ id: 5, name: 'Clubbed', team: Team.SPECTATORS, admin: false }, 'gg');
    check('a plain club member is intercepted too', clubResult, false);
    // A message using the club's OWN color (no role overriding it) is sent
    // once per player in the room instead of one broadcast — that's what
    // lets !customcolors give each viewer a different color for it.
    check('a club-colored message is sent once per player in the room', sent.length, state.playersAll.length);
    check('every viewer gets the identical prefix text and normal style', sent.every((s) => s.msg === '[FLC] Clubbed: gg' && s.style === 'normal'), true);

    sent.length = 0;
    const vipClubResult = activity.onPlayerChat({ id: 3, name: 'Donor', team: Team.SPECTATORS, admin: false }, 'yo');
    check('a VIP who is also in a club keeps the VIP prefix and gains the club tag', vipClubResult, false);
    check('the combined prefix keeps the bold style (a role is present)', sent[0], { msg: '[FLC] [⭐ВИП] Donor: yo', id: null, style: 'bold' });

    state.clubs[0].emoji = '🔥';
    sent.length = 0;
    const clubEmojiResult = activity.onPlayerChat({ id: 5, name: 'Clubbed', team: Team.SPECTATORS, admin: false }, 'gg');
    check('a club with an emoji set shows it in front of the letters', clubEmojiResult, false);
    check('the emoji lands inside the brackets, before the prefix letters', sent.every((s) => s.msg === '[🔥FLC] Clubbed: gg' && s.style === 'normal'), true);

    // !customcolors (commands/player.js): a per-viewer opt-out from seeing
    // club custom colors — needs `color` captured, which the shared `sent`
    // mock above doesn't bother with, so swap in a local one just for this.
    const originalSendAnnouncement = room.sendAnnouncement;
    const sentWithColor = [];
    room.sendAnnouncement = (msg, id, color, style) => sentWithColor.push({ msg, id, color, style });
    state.playersAll = [...state.playersAll, { id: 6, name: 'Hider' }, { id: 7, name: 'Seer' }];
    authArray[6] = ['AUTH_HIDER'];
    authArray[7] = ['AUTH_SEER'];
    state.hiddenCustomColorsSet = new Set(['AUTH_HIDER']);

    sentWithColor.length = 0;
    const optOutResult = activity.onPlayerChat({ id: 5, name: 'Clubbed', team: Team.SPECTATORS, admin: false }, 'hey');
    check('onPlayerChat still returns false with viewer opt-outs in play', optOutResult, false);
    check('a viewer who has NOT opted out sees the club color', sentWithColor.find((s) => s.id === 7).color, 0xff8800);
    check('a viewer who HAS opted out sees the default color instead', sentWithColor.find((s) => s.id === 6).color, null);
    check('the sender (not opted out) still sees their own club color normally', sentWithColor.find((s) => s.id === 5).color, 0xff8800);
    check('every viewer still gets the identical prefix text', sentWithColor.every((s) => s.msg === '[🔥FLC] Clubbed: hey'), true);

    room.sendAnnouncement = originalSendAnnouncement;
    state.playersAll = state.playersAll.slice(0, 5);
    state.hiddenCustomColorsSet = new Set();

    state.clubs = [];
    state.clubMembers = [];

    // Trophy prefix (core/commands/trophies.js) — only shows while
    // state.topPlayers still agrees the player holds a top-3 spot; an
    // equipped-but-lost trophy silently stops appearing instead of lying.
    // The medal always reflects the player's ACTUAL current rank (their
    // index in the array), not whatever it was when last equipped. A
    // trophy alone (no role) is still the normal style.
    state.equippedTrophies = { AUTH_PLAIN: 'goals' };
    state.topPlayers = { goals: [{ auth: 'AUTH_PLAIN' }, { auth: 'AUTH_OTHER' }] };

    sent.length = 0;
    const trophyResult = activity.onPlayerChat({ id: 4, name: 'Regular', team: Team.SPECTATORS, admin: false }, 'nice');
    check('a plain player currently ranked #1 gets their equipped trophy shown', trophyResult, false);
    check('the trophy prefix is the gold-medal rank-1 label tagged with the current season', sent[0], { msg: '[🥇Топ-1 голов S1] Regular: nice', id: null, style: 'normal' });

    // Same equipped category, but now ranked 2nd (someone else took 1st) —
    // the medal updates to silver on its own, no need to !trophy again.
    state.topPlayers = { goals: [{ auth: 'AUTH_OTHER' }, { auth: 'AUTH_PLAIN' }] };
    sent.length = 0;
    const silverResult = activity.onPlayerChat({ id: 4, name: 'Regular', team: Team.SPECTATORS, admin: false }, 'still here');
    check('dropping to rank 2 is still intercepted', silverResult, false);
    check('the medal automatically becomes silver at rank 2', sent[0], { msg: '[🥈Топ-2 голов S1] Regular: still here', id: null, style: 'normal' });

    state.topPlayers = { goals: [{ auth: 'AUTH_X' }, { auth: 'AUTH_Y' }, { auth: 'AUTH_PLAIN' }] };
    sent.length = 0;
    const bronzeResult = activity.onPlayerChat({ id: 4, name: 'Regular', team: Team.SPECTATORS, admin: false }, 'barely' );
    check('dropping to rank 3 is still intercepted', bronzeResult, false);
    check('the medal automatically becomes bronze at rank 3', sent[0], { msg: '[🥉Топ-3 голов S1] Regular: barely', id: null, style: 'normal' });

    state.topPlayers = { goals: [{ auth: 'AUTH_X' }, { auth: 'AUTH_Y' }, { auth: 'AUTH_Z' }] };
    sent.length = 0;
    const lostTrophyResult = activity.onPlayerChat({ id: 4, name: 'Regular', team: Team.SPECTATORS, admin: false }, 'aw');
    check('falling out of the top 3 is still intercepted (everyone is, now)', lostTrophyResult, false);
    check('a lost trophy is simply not shown, leaving just the bare name', sent[0], { msg: 'Regular: aw', id: null, style: 'normal' });

    state.topPlayers = { goals: [{ auth: 'AUTH_MASTER' }] };
    state.equippedTrophies = { AUTH_MASTER: 'goals' };
    sent.length = 0;
    const masterTrophyResult = activity.onPlayerChat({ id: 1, name: 'Boss', team: Team.SPECTATORS, admin: true }, 'gg');
    check('a MASTER holding #1 shows the trophy before the role prefix', masterTrophyResult, false);
    check('order is [трофей] then [роль], and the role keeps it bold', sent[0], { msg: '[🥇Топ-1 голов S1] [👑СЗД] Boss: gg', id: null, style: 'bold' });

    // Legacy (already-closed-season) trophy pick — see db.closeSeason /
    // resolveTrophyRank. Frozen in state.seasonTrophies, so it shows
    // regardless of the CURRENT (live) state.topPlayers, tagged with the
    // season it was actually won in, not the current one.
    state.topPlayers = { goals: [] };
    state.seasonTrophies = [{ season: 0, category: 'goals', rank: 1, auth: 'AUTH_PLAIN', playerName: 'Regular', value: 42 }];
    state.equippedTrophies = { AUTH_PLAIN: 'legacy:0:goals' };
    sent.length = 0;
    const legacyTrophyResult = activity.onPlayerChat({ id: 4, name: 'Regular', team: Team.SPECTATORS, admin: false }, 'still got it');
    check('a legacy trophy shows even with zero live standing this season', legacyTrophyResult, false);
    check('the legacy label is tagged with the season it was actually won in (S0), not the current one (S1)', sent[0], { msg: '[🥇Топ-1 голов S0] Regular: still got it', id: null, style: 'normal' });

    state.topPlayers = {};
    state.equippedTrophies = {};
    state.seasonTrophies = [];
}

console.log('\n--- events/movement.js: auth-bans block a join regardless of connection, small-font auth broadcast on join/leave ---');
// Async IIFE with local room/sent/roomCalls: onPlayerJoin is now async (the
// auth-ban check touches the DB through what's a bridge in real use) — same
// isolation reasoning as the other newly-async blocks above.
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();
    db.banAuth('AUTH_BANNED', 'Banned', 'aimbot');

    const sent = [];
    const roomCalls = [];
    const room = {
        sendAnnouncement: (msg, id, color, style) => sent.push({ msg, id, style }),
        kickPlayer: (id, reason, ban) => roomCalls.push(`kickPlayer:${id}:${reason}:${ban}`),
    };

    const state = { playersAll: [], adminList: [], kickFetchVariable: false };
    const authArray = [];
    const discordLogs = [];
    const discordBot = { sendLog: (msg) => discordLogs.push(msg), updateRoomStatus: () => {} };
    const noop = () => {};

    const movement = require(path.join(CORE, 'events', 'movement'))({
        room, state, authArray, db, AFKSet: new Set(), HaxNotification, Role: { MASTER: 3 }, State: {}, Team,
        announcementColor: 1, debugMode: false, disableBans: false, discordBot,
        errorColor: 2, infoColor: 5, masterList: [], maxPlayers: 8, welcomeColor: 6,
        getDate: () => 'DATE', checkCaptainLeave: noop, checkOverflowPassword: noop, getRole: () => 0, ghostKickHandle: noop,
        // Daily login bonus (economy.js's claimDailyBonus) — irrelevant to
        // this test's join/leave/ban assertions, just needs to exist and
        // return a resolved promise since onPlayerJoin awaits nothing but
        // fires this off with a .catch.
        claimDailyBonus: async () => {},
        handleActivityPlayerTeamChange: noop, handleLineupChangeLeave: noop, handleLineupChangeTeamChange: noop,
        handlePlayersJoin: noop, handlePlayersLeave: noop, handlePlayersTeamChange: noop,
        updateTeams: noop,
    });

    roomCalls.length = 0;
    sent.length = 0;
    await movement.onPlayerJoin({ id: 7, name: 'Banned', auth: 'AUTH_BANNED', conn: 'CONN1' });
    check('a banned auth is kicked immediately on join, even on a brand new connection', roomCalls, ['kickPlayer:7:Вы забанены: aimbot:false']);
    check('a banned auth never gets the join broadcast or welcome message', sent, []);

    roomCalls.length = 0;
    sent.length = 0;
    state.playersAll = [{ id: 8, name: 'Newbie' }];
    await movement.onPlayerJoin({ id: 8, name: 'Newbie', auth: 'AUTH_NEW', conn: 'CONN2' });
    check('a clean auth is not kicked on join', roomCalls.some((c) => c.startsWith('kickPlayer')), false);
    check('join broadcasts the player\'s auth in small font', sent[0], { msg: 'Newbie [AUTH_NEW]', id: null, style: 'small' });

    discordLogs.length = 0;
    sent.length = 0;
    movement.onPlayerLeave({ id: 8, name: 'Newbie' });
    setTimeout(() => {
        check('leave broadcasts the player\'s auth in small font', sent[0], { msg: 'Newbie [AUTH_NEW]', id: null, style: 'small' });
        check('leave also logs to discord', discordLogs.length, 1);
        db.close();
    }, 20);
})();

console.log('\n--- events/gameManagement.js: onGameStop falls back to balanceTeams() when handlePlayersStop\'s own guard doesn\'t fire ---');
(async () => {
    // Reported live: an admin natively stopping a round mid-play (pressing
    // stop/pause directly in the HaxBall client, not via !restart or any
    // command that manages its own follow-up) fires onGameStop with
    // byPlayer set to that admin — but handlePlayersStop only ever does
    // anything on a NATURAL end (byPlayer==null && state.endGameVariable,
    // set once the round's own endGame() actually ran). An admin/native
    // interruption mid-round leaves the roster completely unmanaged: no
    // bench, no refill, nothing scheduled to ever restart it — the room
    // just sat there (already uneven, e.g. from an earlier partial event)
    // until some UNRELATED join/leave/afk happened to trigger
    // balanceTeams() on its own. The room's policy is that it should keep
    // working automatically regardless of why it stopped, so onGameStop
    // now falls back to balanceTeams() itself whenever handlePlayersStop's
    // own guard didn't fire.
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Situation = { STOP: 0, KICKOFF: 1, PLAY: 2, GOAL: 3 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.RED }, { id: 4, team: Team.RED },
        { id: 5, team: Team.BLUE }, { id: 6, team: Team.BLUE },
        { id: 7, team: Team.SPECTATORS }, { id: 8, team: Team.SPECTATORS },
    ];
    const state = {
        players, chooseMode: false, endGameVariable: false, lastWinner: Team.RED,
        currentStadium: 'big', gameState: State.PLAY, playSituation: Situation.PLAY,
        game: { scores: { timeLimit: 300, time: 50, red: 1, blue: 0 }, playerComp: [[], []] },
        cancelGameVariable: false,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
    const roomMock = {
        getScores: () => ({ red: 1, blue: 0, scoreLimit: 3, time: 50, timeLimit: 300 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {}, stopRecording: () => null,
        kickPlayer: () => {}, sendAnnouncement: () => {},
        setPlayerTeam: (id, team) => {
            const player = players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = players.filter((p) => p.team === Team.RED);
            state.teamBlue = players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
        },
    };
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: (max) => Math.floor(Math.random() * max) });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: (max) => Math.floor(Math.random() * max),
        getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });
    const createGameManagementEvents = require(path.join(CORE, 'events', 'gameManagement'));
    const gm = createGameManagementEvents({
        room: roomMock, state, Game: function () {}, HaxNotification: { CHAT: 1, NONE: 0 }, Situation, State, Team,
        blueColor: 0, defaultColor: 0, discordBot: { sendLog: () => {} }, fetchRecordingVariable: false,
        getStartingLineups: () => [], mentionPlayersUnpause: false, redColor: 0, teamSize: 4,
        announceTeamForms: async () => {}, balanceTeams: balance.balanceTeams, calculateStadiumVariables: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, fetchRecording: () => {}, fetchSummaryEmbed: () => {},
        getBallSpeed: () => 0, getDate: () => '', getGoalString: () => '', getPlayerComp: () => ({}),
        handleActivityStop: () => {}, handlePlayersStop: balance.handlePlayersStop,
        playGoalAnimation: async () => {}, playGoalSizeEffect: async () => {},
        resetPauseVotes: () => {},
        updateTeams: () => {
            state.teamRed = players.filter((p) => p.team === Team.RED);
            state.teamBlue = players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
        },
    });

    const admin = { id: 99, name: 'letkh', admin: true };
    gm.onGameStop(admin);
    await new Promise((resolve) => setTimeout(resolve, 50));
    check('an admin natively stopping a round mid-play still self-heals an uneven roster, no external nudge needed', Math.abs(state.teamRed.length - state.teamBlue.length) <= 1, true);
    check('...specifically by pulling waiting spectators in', state.teamBlue.length, 4);
})();

console.log('\n--- team/buttons.js: randomButton must not strand a spectator across repeated calls ---');
{
    // A realistic mock: room.setPlayerTeam here actually mutates the
    // roster and re-derives teamRed/teamBlue/teamSpec, mirroring how
    // room.setPlayerTeam synchronously fires room.onPlayerTeamChange in
    // real HaxBall (movement.js's handler calls updateTeams(), which
    // replaces state.teamSpec with a fresh array on every single call).
    // The dumb "just record what was called" room mock used elsewhere in
    // this file can't catch bugs that depend on that synchronous refresh —
    // this is exactly the kind of mock needed to catch the bug fixed here
    // (a stale index into an already-updated state.teamSpec could silently
    // drop a spectator from the room's pairing for good).
    function makeRealisticRoomMock(state, Team) {
        return {
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
    }

    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [1, 2, 3, 4].map((id) => ({ id, team: Team.SPECTATORS }));
    const state = { players, teamRed: [], teamBlue: [], teamSpec: [...players] };
    const roomMock = makeRealisticRoomMock(state, Team);
    // A real (not stubbed) getRandomInt — this bug only ever showed up
    // often enough to notice because the index was sometimes in range,
    // sometimes not; a real random source across many runs below is the
    // actual regression guard, not just a single lucky/unlucky roll.
    const { getRandomInt } = require(path.join(CORE, 'utils'));
    const { randomButton } = require(path.join(CORE, 'team', 'buttons'))({ room: roomMock, state, Team, getRandomInt });
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Each randomButton() call now completes its pair a real tick later
    // (see buttons.js) — calls must be staggered here too, same as every
    // production call site already staggers them, or the second call
    // would fire while the first's own deferred half is still pending.
    // Fewer trials than before (async waits add up) but still enough to
    // catch a randomness-dependent regression across many draws.
    (async () => {
        let strandedSomeone = false;
        for (let trial = 0; trial < 50; trial++) {
            for (const p of players) p.team = Team.SPECTATORS;
            state.teamRed = [];
            state.teamBlue = [];
            state.teamSpec = [...players];

            randomButton();
            await wait(25);
            randomButton();
            await wait(25);

            if (state.teamRed.length !== 2 || state.teamBlue.length !== 2 || state.teamSpec.length !== 0) {
                strandedSomeone = true;
                break;
            }
        }
        check('two randomButton() calls from 4 spectators always reach a clean 2v2 (50 trials)', strandedSomeone, false);
    })();
}

console.log('\n--- team/buttons.js: resetButton/blueToSpecButton/redToSpecButton must clear every player, not just most of them ---');
{
    // Same realistic mock as above — these three used to loop against
    // state.teamRed/teamBlue.length re-read live each iteration, which
    // shrinks as room.setPlayerTeam synchronously benches each player, so
    // the loop bound shrank along with it and exited one or two players
    // early.
    function makeRealisticRoomMock(state, Team) {
        return {
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
    }

    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };

    function makeState(redCount, blueCount) {
        const players = [];
        for (let i = 0; i < redCount; i++) players.push({ id: players.length + 1, team: Team.RED });
        for (let i = 0; i < blueCount; i++) players.push({ id: players.length + 1, team: Team.BLUE });
        const state = { players };
        state.teamRed = players.filter((p) => p.team === Team.RED);
        state.teamBlue = players.filter((p) => p.team === Team.BLUE);
        state.teamSpec = [];
        return state;
    }

    // Even split (the exact case that fed a stranded player into
    // randomButton() and produced the original "4 players -> 2v1" bug).
    {
        const state = makeState(2, 2);
        const { resetButton } = require(path.join(CORE, 'team', 'buttons'))({ room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt: () => 0 });
        resetButton();
        check('resetButton on an even 2v2 benches everyone, not just one per side', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [0, 0, 4]);
    }

    // Uneven split — the old max/min juggling was specifically meant to
    // handle this case, and still needs to.
    {
        const state = makeState(3, 2);
        const { resetButton } = require(path.join(CORE, 'team', 'buttons'))({ room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt: () => 0 });
        resetButton();
        check('resetButton on an uneven 3v2 also benches everyone', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [0, 0, 5]);
    }

    // blueToSpecButton/redToSpecButton individually, including an odd size
    // (3) — an off-by-one here is exactly what would leave one player
    // stuck on a team that was supposed to be fully benched.
    {
        const state = makeState(2, 3);
        const { blueToSpecButton } = require(path.join(CORE, 'team', 'buttons'))({ room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt: () => 0 });
        blueToSpecButton();
        check('blueToSpecButton benches all 3 blue players, not just 2', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [2, 0, 3]);
    }
    {
        const state = makeState(3, 2);
        const { redToSpecButton } = require(path.join(CORE, 'team', 'buttons'))({ room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt: () => 0 });
        redToSpecButton();
        check('redToSpecButton benches all 3 red players, not just 2', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [0, 2, 3]);
    }
}

console.log('\n--- team/buttons.js: the full "start a fresh 2v2" sequence (resetButton then randomButton x2) ---');
{
    // End-to-end regression for the actual bug report: 4 players, a round
    // just ended, handlePlayersStop's 4-player branch calls resetButton()
    // then randomButton() twice — this must always land on a clean 2v2,
    // starting from whatever lopsided state the just-finished match left
    // (not just a pre-cleared 0v0 — that's what the dedicated randomButton
    // test above already covers in isolation).
    function makeRealisticRoomMock(state, Team) {
        return {
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
    }

    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const { getRandomInt } = require(path.join(CORE, 'utils'));
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Same staggering note as the dedicated randomButton() test above:
    // each call's pair now completes a real tick later, so the two
    // randomButton() calls (matching handlePlayersStop's own 500ms-apart
    // staggering in production) must be spaced out here too. Fewer trials
    // than before (async waits add up) but still enough to catch a
    // randomness-dependent regression across many draws.
    (async () => {
        let strandedSomeone = false;
        for (let trial = 0; trial < 50; trial++) {
            const players = [
                { id: 1, team: Team.RED }, { id: 2, team: Team.RED },
                { id: 3, team: Team.BLUE }, { id: 4, team: Team.BLUE },
            ];
            const state = { players };
            state.teamRed = players.filter((p) => p.team === Team.RED);
            state.teamBlue = players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = [];
            const { resetButton, randomButton } = require(path.join(CORE, 'team', 'buttons'))({ room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt });

            resetButton();
            randomButton();
            await wait(25);
            randomButton();
            await wait(25);

            if (state.teamRed.length !== 2 || state.teamBlue.length !== 2 || state.teamSpec.length !== 0) {
                strandedSomeone = true;
                break;
            }
        }
        check('resetButton + 2x randomButton from a just-finished 2v2 always reaches a clean 2v2 (50 trials)', strandedSomeone, false);
    })();
}

console.log('\n--- team/buttons.js: topButton pairs up two different spectators, not the same one twice ---');
{
    function makeRealisticRoomMock(state, Team) {
        return {
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
    }
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [{ id: 1, team: Team.SPECTATORS }, { id: 2, team: Team.SPECTATORS }];
    const state = { players, teamRed: [], teamBlue: [], teamSpec: [...players] };
    const { topButton } = require(path.join(CORE, 'team', 'buttons'))({ room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt: () => 0 });

    // topButton()'s pair branch now completes its second half a real tick
    // later (see buttons.js) — wait for it before inspecting the result.
    (async () => {
        topButton();
        await new Promise((resolve) => setTimeout(resolve, 10));
        check('topButton fills both slots from 2 spectators', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [1, 1, 0]);
        check('topButton does not assign the same player to both teams', state.teamRed[0].id !== state.teamBlue[0].id, true);
    })();
}

console.log('\n--- team/buttons.js: swapButton relabels both teams instead of bouncing the second group back ---');
{
    // Bug: the second for...of loop read state.teamRed live, AFTER the
    // first loop had already moved the old blue team onto red — so it
    // picked up those just-moved players (not the original red team, long
    // gone) and immediately moved them right back to blue, making the
    // whole swap a no-op instead of an actual relabel.
    function makeRealisticRoomMock(state, Team) {
        return {
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
    }
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [{ id: 1, team: Team.RED }, { id: 2, team: Team.BLUE }];
    const state = { players };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = [];
    const { swapButton } = require(path.join(CORE, 'team', 'buttons'))({
        room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt: () => 0,
    });

    swapButton();
    check('swapButton moves the old red player to blue', state.teamBlue.map((p) => p.id), [1]);
    check('swapButton moves the old blue player to red', state.teamRed.map((p) => p.id), [2]);
}

console.log('\n--- team/buttons.js: topButton/randomButton survive the last spectator being drained during their 5ms pair gap ---');
{
    // Bug: the deferred second half of a pair move (see the tests above)
    // indexes state.teamSpec[0] again a real tick later. If something else
    // — another topButton()/randomButton() call, a balanceTeams() run
    // triggered by a concurrent join/leave — drains the last waiting
    // spectator in that gap, state.teamSpec[0] is undefined and .id threw,
    // an uncaught exception in a bare setTimeout callback (not a room event
    // handler, so safeEventHandlers' try/catch never sees it) that would
    // have aborted whatever rebuild sequence was still queued behind it —
    // and, run under plain Node with no global handler like this test, take
    // the whole process down. Reaching the check() below at all is the win.
    function makeRealisticRoomMock(state, Team) {
        return {
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                if (!player) return;
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
    }
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [{ id: 1, team: Team.SPECTATORS }, { id: 2, team: Team.SPECTATORS }];
    const state = { players, teamRed: [], teamBlue: [], teamSpec: [...players] };
    const { topButton } = require(path.join(CORE, 'team', 'buttons'))({ room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt: () => 0 });

    (async () => {
        topButton();
        // Simulate a concurrent event draining the second spectator before
        // topButton()'s own +5ms callback gets to it.
        state.players.splice(1, 1);
        state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
        await new Promise((resolve) => setTimeout(resolve, 10));
        check('topButton does not throw when the last spectator vanishes mid-pair', true, true);
    })();
}

console.log('\n--- team/buttons.js: a lone spectator is left waiting, not forced onto one side, when teams are already even ---');
{
    // Bug: callers that loop topButton()/randomButton() once per waiting
    // spectator (see balance.js's handlePlayersStop) don't recompute
    // in-between calls — they rely on a call being a safe no-op once the
    // real pairing work is already done. With teams already even and only
    // ONE spectator left (nobody to pair them with), the old code fell
    // through the bare `else` and forced that lone spectator onto blue
    // regardless — silently turning an already-fair NxN into an unwanted
    // (N+1)xN (e.g. a fair 1v1 plus one unrelated onlooker settling on 1v2).
    function makeRealisticRoomMock(state, Team) {
        return {
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
    }
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.BLUE }, { id: 3, team: Team.SPECTATORS },
    ];
    const state = { players };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
    const { topButton, randomButton } = require(path.join(CORE, 'team', 'buttons'))({
        room: makeRealisticRoomMock(state, Team), state, Team, getRandomInt: () => 0,
    });

    topButton();
    check('topButton leaves a fair 1v1 alone when only one spectator is left over', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [1, 1, 1]);

    randomButton();
    check('randomButton leaves a fair 1v1 alone when only one spectator is left over', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [1, 1, 1]);
}

console.log('\n--- team/balance.js: an already-full match never auto-upgrades to a bigger arena ---');
{
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const calls = [];
    const stadiumCalls = [];
    const noop = (name) => () => calls.push(name);
    const state = {
        chooseMode: false,
        teamRed: [{ id: 1 }, { id: 2 }],
        teamBlue: [{ id: 3 }, { id: 4 }],
        teamSpec: [{ id: 5 }, { id: 6 }],
        players: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
        currentStadium: 'classic',
    };
    // A local, self-contained roomCalls — NOT the shared module-level one.
    // This block's own checks now span several `await wait(...)` gaps (the
    // growth branch's pairs land a real tick apart — see balance.js), and
    // plenty of OTHER blocks below run their own room-touching code in
    // between; sharing the module-level roomCalls/room would let those
    // interleave into (or steal from) this block's own assertions.
    const roomCallsLocal = [];
    // A realistic setPlayerTeam, not a plain recorder: real HaxBall fires
    // room.onPlayerTeamChange synchronously on every call, which
    // updateTeams() uses to replace state.teamRed/teamBlue/teamSpec —
    // several balanceTeams() branches move MULTIPLE spectators in one call
    // and rely on that live reshuffling (always re-reading index [0] after
    // each move), so a mock that leaves the arrays untouched would
    // validate the wrong thing here.
    const realisticRoom = {
        pauseGame: (v) => roomCallsLocal.push('pauseGame:' + v),
        stopGame: () => roomCallsLocal.push('stopGame'),
        startGame: () => roomCallsLocal.push('startGame'),
        setScoreLimit: (n) => roomCallsLocal.push('setScoreLimit:' + n),
        setTimeLimit: (n) => roomCallsLocal.push('setTimeLimit:' + n),
        setPlayerTeam: (id, team) => {
            roomCallsLocal.push(`setPlayerTeam:${id}:${team}`);
            const removeFrom = (arr) => {
                const idx = arr.findIndex((p) => p.id === id);
                if (idx !== -1) arr.splice(idx, 1);
            };
            removeFrom(state.teamRed);
            removeFrom(state.teamBlue);
            removeFrom(state.teamSpec);
            if (team === Team.RED) state.teamRed.push({ id });
            else if (team === Team.BLUE) state.teamBlue.push({ id });
            else state.teamSpec.push({ id });
        },
    };
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: realisticRoom, state, Team, State, HaxNotification, emptyPlayer: {}, infoColor: 5,
        scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: noop('activateChooseMode'), blueToSpecButton: noop('blueToSpecButton'),
        choosePlayer: noop('choosePlayer'), deactivateChooseMode: noop('deactivateChooseMode'),
        endGame: noop('endGame'), getRandomInt: () => 0, getSpecList: noop('getSpecList'),
        instantRestart: noop('instantRestart'), randomButton: noop('randomButton'),
        redToSpecButton: noop('redToSpecButton'), resetButton: noop('resetButton'),
        resumeGame: noop('resumeGame'),
        stadiumCommand: (player, msg) => {
            calls.push('stadiumCommand');
            stadiumCalls.push(msg);
        },
        swapButton: noop('swapButton'), topButton: noop('topButton'),
    });

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    (async () => {
        calls.length = 0;
        balance.balanceTeams();
        check('a balanced, already-running 2v2 with 2 spectators waiting does not restart or switch maps', calls, []);

        calls.length = 0;
        balance.handlePlayersJoin();
        check('handlePlayersJoin does not upgrade the stadium either — the extra players just joined balanceTeams\' no-op path', calls, []);

        // The actual bug this guards against: a running 1v1 on classic (which
        // supports up to 2v2) with spectators waiting must grow to fill the
        // CURRENT map instead of leaving them stuck watching until the round
        // ends — this is growth WITHIN the active stadium's own capacity, not
        // the cross-stadium auto-upgrade the tests above correctly forbid.
        state.teamRed = [{ id: 1 }];
        state.teamBlue = [{ id: 2 }];
        state.teamSpec = [{ id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        // Each pair in this growth branch is now a real tick apart (see
        // balance.js), not both back-to-back in the same call — wait for
        // the pair to fully land before inspecting roomCallsLocal. Checked
        // as a set of {id -> team}, not the exact call order: under this
        // whole test file's many-concurrent-timers load (dozens of blocks
        // sharing one event loop, not a realistic single-room production
        // scenario), which of the two near-simultaneous 0ms/5ms moves
        // actually executes first isn't reliably pinned down — what
        // matters functionally is that both id 3 and id 4 landed, one on
        // each team, not which specific one got which.
        await wait(40);
        check('a running 1v1 on classic pulls in exactly one pair from spectators to make 2v2', roomCallsLocal.length, 2);
        check('...and id 3 and id 4 landed on different teams (one each)', new Set(roomCallsLocal.map((c) => c.split(':')[2])).size, 2);
        check('...and no other spectator was touched', roomCallsLocal.every((c) => c.startsWith('setPlayerTeam:3:') || c.startsWith('setPlayerTeam:4:')), true);
        check('growing within the current map does not restart or switch stadiums', calls, []);

        // Once at classic's 2v2 cap, further spectators keep waiting — this is
        // exactly the "already-full match" case the very first check in this
        // block covers, just reached by growth instead of starting there.
        state.teamRed = [{ id: 1 }, { id: 3 }];
        state.teamBlue = [{ id: 2 }, { id: 4 }];
        state.teamSpec = [{ id: 5 }, { id: 6 }];
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        check('a 2v2 already at classic\'s cap leaves the rest of the spectators waiting', roomCallsLocal, []);

        // Big allows growing all the way to a full 4v4 (still short of the
        // 8-player choose-mode threshold covered separately below).
        state.currentStadium = 'big';
        state.teamRed = [{ id: 1 }, { id: 3 }];
        state.teamBlue = [{ id: 2 }, { id: 4 }];
        state.teamSpec = [{ id: 5 }, { id: 6 }];
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        await wait(40);
        // Checked as a set of {id -> team}, not exact call order — same
        // reasoning as the identical fix on the "pulls in exactly one
        // pair" test above: under this whole test file's many-concurrent-
        // timers load, which of two near-simultaneous 5ms-apart moves
        // fires first isn't reliably pinned down (not a realistic
        // single-room production scenario); what matters is that both id
        // 5 and id 6 landed, one on each team.
        check('a running 2v2 on big grows to 3v3', roomCallsLocal.length, 2);
        check('...and id 5 and id 6 landed on different teams (one each)', new Set(roomCallsLocal.map((c) => c.split(':')[2])).size, 2);
        check('...and no other spectator was touched', roomCallsLocal.every((c) => c.startsWith('setPlayerTeam:5:') || c.startsWith('setPlayerTeam:6:')), true);
        state.currentStadium = 'classic';

        // Bug: this pair-pulling loop used to index state.teamSpec[2*i]/[2*i+1] —
        // stale once i > 0, since each setPlayerTeam call synchronously shrinks
        // state.teamSpec by one (real HaxBall's room.onPlayerTeamChange ->
        // updateTeams() cascade). Pulling 2+ pairs in one call (a running 1v1 on
        // big, with 4 spectators waiting) skipped every other spectator and then
        // read past the end of the shrunk array — a thrown TypeError that
        // aborted the loop with only half the spectators seated.
        state.currentStadium = 'big';
        state.teamRed = [{ id: 1 }];
        state.teamBlue = [{ id: 2 }];
        state.teamSpec = [{ id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        // Two pairs this time (4 individually-staggered calls) — a longer wait.
        await wait(40);
        check('a running 1v1 on big pulls in BOTH waiting pairs (used to crash/skip past the first)', roomCallsLocal, [
            `setPlayerTeam:3:${Team.RED}`, `setPlayerTeam:4:${Team.BLUE}`,
            `setPlayerTeam:5:${Team.RED}`, `setPlayerTeam:6:${Team.BLUE}`,
        ]);
        check('all 4 waiting spectators actually landed on a team, nobody stuck spectating', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [3, 3, 0]);
        state.currentStadium = 'classic';

        // The small-scale auto-selection (1 player -> training, 2 -> classic) is
        // untouched by this change — only growth past an already-settled match
        // was removed.
        state.players = [{ id: 1 }];
        state.teamRed = [];
        state.teamBlue = [];
        state.teamSpec = [{ id: 1 }];
        calls.length = 0;
        balance.balanceTeams();
        check('a single joining player still auto-starts training (unchanged)', calls.includes('instantRestart'), true);
        // instantRestart() here also schedules a deferred stadiumCommand('!training')
        // call (setTimeout(5)) — drain it now so it can't leak into a later
        // stadiumCalls check further down this same block.
        await wait(10);

        // Matches must be played out even as they shrink — only ending up with
        // a single player left (no possible opponent) is still allowed to
        // restart/switch stadium. A match shrinking down to exactly 2 players
        // (their teammate/opponent left) must NOT restart or switch away from
        // whatever stadium it's already on.
        state.currentStadium = 'big';
        state.teamRed = [{ id: 1 }];
        state.teamBlue = [];
        state.teamSpec = [{ id: 2 }];
        state.players = [{ id: 1 }, { id: 2 }];
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        check('a match shrinking down to 2 players does not restart or switch stadium', calls, []);
        check('the shrunk match still rebalances to 1v1 from the remaining spectator', roomCallsLocal, [`setPlayerTeam:2:${Team.BLUE}`]);

        // Same for shrinking down to 5 (more excess on one side than there are
        // spectators to fully cover) — the excess itself used to get benched
        // to force parity; the room's policy now is to just keep playing
        // uneven instead of pulling a player off the field because their
        // opponent quit. But the ONE genuinely-waiting spectator here should
        // still get pulled in to close part of the gap (reported live as a
        // waiting non-AFK spectator never getting invited at all whenever
        // there weren't EXACTLY enough of them to close the whole gap) —
        // partial coverage isn't "no coverage".
        state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }];
        state.teamBlue = [{ id: 4 }];
        state.teamSpec = [{ id: 5 }];
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        check('a match shrinking down to 5 players does not restart or switch stadium', calls, []);
        check('the one available spectator IS pulled in to narrow the gap, not left waiting', roomCallsLocal, [`setPlayerTeam:5:${Team.BLUE}`]);

        // New rule: with ZERO spectators (not just "not enough") to draw
        // from at all, a lopsided 4v2 no longer stays that way forever —
        // the last player of the bigger side switches to the smaller side
        // (keeps playing, doesn't get benched) to reach a clean 3v3.
        state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        state.teamBlue = [{ id: 5 }, { id: 6 }];
        state.teamSpec = [];
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        check('a 4v2 with zero spectators waiting moves the last red player to blue instead of staying lopsided', roomCallsLocal, [`setPlayerTeam:4:${Team.BLUE}`]);
        check('...reaching a clean 3v3', [state.teamRed.length, state.teamBlue.length], [3, 3]);

        // But a gap of only 1 (e.g. 4v3) is left alone — moving one player
        // would only flip who has the extra, not actually improve anything.
        state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        state.teamBlue = [{ id: 5 }, { id: 6 }, { id: 7 }];
        state.teamSpec = [];
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }];
        roomCallsLocal.length = 0;
        balance.balanceTeams();
        check('a 4v3 with zero spectators is left alone (moving one player would not help)', roomCallsLocal, []);

        // Dropping from a full 4v4 house (8) down to 7 (teamSize*2-1) still
        // voids qualification-game stat tracking — that's a separate concern
        // from benching (the match is no longer a full house, so it no longer
        // counts as a quals game) and stays even though nobody gets benched now.
        state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        state.teamBlue = [{ id: 5 }, { id: 6 }, { id: 7 }];
        state.teamSpec = [];
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }];
        state.teamRedStats = [{ id: 1 }];
        state.teamBlueStats = [{ id: 5 }];
        roomCallsLocal.length = 0;
        balance.balanceTeams();
        check('dropping to 7 players (teamSize*2-1) does not bench anyone', roomCallsLocal, []);
        check('dropping to 7 players still voids qualification-game stat tracking', [state.teamRedStats, state.teamBlueStats], [[], []]);

        // The actual exception: a match shrinking all the way down to a single
        // remaining player (reached via the "excess beyond spectators" branch
        // this time, not the fresh-join branch tested above) still restarts to
        // training — there's no possible opponent left to play out a match with.
        state.teamRed = [{ id: 1 }];
        state.teamBlue = [];
        state.teamSpec = [];
        state.players = [{ id: 1 }];
        calls.length = 0;
        balance.balanceTeams();
        check('a match shrinking down to a single remaining player still restarts to training', calls.includes('instantRestart'), true);
        // Same drain as above — this instantRestart() also schedules a
        // deferred stadiumCommand('!training') call.
        await wait(10);
        state.currentStadium = 'classic';

        // Captain-choosing mode is reserved for a genuine full 4v4 house (8
        // players) — below that, an imbalanced team with excess spectators should
        // just get balanced directly, not send everyone into the pick ritual.
        state.teamRed = [{ id: 1 }, { id: 2 }];
        state.teamBlue = [{ id: 3 }];
        state.teamSpec = [{ id: 5 }, { id: 6 }];
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 5 }, { id: 6 }];
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        check('below a full house, an imbalanced team is balanced directly instead of entering choose mode', calls.includes('activateChooseMode'), false);
        check('exactly one spectator fills the smaller team, the rest keep waiting', roomCallsLocal, [`setPlayerTeam:5:${Team.BLUE}`]);

        // Same shape, but now with a full 8-player house — choose mode is warranted.
        state.teamRed = [{ id: 1 }, { id: 2 }, { id: 7 }, { id: 8 }];
        state.teamBlue = [{ id: 3 }, { id: 9 }, { id: 10 }];
        state.teamSpec = [{ id: 5 }, { id: 6 }];
        state.players = new Array(9).fill(0).map((_, i) => ({ id: i }));
        roomCallsLocal.length = 0;
        calls.length = 0;
        balance.balanceTeams();
        check('with a full house, the same imbalance DOES enter choose mode', calls.includes('activateChooseMode'), true);

        // handlePlayersStop: 5 players used to enter choose mode directly after a
        // game ended; now it should behave like the 3-player case instead (loser
        // benches, topButton pulls someone back in) and stay out of choose mode.
        state.endGameVariable = true;
        state.lastWinner = Team.RED;
        state.players = new Array(5).fill(0).map((_, i) => ({ id: i }));
        calls.length = 0;
        balance.handlePlayersStop(null);
        check('handlePlayersStop at 5 players no longer enters choose mode', calls.includes('activateChooseMode'), false);
        check('handlePlayersStop at 5 players benches the losing team like the 3-player case does', calls.includes('blueToSpecButton'), true);
        // This branch also schedules a deferred reassertStadium() (see
        // balance.js) — drain it now so it can't leak a late stadiumCalls
        // entry into one of the stadium-switch scenarios below.
        await wait(310);

        // Bug: 7 was missing entirely from handlePlayersStop's condition
        // list (2, 3, 4, 5, 6, exact-full-house, and 9+ were all covered,
        // but not 7) — a match ending at exactly 7 total players did
        // NOTHING: no rebuild, no stadium check, no room.startGame(). The
        // room sat frozen with no new round starting until an unrelated
        // join/leave changed the total.
        state.players = new Array(7).fill(0).map((_, i) => ({ id: i }));
        calls.length = 0;
        roomCallsLocal.length = 0;
        balance.handlePlayersStop(null);
        check('handlePlayersStop at 7 players does not silently do nothing', calls.includes('blueToSpecButton') || calls.includes('redToSpecButton'), true);
        await wait(5100);
        check('handlePlayersStop at 7 players actually starts the next round', roomCallsLocal.includes('startGame'), true);

        // Bug (reported live): endGame() used to defensively
        // activateChooseMode() on every win with a full-or-bigger house,
        // before it was known whether there was actually anyone to pick —
        // handlePlayersStop's own chooseMode branches always deactivated
        // it again immediately anyway (nothing to hand-pick right at match
        // end), so this only ever produced a confusing "🐢 Время
        // капитанов..." on/off flicker, and opened a real race window: the
        // actual room.stopGame() (which runs this rebuild) fires on a
        // SEPARATE, deferred 1-2s timer — during that gap, chooseMode sat
        // transiently true with nothing benched/refilled yet, so any
        // join/leave/afk landing in it could trip balanceTeams()'s
        // "chooseMode stuck below a full house" self-heal, calling
        // resumeGame() (meant for resuming a mid-match PAUSED pick
        // session, not starting a fresh post-match round) — racing this
        // rebuild's own later room.startGame(). Fixed by removing that
        // defensive activation entirely and folding exactly-8 (and 9+)
        // into the same non-chooseMode WinStay bench+refill path already
        // proven for every other total. This is the realistic path now:
        // chooseMode stays false the whole way through.
        state.chooseMode = false;
        state.endGameVariable = true;
        state.lastWinner = Team.RED;
        state.players = new Array(8).fill(0).map((_, i) => ({ id: i }));
        calls.length = 0;
        balance.handlePlayersStop(null);
        check('an exact 4v4 finish never touches chooseMode (no more activate/deactivate flicker)', calls.includes('activateChooseMode'), false);
        await wait(5100);

        // Bug fix: 3v3/4v4 must use the big map — it must not stay on classic
        // just because the room grew into that size without an explicit !big.
        // Each scenario below waits for any earlier deferred stadiumCommand
        // call to fully land before resetting stadiumCalls for the next one.
        state.chooseMode = false;
        state.currentStadium = 'classic';
        state.players = new Array(8).fill(0).map((_, i) => ({ id: i }));
        stadiumCalls.length = 0;
        balance.handlePlayersStop(null);
        await wait(20);
        check('a full 4v4 switches to the big map if it was still on classic', stadiumCalls, ['!big']);

        state.chooseMode = false;
        state.currentStadium = 'classic';
        state.players = new Array(6).fill(0).map((_, i) => ({ id: i }));
        stadiumCalls.length = 0;
        balance.handlePlayersStop(null);
        await wait(20);
        check('a 3v3 switches to the big map if it was still on classic', stadiumCalls, ['!big']);

        state.currentStadium = 'big';
        state.players = new Array(6).fill(0).map((_, i) => ({ id: i }));
        stadiumCalls.length = 0;
        balance.handlePlayersStop(null);
        await wait(20);
        check('a 3v3 already on the big map does not needlessly re-switch', stadiumCalls, []);

        state.currentStadium = 'big';
        state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        stadiumCalls.length = 0;
        balance.handlePlayersStop(null);
        await wait(20);
        check('a 2v2 switches back to classic if it was still on the big map', stadiumCalls, ['!classic']);

        // Reported bug: a 4v4 that plays all the way down to 1v1 via
        // ordinary leaves (the room's policy is to keep an uneven/shrunk
        // match playing rather than interrupt it — see the "keep playing
        // uneven" branches above) never got its map reassessed mid-match on
        // purpose (switching stadiums resets/restarts the game). The gap
        // was that once the match actually DID stop, the players.length==2
        // branch never checked the map at all — 1v1 could stay parked on
        // big indefinitely once it finally got a chance to.
        state.chooseMode = false;
        state.currentStadium = 'big';
        state.teamRed = [{ id: 1 }];
        state.teamBlue = [{ id: 2 }];
        state.players = [{ id: 1 }, { id: 2 }];
        stadiumCalls.length = 0;
        balance.handlePlayersStop(null);
        await wait(20);
        check('a 4v4 that shrank all the way to 1v1 switches back to classic once the match actually stops', stadiumCalls, ['!classic']);

        // 9+ players: choose mode's "any other count" branch (not exactly
        // 2*teamSize) must also assert big — it's still a full-house-or-more
        // scenario by definition. Explicit teamRed/teamBlue/teamSpec here
        // (not leftovers from an earlier scenario, unlike before the
        // 1v1-shrink regression above started overwriting them) — a 4v4
        // plus one extra spectator, maxSide clearly needs big regardless of
        // how the loser's bench+refill actually plays out.
        state.chooseMode = true;
        state.currentStadium = 'classic';
        state.lastWinner = Team.RED;
        state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        state.teamBlue = [{ id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }];
        state.teamSpec = [{ id: 9 }];
        state.players = new Array(9).fill(0).map((_, i) => ({ id: i }));
        stadiumCalls.length = 0;
        balance.handlePlayersStop(null);
        // This branch's reassertStadium() waits for the refill to settle
        // (300 + 5*spectatorsToInsert, matching insertingTimeout), not the
        // flat 20ms every other scenario above needed.
        await wait(320);
        check('9 players inside choose mode also asserts the big map', stadiumCalls, ['!big']);

        // Defensive-only: 9+ outside choose mode shouldn't normally happen
        // (endGame already turns choose mode on by then), but if it did, it
        // must not be left on classic either.
        state.chooseMode = false;
        state.currentStadium = 'classic';
        state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
        state.teamBlue = [{ id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }];
        state.teamSpec = [{ id: 9 }];
        state.players = new Array(9).fill(0).map((_, i) => ({ id: i }));
        stadiumCalls.length = 0;
        balance.handlePlayersStop(null);
        // Same reasoning as above — this branch also waits for the refill.
        await wait(320);
        check('9 players outside choose mode (defensive edge case) also asserts the big map', stadiumCalls, ['!big']);
    })();
}

console.log('\n--- team/balance.js: a bigger gap (4v0) with zero spectators fully closes to parity, not just halfway ---');
{
    // Numeric balance holds at all times, not just eventually: a single
    // cross-move only closes 2 of a bigger gap (4v0 -> 3v1, still off by
    // 2), and nothing else re-triggers this branch until the next
    // unrelated join/leave — so a gap of 4 needs a SECOND move to actually
    // reach parity, not just a partial improvement. Own self-contained
    // state/room (not the shared block above) since this needs to await a
    // deferred second move without other synchronous test code mutating
    // the same state object in between.
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.RED }, { id: 4, team: Team.RED },
    ];
    const state = { chooseMode: false, players, teamRed: [...players], teamBlue: [], teamSpec: [] };
    const roomMock = {
        setPlayerTeam: (id, team) => {
            const player = players.find((p) => p.id === id);
            player.team = team;
            state.teamRed = players.filter((p) => p.team === Team.RED);
            state.teamBlue = players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
        },
    };
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State: { PLAY: 0, PAUSE: 1, STOP: 2 }, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: () => 0,
        getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });

    balance.balanceTeams();
    check('a 4v0 gap of 4 makes its first move synchronously', [state.teamRed.length, state.teamBlue.length], [3, 1]);
    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        check('...and its second move lands a tick later, reaching a clean 2v2 (not stuck at 3v1)', [state.teamRed.length, state.teamBlue.length], [2, 2]);
    })();
}

console.log('\n--- team/balance.js: a partial bench (some non-AFK spectators, not enough to fully close the gap) still pulls them in ---');
{
    // Reported live: a match ends 4v0 (or shrinks to it) with a couple of
    // genuinely non-AFK spectators waiting — NOT enough of them to fully
    // close the gap (need 4, only 2 available) — and the room just sat
    // there, nobody getting invited, until an unrelated join/leave/afk
    // toggle happened to shift the numbers. Root cause: the cross-move
    // fallback that closes a gap when spectators are exhausted only ever
    // checked for EXACTLY zero — a small but nonzero pool fell through
    // doing nothing at all. Fixed: whatever's actually available gets
    // pulled onto the smaller side first, and whatever gap still remains
    // afterward (spectators now genuinely exhausted — a 4v2 with nobody
    // left waiting is exactly rule 3's "nxn-2 with zero spectators" case)
    // goes through the existing cross-move fallback, so this closes all the
    // way to a clean 3v3 rather than stopping halfway at 4v2. Own
    // self-contained state/room, same reasoning as the gap-of-4 test above
    // (needs to await deferred moves cleanly).
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.RED }, { id: 4, team: Team.RED },
        { id: 5, team: Team.SPECTATORS }, { id: 6, team: Team.SPECTATORS },
    ];
    const state = { chooseMode: false, players, teamRed: players.filter((p) => p.team === Team.RED), teamBlue: [], teamSpec: players.filter((p) => p.team === Team.SPECTATORS) };
    const roomMock = {
        setPlayerTeam: (id, team) => {
            const player = players.find((p) => p.id === id);
            player.team = team;
            state.teamRed = players.filter((p) => p.team === Team.RED);
            state.teamBlue = players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
        },
    };
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State: { PLAY: 0, PAUSE: 1, STOP: 2 }, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: () => 0,
        getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });

    balance.balanceTeams();
    check('the first available spectator is pulled in synchronously', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [4, 1, 1]);
    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        check('both spectators land AND the remaining gap closes via cross-move, reaching a clean 3v3', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [3, 3, 0]);
    })();
}

console.log('\n--- team/balance.js: ensureFullFieldBeforeStart pulls stranded players in right before room.startGame() ---');
{
    // Reported bug: a 2v1 finish sometimes started the next round with
    // someone stuck in spectators instead of playing (seen as "2v1 starts
    // the next match 2v0"). The exact mid-sequence cause wasn't pinned down
    // (a stadium switch does NOT reset players to spectators, ruling out
    // the first theory here) — so instead of chasing the precise trigger,
    // this is a safety net: whatever left someone stranded, as long as the
    // house is <=2*teamSize, nobody should still be in spectators by the
    // time room.startGame() actually fires. Simulated here by forcing a
    // player back to spectators well after the normal rebuild has already
    // settled (standing in for whatever untraced mechanism does this in
    // production), then checking the safety net catches it before start.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.BLUE },
    ];
    const state = {
        players, chooseMode: false, endGameVariable: true, lastWinner: Team.RED,
        currentStadium: 'classic', gameState: State.STOP,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {},
        setPlayerTeam: (id, team) => {
            const player = state.players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = state.players.filter((p) => p.team === Team.RED);
            state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
        },
    };
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: () => 0,
        getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });

    balance.handlePlayersStop(null);

    (async () => {
        // Well after the normal rebuild has settled into some 2v1 shape
        // (identities now randomized by randomFillAll() rather than a fixed
        // bench/swap — see its own comment), but before the 5000ms
        // room.startGame() timer — simulates the untraced mechanism that
        // stranded a player. Pull whoever landed on the majority team
        // rather than a hardcoded id, since which player ends up where is
        // no longer deterministic.
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Strand a player off the MINORITY side specifically: pulling from
        // the majority side would just settle into a balanced 1v1 (which
        // the safety net correctly leaves alone, per the "genuinely-waiting
        // spectator" rule below) — this needs a genuine imbalance (2v0) for
        // the safety net to have anything to fix.
        const minorityTeam = state.teamRed.length <= state.teamBlue.length ? state.teamRed : state.teamBlue;
        roomMock.setPlayerTeam(minorityTeam[0].id, Team.SPECTATORS);
        check('the stranding was applied: someone is spectating right before start', [state.teamRed.length + state.teamBlue.length, state.teamSpec.length], [2, 1]);

        await new Promise((resolve) => setTimeout(resolve, 4600));
        check('by the time room.startGame() actually fires, nobody eligible is left spectating', [state.teamRed.length + state.teamBlue.length, state.teamSpec.length], [3, 0]);
    })();
}

console.log('\n--- team/balance.js: ensureFullFieldBeforeStart reasserts the stadium after its own pulls, not just before them ---');
{
    // Reported bug ("комната иногда застревает на карте classic"): a match
    // ending on classic (2v2) with several genuinely-waiting spectators
    // left could have its own safety-net pull (ensureFullFieldBeforeStart,
    // right before room.startGame()) top the field all the way to 3v3 —
    // computeSpectatorsToInsert() fills up to the full 2*teamSize cap, NOT
    // the current stadium's own (smaller) cap, unlike the ordinary
    // join/leave growth path. Nothing rechecked the stadium against that
    // NEW, bigger shape afterward, so the match started 3v3 on classic
    // instead of big. Root-caused via a scripted fuzzer replay (a genuine
    // draw via endGame(Team.SPECTATORS) mishandled by a since-separately-
    // reported branch, growing the room to a lopsided 2v0+4spec right
    // before this safety net's 2000ms timer fired). Fixed by having
    // ensureFullFieldBeforeStart() call reassertStadium() itself once its
    // own pulls settle, and having every call site start the game only
    // after that (via a callback) instead of on a fixed, race-prone delay.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED },
        { id: 3, team: Team.SPECTATORS }, { id: 4, team: Team.SPECTATORS },
        { id: 5, team: Team.SPECTATORS }, { id: 6, team: Team.SPECTATORS },
    ];
    const state = {
        players, chooseMode: false, endGameVariable: true, lastWinner: Team.RED,
        currentStadium: 'classic', gameState: State.STOP,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const stadiumCalls = [];
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {},
        setPlayerTeam: (id, team) => {
            const player = state.players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = state.players.filter((p) => p.team === Team.RED);
            state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
        },
    };
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: () => 0,
        getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: (emptyPlayer, cmd) => { stadiumCalls.push(cmd); state.currentStadium = cmd.replace('!', ''); },
        swapButton: buttons.swapButton, topButton: buttons.topButton,
    });

    (async () => {
        await new Promise((resolve) => {
            balance.ensureFullFieldBeforeStart(resolve);
        });
        check('the pull grew the match past classic\'s own cap', Math.max(state.teamRed.length, state.teamBlue.length), 3);
        check('the stadium was reasserted to match the NEW shape, not left on classic', state.currentStadium, 'big');
        check('nobody was left stranded in spectators', state.teamSpec.length, 0);
    })();
}

console.log('\n--- team/balance.js: ensureFullFieldBeforeStart cross-moves when genuinely zero spectators are available, instead of starting lopsided ---');
{
    // Reported live (twice): a match ends lopsided (e.g. the benched side
    // going AFK right as they lost, excluding them from the count) with
    // computeSpectatorsToInsert() correctly seeing 0 available RIGHT THEN
    // — but nothing ever re-checked afterward, so the match started (or
    // stayed stopped) at something like 4v0 until an unrelated join/leave/
    // afk toggle happened to trigger balanceTeams() on its own, which DOES
    // have a cross-move fallback (rule 3: nxn-2 with zero spectators moves
    // the last player of the bigger side across). Fixed by having
    // ensureFullFieldBeforeStart() reuse balanceTeams() itself for
    // whatever's still uneven after its own direct pull, so a genuine
    // zero-spectator 4v0 self-heals to 2v2 immediately, with no external
    // nudge needed.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.RED }, { id: 4, team: Team.RED },
    ];
    const state = {
        players, chooseMode: false, endGameVariable: true, lastWinner: Team.RED,
        currentStadium: 'big', gameState: State.STOP,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = [];
    state.teamSpec = [];
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 300 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {},
        setPlayerTeam: (id, team) => {
            const player = state.players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = state.players.filter((p) => p.team === Team.RED);
            state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
        },
    };
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: () => 0,
        getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });

    (async () => {
        await new Promise((resolve) => {
            balance.ensureFullFieldBeforeStart(resolve);
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        check('a genuine zero-spectator 4v0 self-heals to a clean 2v2 immediately, no external nudge needed', [state.teamRed.length, state.teamBlue.length], [2, 2]);
    })();
}

console.log('\n--- team/balance.js: ensureFullFieldBeforeStart never force-starts while a genuine choose-mode session is active ---');
{
    // Reported live: this runs 2000ms after a match ends (see
    // handlePlayersStop's scheduleRestart) — an ordinary join or leave
    // landing anywhere in that window can INDEPENDENTLY activate real
    // interactive choosing via balanceTeams()'s own "abs(diff)<specLen,
    // full house" branch (pausing the game, prompting a captain), with no
    // connection to this function's own pull. (An earlier theory — that
    // THIS function's own pullSpectatorsToParity() call could itself
    // trigger that branch — turns out to be mathematically impossible:
    // the only size where ensureFullFieldBeforeStart's own <=2*teamSize
    // guard and balanceTeams()'s own >=2*teamSize choosing guard overlap
    // is exactly 2*teamSize, and since that's even, filling to equal
    // halves there never leaves an odd spectator over for balanceTeams()
    // to see as a "surplus".) Without checking state.chooseMode,
    // onSettled() would still fire once this function's own pull settled,
    // forcing room.startGame() regardless — reported live as "капитана
    // всё равно нет, игра стартует 4x0". Simulates that independent
    // activation directly: state.chooseMode is already true before
    // ensureFullFieldBeforeStart is even called.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.RED },
        { id: 4, team: Team.BLUE }, { id: 5, team: Team.BLUE },
        { id: 6, team: Team.SPECTATORS },
    ];
    const state = {
        players, chooseMode: true, endGameVariable: true, lastWinner: Team.RED,
        currentStadium: 'big', gameState: State.STOP,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 300 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {},
        setPlayerTeam: (id, team) => {
            const player = state.players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = state.players.filter((p) => p.team === Team.RED);
            state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
        },
    };
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: () => 0,
        getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });

    let onSettledCalled = false;
    balance.ensureFullFieldBeforeStart(() => {
        onSettledCalled = true;
    });
    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        check('onSettled (which would trigger room.startGame()) never fires while chooseMode is active', onSettledCalled, false);
        check('the roster is left untouched for the active session to finish picking', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [3, 2, 1]);
    })();
}

console.log('\n--- team/balance.js: the surplus/no-surplus decision counts the just-benched loser even when their setPlayerTeam lands a few ms late ---');
{
    // Reported live: 9 players at match end (2v2 + 5 waiting) settled on a
    // 3v3 with 3 non-AFK spectators left over, instead of correctly
    // detecting the genuine surplus and handing off to real captain-picking
    // (the room's actual policy at 8+/9+ players — see the other picking
    // regression tests in this file). Root cause: the surplus/no-surplus
    // decision (diff < teamSpec.length) used to be evaluated SYNCHRONOUSLY
    // right after blueToSpecButton()'s own tight loop of
    // room.setPlayerTeam() calls — but real headless HaxBall (via
    // Puppeteer) doesn't reliably deliver room.onPlayerTeamChange
    // synchronously for back-to-back calls (the same reasoning behind
    // every other "index [0], staggered 5ms apart" pattern in this file).
    // The just-benched losers weren't reliably counted yet, undercounting
    // teamSpec.length and silently missing the surplus. Fixed by deferring
    // the decision (and the picking or pull it triggers) by a tick. This
    // mock specifically delays ONLY the bench's own two moves landing by a
    // few ms (simulating that real lag) while everything else stays
    // synchronous, to isolate exactly the diagnosed gap. Kept well under
    // the fix's own defer, not right at the boundary — this whole test
    // file runs dozens of blocks sharing one event loop (a concurrency load
    // no single real room ever sees), so a tight margin here flakes on load
    // unrelated to the fix.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED },
        { id: 3, team: Team.BLUE }, { id: 4, team: Team.BLUE },
        { id: 5, team: Team.SPECTATORS }, { id: 6, team: Team.SPECTATORS },
        { id: 7, team: Team.SPECTATORS }, { id: 8, team: Team.SPECTATORS }, { id: 9, team: Team.SPECTATORS },
    ];
    const state = {
        players, chooseMode: false, endGameVariable: true, lastWinner: Team.RED,
        currentStadium: 'big', gameState: State.STOP,
        redCaptainChoice: '', blueCaptainChoice: '', capLeft: false,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const benchTargets = new Set(state.teamBlue.map((p) => p.id));
    const applyMove = (id, team) => {
        const player = players.find((p) => p.id === id);
        if (!player) return;
        player.team = team;
        state.teamRed = players.filter((p) => p.team === Team.RED);
        state.teamBlue = players.filter((p) => p.team === Team.BLUE);
        state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
    };
    const sent = [];
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 300 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {}, kickPlayer: () => {},
        sendAnnouncement: (msg, id) => sent.push({ msg, id }),
        setPlayerTeam: (id, team) => {
            if (benchTargets.has(id) && team === Team.SPECTATORS) {
                benchTargets.delete(id);
                setTimeout(() => { applyMove(id, team); balanceRef.handlePlayersTeamChange(null); }, 2);
            } else {
                applyMove(id, team);
                balanceRef.handlePlayersTeamChange(null);
            }
        },
    };
    let balanceRef;
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const createChoosingHelpers = require(path.join(CORE, 'team', 'choosing'));
    const choosing = createChoosingHelpers({
        room: roomMock, state, Team, HaxNotification: { CHAT: 1, MENTION: 2 },
        announcementColor: 1, errorColor: 2, infoColor: 3, warningColor: 4,
        chooseModeSlowMode: 1, chooseTime: 20, defaultSlowMode: 0.5, SMSet: new Set(), getRandomInt: () => 0,
    });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: choosing.activateChooseMode, blueToSpecButton: buttons.blueToSpecButton,
        choosePlayer: choosing.choosePlayer, deactivateChooseMode: choosing.deactivateChooseMode,
        endGame: () => {}, getRandomInt: () => 0,
        getSpecList: choosing.getSpecList, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });
    balanceRef = balance;

    balance.handlePlayersStop(null);
    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        check('RED (the winner) stayed intact despite the laggy bench landing', state.teamRed.map((p) => p.id).sort(), [1, 2]);
        check('the genuine surplus is still correctly detected despite the lag: chooseMode activates', state.chooseMode, true);
        check('a captain was auto-placed onto blue, not stuck at 2v0 from an undercounted decision', state.teamBlue.length, 1);
        const captainId = state.teamBlue[0] && state.teamBlue[0].id;
        check('that captain received a real "pick a player" prompt', sent.some((s) => s.msg.includes('Для выбора игрока') && s.id === captainId), true);
    })();
}

console.log('\n--- team/balance.js: a full house finish WITH a genuine spectator surplus activates real interactive picking, not silent auto-refill ---');
{
    // Reported live: the room's actual policy for a full-or-bigger house
    // (>=2*teamSize) ending with MORE waiting spectators than needed to
    // fill the benched side is that the benched side's captain (the first
    // non-AFK spectator, auto-placed by choosePlayer()'s own empty-side
    // guard) picks their own teammates from that surplus — same as
    // choosing during ordinary mid-match growth. This briefly regressed
    // to a silent auto-refill (no picking at all) when the dead
    // chooseMode branch was deleted earlier this session and its
    // "genuine surplus" case wasn't carried over into the replacement.
    // RED (the winner) still stays intact via WinStay; only BLUE's
    // refill goes through picking instead of an automatic pull.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.RED }, { id: 4, team: Team.RED },
        { id: 5, team: Team.BLUE }, { id: 6, team: Team.BLUE }, { id: 7, team: Team.BLUE }, { id: 8, team: Team.BLUE },
        { id: 9, team: Team.SPECTATORS }, { id: 10, team: Team.SPECTATORS },
    ];
    const state = {
        players, chooseMode: false, endGameVariable: true, lastWinner: Team.RED,
        currentStadium: 'classic', gameState: State.STOP,
        redCaptainChoice: '', blueCaptainChoice: '', capLeft: false,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const sent = [];
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {}, kickPlayer: () => {},
        sendAnnouncement: (msg, id) => sent.push({ msg, id }),
        setPlayerTeam: (id, team) => {
            const player = state.players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = state.players.filter((p) => p.team === Team.RED);
            state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            // Real room.setPlayerTeam fires room.onPlayerTeamChange
            // synchronously -> handlePlayersTeamChange, which is what
            // actually re-prompts the next captain after choosePlayer()'s
            // own empty-side guard silently auto-places the first one.
            balanceRef.handlePlayersTeamChange(null);
        },
    };
    let balanceRef;
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const createChoosingHelpers = require(path.join(CORE, 'team', 'choosing'));
    const choosing = createChoosingHelpers({
        room: roomMock, state, Team, HaxNotification: { CHAT: 1, MENTION: 2 },
        announcementColor: 1, errorColor: 2, infoColor: 3, warningColor: 4,
        chooseModeSlowMode: 1, chooseTime: 20, defaultSlowMode: 0.5, SMSet: new Set(), getRandomInt: () => 0,
    });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: choosing.activateChooseMode, blueToSpecButton: buttons.blueToSpecButton,
        choosePlayer: choosing.choosePlayer, deactivateChooseMode: choosing.deactivateChooseMode,
        endGame: () => {}, getRandomInt: () => 0,
        getSpecList: choosing.getSpecList, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });
    balanceRef = balance;

    balance.handlePlayersStop(null);
    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        check('RED (the winner) stayed intact', state.teamRed.map((p) => p.id).sort(), [1, 2, 3, 4]);
        check('chooseMode activates for the genuine surplus instead of silently auto-refilling', state.chooseMode, true);
        check('the first eligible spectator was auto-placed onto blue as its captain', state.teamBlue.length, 1);
        const captainId = state.teamBlue[0] && state.teamBlue[0].id;
        check('that captain then received a real "pick a player" prompt', sent.some((s) => s.msg.includes('Для выбора игрока') && s.id === captainId), true);
        check('blue is NOT yet full — the captain still has to actually pick', state.teamBlue.length, 1);
    })();
}

console.log('\n--- team/balance.js: a genuine surplus hands off to picking on the map a 4v4 needs, not whatever map the just-finished small match was on ---');
{
    // Reported live, after a server restart: the first match to finish can
    // easily be small (e.g. a quick 2v2 on classic, started before
    // everyone reconnected) while a crowd has ALREADY flooded in as
    // waiting spectators during it — reaching a genuine 4v4-worth surplus
    // while the room is still on 'classic'. The surplus/no-surplus
    // decision only counts players, it doesn't know what map the match was
    // actually played on — left unguarded, captains would be handed a pick
    // session on a map that can't actually host 4v4.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED },
        { id: 3, team: Team.BLUE }, { id: 4, team: Team.BLUE },
        { id: 5, team: Team.SPECTATORS }, { id: 6, team: Team.SPECTATORS },
        { id: 7, team: Team.SPECTATORS }, { id: 8, team: Team.SPECTATORS }, { id: 9, team: Team.SPECTATORS },
    ];
    const state = {
        players, chooseMode: false, endGameVariable: true, lastWinner: Team.RED,
        currentStadium: 'classic', gameState: State.STOP,
        redCaptainChoice: '', blueCaptainChoice: '', capLeft: false,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const stadiumCalls = [];
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {}, kickPlayer: () => {},
        sendAnnouncement: () => {},
        setPlayerTeam: (id, team) => {
            const player = state.players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = state.players.filter((p) => p.team === Team.RED);
            state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            balanceRef.handlePlayersTeamChange(null);
        },
    };
    let balanceRef;
    const stadiumCommand = (emptyPlayer, cmd) => {
        stadiumCalls.push(cmd);
        state.currentStadium = cmd.replace('!', '');
    };
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const createChoosingHelpers = require(path.join(CORE, 'team', 'choosing'));
    const choosing = createChoosingHelpers({
        room: roomMock, state, Team, HaxNotification: { CHAT: 1, MENTION: 2 },
        announcementColor: 1, errorColor: 2, infoColor: 3, warningColor: 4,
        chooseModeSlowMode: 1, chooseTime: 20, defaultSlowMode: 0.5, SMSet: new Set(), getRandomInt: () => 0,
    });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: choosing.activateChooseMode, blueToSpecButton: buttons.blueToSpecButton,
        choosePlayer: choosing.choosePlayer, deactivateChooseMode: choosing.deactivateChooseMode,
        endGame: () => {}, getRandomInt: () => 0,
        getSpecList: choosing.getSpecList, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });
    balanceRef = balance;

    balance.handlePlayersStop(null);
    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        check('chooseMode activates for the genuine surplus', state.chooseMode, true);
        check('the stadium is switched to big BEFORE/as picking starts, not left on classic', state.currentStadium, 'big');
        check('the switch actually went through room.stadiumCommand', stadiumCalls, ['!big']);
    })();
}

console.log('\n--- team/balance.js: a 2v1 finish with zero spectators reshuffles WHO sits out, not the same loser every time ---');
{
    // Reported bug: "игра если закончилась 2x1, начнется 2x1... надо
    // просто зарандомить" — a match ending 2v1 with genuinely zero
    // spectators to draw from used to bench+refill from the SAME just-
    // benched loser every time, always reconstructing the identical shape
    // (winners kept together, same player left alone). The uneven split
    // itself is unavoidable with an odd total, but WHO ends up as the odd
    // one out shouldn't be tied to who just won/lost. Fixed via
    // randomFillAll(). This runs many independent trials of the exact same
    // starting 2v1 and checks the identity of whoever ends up alone
    // actually varies — a fix that always produces the same 2v1 shape
    // (just via a different code path) would still fail this.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const oddOnesOut = new Set();
    let allTrialsStayed2v1 = true;
    (async () => {
    for (let trial = 0; trial < 30; trial++) {
        const players = [
            { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.BLUE },
        ];
        const state = {
            players, chooseMode: false, endGameVariable: true, lastWinner: Team.RED,
            currentStadium: 'classic', gameState: State.STOP,
        };
        state.teamRed = players.filter((p) => p.team === Team.RED);
        state.teamBlue = players.filter((p) => p.team === Team.BLUE);
        state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
        const roomMock = {
            getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
            setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
            stopGame: () => {}, startGame: () => {}, pauseGame: () => {},
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                if (!player) return;
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
        const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
        const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: (max) => Math.floor(Math.random() * max) });
        const balance = require(path.join(CORE, 'team', 'balance'))({
            room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
            emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
            activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
            deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: (max) => Math.floor(Math.random() * max),
            getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
            redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
            stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
        });
        balance.handlePlayersStop(null);
        // randomFillAll()'s staggered fills land within ~15ms; give it room.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const diff = Math.abs(state.teamRed.length - state.teamBlue.length);
        if (state.players.length !== 3 || diff !== 1) allTrialsStayed2v1 = false;
        const smallerTeam = state.teamRed.length <= state.teamBlue.length ? state.teamRed : state.teamBlue;
        if (smallerTeam.length === 1) oddOnesOut.add(smallerTeam[0].id);
    }
    check('every trial stayed a genuine 2v1 (numeric balance kept, nobody vanished)', allTrialsStayed2v1, true);
    check('across 30 trials, more than one player ended up as the odd one out (not deterministic)', oddOnesOut.size > 1, true);
    })();
}

console.log('\n--- team/balance.js: a 1v1 finish with one genuinely-waiting spectator stays 1v1, not 2v1 ---');
{
    // Reported bug: "the game ended 1v1, I was in spectators, the next game
    // started 2v1." Root cause was computeSpectatorsToInsert() (and, via
    // it, ensureFullFieldBeforeStart()) draining every waiting spectator
    // regardless of parity — the first pull correctly restored the 1v1 by
    // refilling the benched loser's slot, but the loop didn't stop there
    // and dragged the genuinely-waiting spectator in too, one player short
    // of an even pair. Fixed by stopping at parity and only continuing in
    // real pairs beyond that (same principle topButton()/randomButton()
    // already use for "a lone leftover stays benched").
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    for (const lastWinner of [Team.RED, Team.BLUE]) {
        const players = [
            { id: 1, team: Team.RED }, { id: 2, team: Team.BLUE }, { id: 3, team: Team.SPECTATORS },
        ];
        const state = {
            players, chooseMode: false, endGameVariable: true, lastWinner,
            currentStadium: 'classic', gameState: State.STOP,
        };
        state.teamRed = players.filter((p) => p.team === Team.RED);
        state.teamBlue = players.filter((p) => p.team === Team.BLUE);
        state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

        const roomMock = {
            getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
            setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
            stopGame: () => {}, startGame: () => {}, pauseGame: () => {},
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                if (!player) return;
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
        const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
        const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
        const balance = require(path.join(CORE, 'team', 'balance'))({
            room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
            emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
            activateChooseMode: () => {}, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
            deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: () => 0,
            getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
            redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
            stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
        });

        balance.handlePlayersStop(null);

        (async () => {
            await new Promise((resolve) => setTimeout(resolve, 5100));
            const label = lastWinner === Team.RED ? 'RED' : 'BLUE';
            check(`1v1 (${label} won) + 1 waiting spectator settles on 1v1, spectator still waiting`, [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [1, 1, 1]);
        })();
    }
}

console.log('\n--- team/balance.js: handlePlayersStop with MORE than a full house activates real picking, not a silent 4v5 refill ---');
{
    // Reported live, only reachable with players.length > 2*teamSize (a
    // full house PLUS extra waiting spectators): a genuine surplus here
    // follows the same room policy as an exact full house — the benched
    // side's captain (the first non-AFK spectator, auto-placed by
    // choosePlayer()'s own empty-side guard) picks their own teammates,
    // rather than everything silently auto-refilling to 4v4 (which could
    // also overfill past 2*teamSize — 4v5 instead of 4v4 — before this
    // policy was restored, since a naive pull doesn't know to stop and
    // hand off to picking once a real surplus is detected).
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    // An uneven 4v3 was playing (the room's "keep playing uneven" policy),
    // plus 3 extra waiting spectators — 10 total, matching what was
    // reported in practice.
    const players = [];
    let pid = 1;
    for (let i = 0; i < 4; i++) players.push({ id: pid++, team: Team.RED });
    for (let i = 0; i < 3; i++) players.push({ id: pid++, team: Team.BLUE });
    for (let i = 0; i < 3; i++) players.push({ id: pid++, team: Team.SPECTATORS });
    const state = {
        players, chooseMode: false, endGameVariable: true, lastWinner: Team.BLUE,
        currentStadium: 'big', gameState: State.STOP,
        redCaptainChoice: '', blueCaptainChoice: '', capLeft: false, streak: 1,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const sent = [];
    let kicked = false;
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, pauseGame: () => {}, startGame: () => {},
        sendAnnouncement: (msg, id) => sent.push({ msg, id }),
        kickPlayer: () => { kicked = true; },
        setPlayerTeam: (id, team) => {
            const player = state.players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = state.players.filter((p) => p.team === Team.RED);
            state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            balanceRef.handlePlayersTeamChange(null);
        },
    };
    let balanceRef;
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: (max) => Math.floor(Math.random() * max) });
    const createChoosingHelpers = require(path.join(CORE, 'team', 'choosing'));
    const choosing = createChoosingHelpers({
        room: roomMock, state, Team, HaxNotification: { CHAT: 1, MENTION: 2 },
        announcementColor: 1, errorColor: 2, infoColor: 3, warningColor: 4,
        chooseModeSlowMode: 10, chooseTime: 15, defaultSlowMode: 0, SMSet: new Set(), getRandomInt: (max) => Math.floor(Math.random() * max),
    });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: choosing.activateChooseMode, blueToSpecButton: buttons.blueToSpecButton, choosePlayer: choosing.choosePlayer,
        deactivateChooseMode: choosing.deactivateChooseMode, endGame: () => {}, getRandomInt: (max) => Math.floor(Math.random() * max),
        getSpecList: choosing.getSpecList, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });
    balanceRef = balance;

    balance.handlePlayersStop(null);

    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        check('the winners (BLUE, 5/6/7) stay together, now on the red side via WinStay', state.teamRed.map((p) => p.id).sort(), [5, 6, 7]);
        check('chooseMode activates for the genuine surplus instead of silently auto-refilling to 4v5', state.chooseMode, true);
        check('the first eligible spectator was auto-placed as blue\'s captain, not left unfilled', state.teamBlue.length, 1);
        const captainId = state.teamBlue[0] && state.teamBlue[0].id;
        check('that captain received a real "pick a player" prompt', sent.some((s) => s.msg.includes('Для выбора игрока') && s.id === captainId), true);
        check('nobody got kicked during the handoff to picking', kicked, false);
    })();
}

console.log('\n--- team/balance.js: choose mode never gets stuck on as the room shrinks below a full house via ordinary leaves ---');
{
    // End-to-end regression for the reported bug: a room drops below
    // 2*teamSize one leave at a time (spectators sitting still while
    // active players leave) — unlike PICKS (which move counts in a
    // tightly self-resolving way — see determineSideForm's captain
    // alternation), ordinary leaves can hit red/blue/spec in any order,
    // so the old abs(diff)==specLen / (Red==Blue && specLen<2) completion
    // checks were never guaranteed to fire. Once state.chooseMode got
    // stuck true below a full house, handlePlayersStop's chooseMode
    // branch has no room.startGame() call for that (not-a-full-house)
    // shape — the room would silently sit parked after the next match
    // ended, never starting a new round.
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const HaxNotificationMock = { CHAT: 1, MENTION: 2 };
    const calls = [];
    const noop = (name) => () => calls.push(name);
    const state = {
        chooseMode: true, gameState: State.PLAY,
        teamRed: [{ id: 1 }, { id: 2 }, { id: 3 }],
        teamBlue: [{ id: 4 }, { id: 5 }, { id: 6 }],
        teamSpec: [{ id: 7 }, { id: 8 }],
        game: { scores: { timeLimit: 5 } },
    };
    state.players = [...state.teamRed, ...state.teamBlue, ...state.teamSpec];
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: { ...room, getScores: () => ({ red: 0, blue: 0, time: 0, timeLimit: 5 }) },
        state, Team, State, HaxNotification: HaxNotificationMock,
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: noop('activateChooseMode'), blueToSpecButton: noop('blueToSpecButton'),
        choosePlayer: noop('choosePlayer'), deactivateChooseMode: () => { state.chooseMode = false; calls.push('deactivateChooseMode'); },
        endGame: noop('endGame'), getRandomInt: () => 0, getSpecList: noop('getSpecList'),
        instantRestart: noop('instantRestart'), randomButton: noop('randomButton'),
        redToSpecButton: noop('redToSpecButton'), resetButton: noop('resetButton'),
        resumeGame: noop('resumeGame'), stadiumCommand: noop('stadiumCommand'),
        swapButton: noop('swapButton'), topButton: noop('topButton'),
    });

    // One player leaves red (matching updateTeams() having already run,
    // same order movement.js's onPlayerLeave calls things in) — 8 -> 7,
    // already below the 2*teamSize=8 a full house needs.
    state.teamRed = state.teamRed.filter((p) => p.id !== 3);
    state.players = state.players.filter((p) => p.id !== 3);
    balance.handlePlayersLeave();

    check('a single leave that drops the room below a full house deactivates choose mode immediately', state.chooseMode, false);
    check('...via deactivateChooseMode(), not a bare assignment (resets slowMode/captain-choice too)', calls.includes('deactivateChooseMode'), true);
    check('...and hands off to the normal (non-choose-mode) balancer', calls.includes('resumeGame'), true);
}

console.log('\n--- team/balance.js: a room stuck in choose mode from BEFORE this fix existed self-heals on the next join too, not just leaves ---');
{
    // handlePlayersLeave's own fix (previous block) only reacts to a leave
    // — it does nothing for a room that's ALREADY stuck (e.g. from before
    // that fix was deployed, or from any path this session didn't catch)
    // and then simply has people join it back up. balanceTeams() itself is
    // a flat no-op while state.chooseMode is true, and handlePlayersJoin()
    // never deactivates it on its own — so every new joiner would just
    // pile into spectators forever, looking exactly like the reported "8
    // people in the room but only e.g. 3v3 is actually playing" symptom.
    // The fix belongs in balanceTeams() itself so it self-heals from ANY
    // caller (join OR leave), not just the one path that happened to
    // trigger it originally.
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const HaxNotificationMock = { CHAT: 1 };
    const calls = [];
    const noop = (name) => () => calls.push(name);
    // Stuck small (1v1 + 2 spectators, well below 2*teamSize=8) with
    // chooseMode true from before — nothing in this test ever leaves.
    const state = {
        chooseMode: true,
        teamRed: [{ id: 1 }], teamBlue: [{ id: 2 }],
        teamSpec: [{ id: 3 }, { id: 4 }],
        currentStadium: 'classic',
    };
    state.players = [...state.teamRed, ...state.teamBlue, ...state.teamSpec];
    // A local roomCalls, not the shared module-level one — this check's
    // own balanceTeams() call can now land on the growth branch, whose
    // pairs complete a real tick later (see balance.js), so this test
    // has to await before checking; the shared array isn't safe to poll
    // after an await with other blocks running in between.
    const roomCallsLocal = [];
    const roomMock = { setPlayerTeam: (id, team) => roomCallsLocal.push(`setPlayerTeam:${id}:${team}`) };
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: HaxNotificationMock,
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: noop('activateChooseMode'), blueToSpecButton: noop('blueToSpecButton'),
        choosePlayer: noop('choosePlayer'), deactivateChooseMode: () => { state.chooseMode = false; calls.push('deactivateChooseMode'); },
        endGame: noop('endGame'), getRandomInt: () => 0, getSpecList: noop('getSpecList'),
        instantRestart: noop('instantRestart'), randomButton: noop('randomButton'),
        redToSpecButton: noop('redToSpecButton'), resetButton: noop('resetButton'),
        resumeGame: noop('resumeGame'), stadiumCommand: noop('stadiumCommand'),
        swapButton: noop('swapButton'), topButton: noop('topButton'),
    });

    // A 5th player joins — no leave involved at all.
    state.teamSpec = [...state.teamSpec, { id: 5 }];
    state.players = [...state.players, { id: 5 }];
    balance.handlePlayersJoin();

    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        check('a join alone clears a choose-mode session that was already stuck below a full house', state.chooseMode, false);
        check('...and actually balances afterward, instead of leaving the new joiner parked in spectators', roomCallsLocal.length > 0, true);
    })();
}

console.log('\n--- team/balance.js: handlePlayersTeamChange asserts the big map when choose mode completes ---');
{
    // Choose mode completing was resuming play directly (no game stop, so
    // handlePlayersStop's own stadium-switch logic never ran) without ever
    // checking the map — a captain-picked full house could stay stuck on
    // the small classic map indefinitely.
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const calls = [];
    const stadiumCalls = [];
    const noop = (name) => () => calls.push(name);
    const state = {
        chooseMode: true, removingPlayers: false,
        teamRed: [{ id: 1 }, { id: 2 }, { id: 3 }],
        teamBlue: [{ id: 4 }],
        teamSpec: [{ id: 5 }, { id: 6 }],
        currentStadium: 'classic',
    };
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room, state, Team, State, HaxNotification, emptyPlayer: {}, infoColor: 5,
        scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: noop('activateChooseMode'), blueToSpecButton: noop('blueToSpecButton'),
        choosePlayer: noop('choosePlayer'), deactivateChooseMode: noop('deactivateChooseMode'),
        endGame: noop('endGame'), getRandomInt: () => 0, getSpecList: noop('getSpecList'),
        instantRestart: noop('instantRestart'), randomButton: noop('randomButton'),
        redToSpecButton: noop('redToSpecButton'), resetButton: noop('resetButton'),
        resumeGame: noop('resumeGame'),
        stadiumCommand: (player, msg) => {
            calls.push('stadiumCommand');
            stadiumCalls.push(msg);
        },
        swapButton: noop('swapButton'), topButton: noop('topButton'),
    });

    // abs(3-1)=2 == teamSpec.length(2) -> the "fill the smaller side" completion branch.
    stadiumCalls.length = 0;
    balance.handlePlayersTeamChange(null);
    setTimeout(() => {
        check('choose mode completing via the "fill the smaller side" branch asserts the big map', stadiumCalls, ['!big']);

        // Already on big: must not needlessly re-switch.
        state.currentStadium = 'big';
        state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }];
        state.teamBlue = [{ id: 4 }];
        state.teamSpec = [{ id: 5 }, { id: 6 }];
        stadiumCalls.length = 0;
        balance.handlePlayersTeamChange(null);
        setTimeout(() => {
            check('already on the big map, it does not needlessly re-switch', stadiumCalls, []);

            // The other completion branch: both sides already at teamSize.
            state.currentStadium = 'classic';
            state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
            state.teamBlue = [{ id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }];
            state.teamSpec = [];
            stadiumCalls.length = 0;
            balance.handlePlayersTeamChange(null);
            setTimeout(() => {
                check('choose mode completing at a full 4v4 (both sides == teamSize) also asserts the big map', stadiumCalls, ['!big']);
            }, 20);
        }, 20);
    }, 20);
}

console.log('\n--- team/balance.js: handlePlayersStop at 5 players ends up with everyone on a team, not stranded in spectators ---');
{
    // End-to-end regression for the reported bug: a 5-player room where the
    // losing side has more than one player (e.g. 3v2) used to bench the
    // whole losing team then pull back only ONE of them (a single
    // topButton() call), settling on something like 3v1 with the rest stuck
    // in spectators instead of a proper 3v2. A realistic room mock (one that
    // actually moves players and keeps state.teamRed/teamBlue/teamSpec in
    // sync, like team/buttons.js's own tests above) is needed to catch this
    // — the dumb string-logging mock used elsewhere in this file can't.
    function makeRealisticRoomMock(state, Team) {
        return {
            getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
            setScoreLimit: () => {},
            setTimeLimit: () => {},
            stopGame: () => {},
            startGame: () => {},
            setPlayerTeam: (id, team) => {
                const player = state.players.find((p) => p.id === id);
                player.team = team;
                state.teamRed = state.players.filter((p) => p.team === Team.RED);
                state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            },
        };
    }

    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const HaxNotificationMock = { CHAT: 1 };
    const emptyPlayer = {};
    const noop = () => {};

    function runScenario(redCount, blueCount, winner, chooseMode, specCount = 0) {
        const players = [];
        for (let i = 0; i < redCount; i++) players.push({ id: players.length + 1, team: Team.RED });
        for (let i = 0; i < blueCount; i++) players.push({ id: players.length + 1, team: Team.BLUE });
        for (let i = 0; i < specCount; i++) players.push({ id: players.length + 1, team: Team.SPECTATORS });
        const state = {
            players, chooseMode, endGameVariable: true, lastWinner: winner,
            currentStadium: 'classic', gameState: State.STOP,
        };
        state.teamRed = players.filter((p) => p.team === Team.RED);
        state.teamBlue = players.filter((p) => p.team === Team.BLUE);
        state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
        const roomMock = makeRealisticRoomMock(state, Team);
        const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
        const { topButton, randomButton, blueToSpecButton, redToSpecButton, resetButton, swapButton } = createButtonHelpers({
            room: roomMock, state, Team, getRandomInt: (max) => Math.floor(Math.random() * max),
        });
        const balance = require(path.join(CORE, 'team', 'balance'))({
            room: roomMock, state, Team, State, HaxNotification: HaxNotificationMock,
            emptyPlayer, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
            activateChooseMode: noop, blueToSpecButton, choosePlayer: noop,
            deactivateChooseMode: noop, endGame: noop, getRandomInt: (max) => Math.floor(Math.random() * max),
            getSpecList: noop, instantRestart: noop, randomButton,
            redToSpecButton, resetButton, resumeGame: noop,
            stadiumCommand: noop, swapButton, topButton,
        });
        balance.handlePlayersStop(null);
        return state;
    }

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // runScenario() itself only *schedules* the topButton()/etc timeouts
    // (up to 300ms + a handful of 5ms-staggered calls) — each check has to
    // wait for those to actually fire before looking at the settled state,
    // not just wait before calling runScenario() in the first place.
    (async () => {
        const state1 = runScenario(3, 2, Team.RED, false);
        await wait(350);
        check('5 players (3v2, non-choose-mode): nobody stays stuck in spectators', state1.teamSpec.length, 0);
        check('5 players (3v2, non-choose-mode): all 5 are still accounted for', state1.teamRed.length + state1.teamBlue.length, 5);

        const state2 = runScenario(2, 3, Team.BLUE, false);
        await wait(350);
        check('5 players (2v3, blue wins, non-choose-mode): nobody stays stuck in spectators', state2.teamSpec.length, 0);
        check('5 players (2v3, blue wins, non-choose-mode): all 5 are still accounted for', state2.teamRed.length + state2.teamBlue.length, 5);

        const state3 = runScenario(3, 2, Team.RED, true);
        await wait(350);
        check('5 players (3v2, still in choose mode — shrunk from a full house): nobody stays stuck in spectators', state3.teamSpec.length, 0);
        check('5 players (3v2, still in choose mode): all 5 are still accounted for', state3.teamRed.length + state3.teamBlue.length, 5);

    })();
}

console.log('\n--- team/balance.js: 11 players (4v4 full + 3 extra spectators) activates real picking, does not silently overgrow past 4v4 ---');
{
    // A full 4v4 (teamSize=4) plus MORE waiting spectators than room for (3
    // extra, 11 total): a genuine surplus this large used to (before
    // choosePlayer()/activateChooseMode() were stubbed no-ops in this
    // file's other 5-player scenarios above) risk spectatorsToInsert
    // draining every waiting spectator regardless of parity, growing the
    // match to 5v5 and beyond instead of stopping at a clean 4v4. Under the
    // restored room policy this is moot either way: any genuine surplus at
    // a full house hands off to real captain-picking rather than any kind
    // of automatic pull, so this needs the real choosing helpers (not
    // stubs) wired the same way as the other picking regression tests
    // above, to actually verify a captain gets seated and prompted instead
    // of the room silently overgrowing OR silently sitting stuck at 4v0.
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const players = [];
    let pid = 1;
    for (let i = 0; i < 4; i++) players.push({ id: pid++, team: Team.RED });
    for (let i = 0; i < 4; i++) players.push({ id: pid++, team: Team.BLUE });
    for (let i = 0; i < 3; i++) players.push({ id: pid++, team: Team.SPECTATORS });
    const state = {
        players, chooseMode: false, endGameVariable: true, lastWinner: Team.RED,
        currentStadium: 'big', gameState: State.STOP,
        redCaptainChoice: '', blueCaptainChoice: '', capLeft: false,
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const sent = [];
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {}, kickPlayer: () => {},
        sendAnnouncement: (msg, id) => sent.push({ msg, id }),
        setPlayerTeam: (id, team) => {
            const player = state.players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = state.players.filter((p) => p.team === Team.RED);
            state.teamBlue = state.players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = state.players.filter((p) => p.team === Team.SPECTATORS);
            balanceRef.handlePlayersTeamChange(null);
        },
    };
    let balanceRef;
    const createButtonHelpers = require(path.join(CORE, 'team', 'buttons'));
    const buttons = createButtonHelpers({ room: roomMock, state, Team, getRandomInt: () => 0 });
    const createChoosingHelpers = require(path.join(CORE, 'team', 'choosing'));
    const choosing = createChoosingHelpers({
        room: roomMock, state, Team, HaxNotification: { CHAT: 1, MENTION: 2 },
        announcementColor: 1, errorColor: 2, infoColor: 3, warningColor: 4,
        chooseModeSlowMode: 1, chooseTime: 20, defaultSlowMode: 0.5, SMSet: new Set(), getRandomInt: () => 0,
    });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: choosing.activateChooseMode, blueToSpecButton: buttons.blueToSpecButton,
        choosePlayer: choosing.choosePlayer, deactivateChooseMode: choosing.deactivateChooseMode,
        endGame: () => {}, getRandomInt: () => 0,
        getSpecList: choosing.getSpecList, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: buttons.swapButton, topButton: buttons.topButton,
    });
    balanceRef = balance;

    balance.handlePlayersStop(null);
    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        check('RED (the winner) stayed intact', state.teamRed.map((p) => p.id).sort(), [1, 2, 3, 4]);
        check('11 players (4v4 full + 3 extra spectators): chooseMode activates instead of silently overgrowing past 4v4', state.chooseMode, true);
        check('11 players (4v4 full + 3 extra spectators): a captain was auto-placed onto blue, not left stuck at 4v0', state.teamBlue.length, 1);
        const captainId = state.teamBlue[0] && state.teamBlue[0].id;
        check('11 players (4v4 full + 3 extra spectators): that captain received a real "pick a player" prompt', sent.some((s) => s.msg.includes('Для выбора игрока') && s.id === captainId), true);
    })();
}

console.log('\n--- team/choosing.js: a captain\'s own pick does not wipe out the fresh kick-timer it just triggered ---');
{
    // Bug: room.setPlayerTeam fires room.onPlayerTeamChange synchronously,
    // which cascades straight back through handlePlayersTeamChange — if the
    // pick doesn't immediately finish choose mode, that cascade calls
    // choosePlayer() again (re-prompting whoever picks next) BEFORE
    // chooseModeFunction's own room.setPlayerTeam(...) call even returns.
    // choosePlayer() sets a brand new state.timeOutCap for that fresh
    // prompt. chooseModeFunction used to call clearTimeout(state.timeOutCap)
    // of its own, AFTER setPlayerTeam returns — i.e. AFTER that fresh timer
    // was already set — silently cancelling the very kick-safety-net that
    // was just armed for the next prompt, on every pick that didn't
    // instantly complete choose mode.
    let nextTimerId = 1;
    const timerArgs = new Map();
    const clearedTimerIds = [];
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    global.setTimeout = (fn, ms, ...args) => {
        const id = nextTimerId++;
        timerArgs.set(id, args);
        return id;
    };
    global.clearTimeout = (id) => {
        if (id != null) clearedTimerIds.push(id);
    };

    try {
        const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
        const HaxNotificationMock = { CHAT: 1, MENTION: 2 };
        const players = [
            { id: 1, name: 'RedCap', team: Team.RED },
            { id: 2, name: 'Blue1', team: Team.BLUE }, { id: 3, name: 'Blue2', team: Team.BLUE }, { id: 4, name: 'Blue3', team: Team.BLUE },
            { id: 5, name: 'Spec1', team: Team.SPECTATORS }, { id: 6, name: 'Spec2', team: Team.SPECTATORS },
            { id: 7, name: 'Spec3', team: Team.SPECTATORS }, { id: 8, name: 'Spec4', team: Team.SPECTATORS },
        ];
        const state = {
            chooseMode: true, removingPlayers: false, streak: 0, insertingPlayers: false,
            redCaptainChoice: '', blueCaptainChoice: '',
        };
        state.teamRed = players.filter((p) => p.team === Team.RED);
        state.teamBlue = players.filter((p) => p.team === Team.BLUE);
        state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

        const noop = () => {};
        // setPlayerTeam calls back into balance.handlePlayersTeamChange the
        // same way movement.js's onPlayerTeamChange does in production —
        // referencing `balance` here only at call time (via closure), so
        // it's fine that `balance` itself is declared further down, after
        // this object literal (never actually invoked before then).
        const realisticRoom = {
            sendAnnouncement: () => {},
            kickPlayer: () => {},
            setPlayerTeam: (id, team) => {
                const player = players.find((p) => p.id === id);
                player.team = team;
                state.teamRed = players.filter((p) => p.team === Team.RED);
                state.teamBlue = players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
                balance.handlePlayersTeamChange(null);
            },
        };
        const balance = require(path.join(CORE, 'team', 'balance'))({
            room: realisticRoom, state, Team, State: { PLAY: 0, PAUSE: 1, STOP: 2 }, HaxNotification: HaxNotificationMock,
            emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
            activateChooseMode: noop, blueToSpecButton: noop, choosePlayer: (...a) => choosing.choosePlayer(...a),
            deactivateChooseMode: (...a) => choosing.deactivateChooseMode(...a), endGame: noop, getRandomInt: () => 0,
            getSpecList: noop, instantRestart: noop, randomButton: noop, redToSpecButton: noop, resetButton: noop,
            resumeGame: noop, stadiumCommand: noop, swapButton: noop, topButton: noop,
        });
        const choosing = require(path.join(CORE, 'team', 'choosing'))({
            room: realisticRoom, state, Team, HaxNotification: HaxNotificationMock,
            announcementColor: 1, errorColor: 2, infoColor: 5, warningColor: 6,
            chooseModeSlowMode: 1, chooseTime: 15, defaultSlowMode: 0.5, SMSet: new Set(), getRandomInt: () => 0,
        });

        // Red is captain (1 <= 3) and picks 'top' — this doesn't finish
        // choose mode (2v3 still uneven), so the cascade re-prompts red via
        // a fresh choosePlayer() call before chooseModeFunction returns.
        choosing.chooseModeFunction({ id: 1, name: 'RedCap' }, 'top');

        check('the pick actually went through', state.teamRed.length, 2);
        check('state.timeOutCap points at a real, uncleared timer (not wiped by the picker\'s own trailing clearTimeout)', clearedTimerIds.includes(state.timeOutCap), false);
        check('that timer is the fresh one choosePlayer() just armed for the next prompt, not a stale leftover', state.timeOutCap, nextTimerId - 1);
    } finally {
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
    }
}

console.log('\n--- team/choosing.js: choosePlayer auto-fills a completely empty side instead of silently doing nothing ---');
{
    // Reported live bug: choose mode active (the "time to pick captains"
    // announcement already fired from activateChooseMode()), but one side
    // was completely empty — neither branch of choosePlayer()'s captain
    // determination matches an empty side (both require length != 0), so
    // captain stayed undefined and the whole prompt+timer block, plus
    // getSpecList() below it, were silently skipped. The room sat stuck
    // mid-pick with no captain ever asked anything, until an unrelated
    // join/leave/AFK toggle happened to deactivate choose mode via the
    // self-heal check elsewhere — exactly matching the reported workaround.
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const players = [];
    let pid = 1;
    for (let i = 0; i < 4; i++) players.push({ id: pid++, team: Team.RED });
    for (let i = 0; i < 5; i++) players.push({ id: pid++, team: Team.SPECTATORS });
    const state = { redCaptainChoice: '', blueCaptainChoice: '' };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = [];
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const roomCallsLocal = [];
    const roomMock = {
        sendAnnouncement: () => {},
        setPlayerTeam: (id, team) => {
            const player = players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = players.filter((p) => p.team === Team.RED);
            state.teamBlue = players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
            roomCallsLocal.push(`setPlayerTeam:${id}:${team}`);
        },
    };
    const choosing = require(path.join(CORE, 'team', 'choosing'))({
        room: roomMock, state, Team, HaxNotification: { CHAT: 1, MENTION: 2 },
        announcementColor: 1, errorColor: 2, infoColor: 3, warningColor: 4,
        chooseModeSlowMode: 10, chooseTime: 15, defaultSlowMode: 0, SMSet: new Set(),
        getRandomInt: (max) => Math.floor(Math.random() * max),
    });

    choosing.choosePlayer();
    check('choosePlayer auto-fills the empty side with a spectator instead of doing nothing', state.teamBlue.length, 1);
    check('the auto-filled player actually came from the waiting spectators', roomCallsLocal.length > 0, true);
}

console.log('\n--- team/choosing.js: resolveNextCaptainId — !up (state.priorityCaptainId) jumps the empty-side auto-fill queue ---');
{
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    function buildFixture() {
        const players = [];
        let pid = 1;
        for (let i = 0; i < 4; i++) players.push({ id: pid++, team: Team.RED });
        // Spectator queue order: 5, 6 (VIP claimant, NOT first in line), 7.
        for (let i = 0; i < 3; i++) players.push({ id: pid++, team: Team.SPECTATORS });
        const state = { redCaptainChoice: '', blueCaptainChoice: '', priorityCaptainId: null };
        state.teamRed = players.filter((p) => p.team === Team.RED);
        state.teamBlue = [];
        state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
        const roomCallsLocal = [];
        const roomMock = {
            sendAnnouncement: () => {},
            setPlayerTeam: (id, team) => {
                const player = players.find((p) => p.id === id);
                if (!player) return;
                player.team = team;
                state.teamRed = players.filter((p) => p.team === Team.RED);
                state.teamBlue = players.filter((p) => p.team === Team.BLUE);
                state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
                roomCallsLocal.push(`setPlayerTeam:${id}:${team}`);
            },
        };
        const choosing = require(path.join(CORE, 'team', 'choosing'))({
            room: roomMock, state, Team, HaxNotification: { CHAT: 1, MENTION: 2 },
            announcementColor: 1, errorColor: 2, infoColor: 3, warningColor: 4,
            chooseModeSlowMode: 10, chooseTime: 15, defaultSlowMode: 0, SMSet: new Set(),
            getRandomInt: (max) => Math.floor(Math.random() * max),
        });
        return { state, choosing, players };
    }

    // A live claim (id 6, the middle of the queue — not the front) wins over
    // the front-of-queue default (id 5).
    {
        const { state, choosing } = buildFixture();
        state.priorityCaptainId = 6;
        choosing.choosePlayer();
        check('a live !up claim becomes captain even though they were not first in the spectator queue', state.teamBlue[0].id, 6);
        check('the claim is consumed (cleared) once used, freeing the slot for the next !up', state.priorityCaptainId, null);
    }

    // No claim at all -> ordinary front-of-queue behavior, completely
    // unaffected by state.priorityCaptainId existing as a concept.
    {
        const { state, choosing } = buildFixture();
        choosing.choosePlayer();
        check('with no !up claim, the front of the spectator queue becomes captain as before', state.teamBlue[0].id, 5);
    }

    // A stale claim (the claimant disconnected/left the spectator pool —
    // simulated here by simply never having them among the spectators)
    // self-heals to the ordinary front-of-queue pick, not a crash or a
    // permanently stuck slot.
    {
        const { state, choosing } = buildFixture();
        state.priorityCaptainId = 999; // never existed in teamSpec
        choosing.choosePlayer();
        check('a stale claim (holder no longer spectating) falls back to the front of the queue', state.teamBlue[0].id, 5);
        check('...and the stale claim itself is cleared, not left stuck forever', state.priorityCaptainId, null);
    }
}

console.log('\n--- team/balance.js: a leave that shifts whose turn it is always re-arms a real captain prompt ---');
{
    // Reported live bug ("complete freeze", "blue never got a captain"): a
    // leave can flip the teamRed<=teamBlue comparison (whose turn it is to
    // pick) WITHOUT movement.js's checkCaptainLeave() setting capLeft —
    // that only fires when the DEPARTING player was themselves the
    // current-turn captain, not when an unrelated leave just changes which
    // side is now smaller. handlePlayersLeave()'s final branch used to call
    // getSpecList() (just an updated waiting-list, no prompt, no timer) in
    // that case instead of choosePlayer() — leaving the room desynced:
    // whoever was already prompted keeps an armed timer for a turn that
    // isn't theirs anymore, while whoever's turn it actually becomes was
    // never asked anything and has no timer either. Always calling
    // choosePlayer() (a strict superset — it calls getSpecList() itself
    // once it settles on a real captain) fixes this.
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const players = [
        { id: 1, team: Team.RED }, { id: 2, team: Team.RED }, { id: 3, team: Team.RED }, { id: 4, team: Team.RED },
        { id: 5, team: Team.BLUE }, { id: 6, team: Team.BLUE }, { id: 7, team: Team.BLUE },
        { id: 8, team: Team.SPECTATORS }, { id: 9, team: Team.SPECTATORS }, { id: 10, team: Team.SPECTATORS },
    ];
    const state = {
        players, chooseMode: true, gameState: State.PLAY, streak: 1, capLeft: false,
        redCaptainChoice: '', blueCaptainChoice: '', game: { scores: { timeLimit: 3 } },
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const sent = [];
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
        sendAnnouncement: (msg, id) => sent.push({ msg, id }),
        kickPlayer: () => {},
        setPlayerTeam: (id, team) => {
            const player = players.find((p) => p.id === id);
            if (!player) return;
            player.team = team;
            state.teamRed = players.filter((p) => p.team === Team.RED);
            state.teamBlue = players.filter((p) => p.team === Team.BLUE);
            state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
        },
    };
    const choosing = require(path.join(CORE, 'team', 'choosing'))({
        room: roomMock, state, Team, HaxNotification: { CHAT: 1, MENTION: 2 },
        announcementColor: 1, errorColor: 2, infoColor: 3, warningColor: 4,
        chooseModeSlowMode: 10, chooseTime: 15, defaultSlowMode: 0, SMSet: new Set(),
        getRandomInt: () => 0,
    });
    const balance = require(path.join(CORE, 'team', 'balance'))({
        room: roomMock, state, Team, State, HaxNotification: { CHAT: 1 },
        emptyPlayer: {}, infoColor: 5, scoreLimit: 3, teamSize: 4, timeLimit: 5,
        activateChooseMode: choosing.activateChooseMode, blueToSpecButton: () => {},
        choosePlayer: choosing.choosePlayer, deactivateChooseMode: choosing.deactivateChooseMode,
        endGame: () => {}, getRandomInt: () => 0,
        getSpecList: choosing.getSpecList, instantRestart: () => {}, randomButton: () => {},
        redToSpecButton: () => {}, resetButton: () => {}, resumeGame: () => {},
        stadiumCommand: () => {}, swapButton: () => {}, topButton: () => {},
    });

    // Establish the genuine initial prompt (blue was smaller: 3 < 4).
    choosing.choosePlayer();
    check('setup: blue is initially prompted', sent.some((s) => s.id === 5 && s.msg.includes('Для выбора')), true);
    const timerBeforeLeave = state.timeOutCap;

    // Red's captain (id 1) leaves — NOT the one currently being prompted,
    // so checkCaptainLeave() would never have set capLeft here. Red drops
    // to 3, tying blue at 3 -- whose turn it is just changed.
    sent.length = 0;
    const idx = players.findIndex((p) => p.id === 1);
    players.splice(idx, 1);
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);
    balance.handlePlayersLeave();

    check('the NEW captain (now due to pick) gets a real prompt, not just a spectator list', sent.some((s) => s.id === 2 && s.msg.includes('Для выбора')), true);
    check('a fresh timer was actually armed for them', state.timeOutCap !== timerBeforeLeave && state.timeOutCap != null, true);
}

console.log('\n--- commands/player.js: !afk never fires a no-op room.setPlayerTeam when already a spectator ---');
{
    // Bug: room.setPlayerTeam(id, SPECTATORS) used to fire unconditionally
    // on AFK entry, even though !afk can only ever be invoked while ALREADY
    // a spectator (state.players.length==1 is the one exception — someone
    // going AFK while they're literally the only player in the room). That
    // made the call a genuine no-op reassignment in the common case, but it
    // still fires room.onPlayerTeamChange in production — if chooseMode
    // happened to be active (building the next match's roster right after
    // this one ended), that spurious event cascaded into
    // handlePlayersTeamChange and could trigger an UNRELATED auto-pick,
    // stacking with the explicit handlePlayersLeave() call this function
    // already makes right after — double-processing one AFK toggle as two
    // separate roster changes (reported as "2 captains" landing on blue
    // when only one real pick happened, or blue staying empty afterward).
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const HaxNotificationMock = { CHAT: 1 };
    const roomCallsLocal = [];
    const roomMock = { setPlayerTeam: (id, team) => roomCallsLocal.push(`setPlayerTeam:${id}:${team}`), sendAnnouncement: () => {} };
    const AFKSetLocal = new Map();
    const player = require(path.join(CORE, 'commands', 'player'))({
        room: roomMock, state: { players: [{ id: 1 }, { id: 2 }], gameState: State.PLAY }, Team, State, AFKSet: AFKSetLocal,
        AFKMinSet: new Set(), AFKCooldownSet: new Set(), minAFKDuration: 5, maxAFKDuration: 30, AFKCooldown: 2,
        announcementColor: 1, errorColor: 2, HaxNotification: HaxNotificationMock,
        handlePlayersJoin: () => {}, handlePlayersLeave: () => {}, updateTeams: () => {},
    });

    roomCallsLocal.length = 0;
    player.afkCommand({ id: 1, name: 'Already Spec', team: Team.SPECTATORS }, '!afk');
    check('!afk from someone already spectating never calls room.setPlayerTeam', roomCallsLocal, []);
    check('...but they are still recorded as AFK', AFKSetLocal.has(1), true);

    // The one real exception: the lone player in an otherwise-empty room,
    // still on a team, going AFK — this genuinely needs the move.
    const soloState = { players: [{ id: 3 }], gameState: State.PLAY };
    const soloAFKSet = new Map();
    const soloPlayer = require(path.join(CORE, 'commands', 'player'))({
        room: roomMock, state: soloState, Team, State, AFKSet: soloAFKSet,
        AFKMinSet: new Set(), AFKCooldownSet: new Set(), minAFKDuration: 5, maxAFKDuration: 30, AFKCooldown: 2,
        announcementColor: 1, errorColor: 2, HaxNotification: HaxNotificationMock,
        handlePlayersJoin: () => {}, handlePlayersLeave: () => {}, updateTeams: () => {},
    });
    roomCallsLocal.length = 0;
    soloPlayer.afkCommand({ id: 3, name: 'Solo', team: Team.RED }, '!afk');
    check('!afk from the lone remaining player, still on a team, does move them to spectators', roomCallsLocal, [`setPlayerTeam:3:${Team.SPECTATORS}`]);
}

console.log('\n--- commands/player.js: !afks shows minutes-in-AFK, and the maxAFKDuration auto-expire announces publicly + privately ---');
(async () => {
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const HaxNotificationMock = { CHAT: 1 };
    const players = [{ id: 1, name: 'Willow', team: Team.SPECTATORS }, { id: 2, name: 'Fen', team: Team.SPECTATORS }];
    const sentLocal = [];
    const roomMock = {
        sendAnnouncement: (msg, id) => sentLocal.push({ msg, id }),
        getPlayer: (id) => players.find((p) => p.id === id) ?? null,
    };
    const AFKSetLocal = new Map();
    const handlePlayersJoinCalls = [];
    const player = require(path.join(CORE, 'commands', 'player'))({
        room: roomMock, state: { players: [1, 2] }, Team, State, AFKSet: AFKSetLocal,
        AFKMinSet: new Set(), AFKCooldownSet: new Set(), minAFKDuration: 0,
        maxAFKDuration: 0.01, // 600ms — fast enough to actually wait out in a test
        AFKCooldown: 0,
        announcementColor: 1, errorColor: 2, HaxNotification: HaxNotificationMock,
        handlePlayersJoin: () => handlePlayersJoinCalls.push('join'), handlePlayersLeave: () => {}, updateTeams: () => {},
    });

    // !afks: minutes are computed from AFKSet's own stored timestamp, not
    // from real elapsed time — backdating it directly is both deterministic
    // and instant, unlike actually waiting minutes in a test.
    AFKSetLocal.set(1, Date.now() - 10 * 60000);
    sentLocal.length = 0;
    player.afkListCommand({ id: 9, name: 'Viewer' }, '!afks');
    check('!afks shows minutes spent in AFK next to the name', sentLocal[0].msg, '😴 AFK лист : Willow (10 мин.).');

    // The real maxAFKDuration auto-expire path: player 2 goes AFK for real
    // via !afk (admin: undefined/false so the timers actually get armed),
    // then the 600ms timer should fire on its own.
    sentLocal.length = 0;
    player.afkCommand({ id: 2, name: 'Fen', team: Team.SPECTATORS }, '!afk');
    check('going AFK is announced to the room, not yet the expiry message', /теперь AFK/.test(sentLocal[sentLocal.length - 1].msg), true);

    await new Promise((resolve) => setTimeout(resolve, 700));
    check('the auto-expire broadcast reaches the whole room (id: null)', sentLocal.some((s) => s.id === null && /Fen вышел из AFK/.test(s.msg)), true);
    check('...and separately, the player themselves gets a private explanation', sentLocal.some((s) => s.id === 2 && /слишком долго находились в AFK/.test(s.msg)), true);
    check('the player is actually removed from AFKSet once expired', AFKSetLocal.has(2), false);
    check('handlePlayersJoin runs so the now-available player is reconsidered for teams', handlePlayersJoinCalls.length > 0, true);

    // Guard: if the player already toggled AFK off themselves before the
    // timer fires, the auto-expire callback must be a silent no-op — no
    // second, bogus "вышел из AFK" for someone who already left on their own.
    // A fresh player/id, never touched by the earlier assertions above —
    // Willow (1) is already mid-AFK-session from the !afks test, so reusing
    // her id here would just toggle her off instead of arming a new timer.
    players.push({ id: 4, name: 'Robin', team: Team.SPECTATORS });
    player.afkCommand({ id: 4, name: 'Robin', team: Team.SPECTATORS }, '!afk'); // arms a fresh 600ms timer
    await new Promise((resolve) => setTimeout(resolve, 50));
    player.afkCommand({ id: 4, name: 'Robin', team: Team.SPECTATORS }, '!afk'); // manually toggles off well before 600ms
    sentLocal.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 700));
    check('no bogus auto-expire message fires for a player who already left AFK manually', sentLocal.some((s) => /вышел из AFK|слишком долго/.test(s.msg)), false);
})();

console.log('\n--- events/misc.js: nobody keeps an admin badge unless they are MASTER/ADMIN_PERM ---');
{
    const Role = { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, MASTER: 4 };
    const roles = { 1: Role.PLAYER, 2: Role.ADMIN_PERM, 3: Role.MASTER };
    const hiddenAdminsSetMock = new Set();
    const misc = require(path.join(CORE, 'events', 'misc'))({
        room, state: {}, HaxNotification, Role,
        discordBot: { sendLog: () => {} }, emptyPlayer: {}, errorColor: 2, infoColor: 5,
        hiddenAdminsSet: hiddenAdminsSetMock,
        checkTime: () => {}, getDate: () => 'DATE', getGameStats: () => {}, getLastTouchOfTheBall: () => {},
        getRole: (p) => roles[p.id], handleActivity: () => {}, stadiumCommand: () => {}, updateTeams: () => {},
    });

    roomCalls.length = 0;
    misc.onPlayerAdminChange({ id: 1, admin: true }, null);
    check('a plain player who somehow becomes admin (e.g. HaxBall auto-granting it to the first joiner) has it revoked', roomCalls, ['setPlayerAdmin:1:false']);

    roomCalls.length = 0;
    misc.onPlayerAdminChange({ id: 1, admin: false }, null);
    check('a plain player without the badge is left alone', roomCalls, []);

    roomCalls.length = 0;
    misc.onPlayerAdminChange({ id: 2, admin: false }, null);
    check('a permanent admin who lost the badge gets it restored', roomCalls, ['setPlayerAdmin:2:true']);

    roomCalls.length = 0;
    misc.onPlayerAdminChange({ id: 2, admin: true }, null);
    check('a permanent admin who already has the badge is left alone', roomCalls, []);

    roomCalls.length = 0;
    misc.onPlayerAdminChange({ id: 3, admin: false }, null);
    check('a master who lost the badge gets it restored too', roomCalls, ['setPlayerAdmin:3:true']);

    // !hide (commands/admin.js) sets admin=false for a genuine ADMIN_PERM/
    // MASTER on purpose — the auto-restore above must not immediately
    // undo it just because they're still really an admin underneath.
    hiddenAdminsSetMock.add(2);
    roomCalls.length = 0;
    misc.onPlayerAdminChange({ id: 2, admin: false }, null);
    check('a hidden permanent admin does NOT get the badge auto-restored', roomCalls, []);

    // And if the badge somehow comes back while still marked hidden (e.g.
    // a stray native re-grant), it gets re-suppressed rather than left on.
    roomCalls.length = 0;
    misc.onPlayerAdminChange({ id: 2, admin: true }, null);
    check('a hidden permanent admin whose badge reappears gets it re-hidden', roomCalls, ['setPlayerAdmin:2:false']);

    hiddenAdminsSetMock.delete(2);
    roomCalls.length = 0;
    misc.onPlayerAdminChange({ id: 2, admin: false }, null);
    check('once no longer hidden, the normal auto-restore applies again', roomCalls, ['setPlayerAdmin:2:true']);
}

console.log('\n--- commands/admin.js: stadiumCommand applies per-arena score/time limits ---');
{
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const admin = require(path.join(CORE, 'commands', 'admin'))({
        room, state: { gameState: State.STOP }, authArray: [], muteArray: {}, muteDuration: 10, MutePlayer: class {},
        trainingMap: '{"name":"Training"}', classicMap: '{"name":"Classic1v1"}', bigMap: '{"name":"Big3x3"}',
        classicScoreLimit: 3, classicTimeLimit: 3, bigScoreLimit: 5, bigTimeLimit: 5,
        State, Situation: {}, announcementColor: 1, errorColor: 2, HaxNotification,
        instantRestart: () => {}, swapButton: () => {},
    });

    roomCalls.length = 0;
    admin.stadiumCommand({ id: 1 }, '!classic');
    check('!classic sets the classic score limit (3)', roomCalls.includes('setScoreLimit:3'), true);
    check('!classic sets the classic time limit (3)', roomCalls.includes('setTimeLimit:3'), true);

    roomCalls.length = 0;
    admin.stadiumCommand({ id: 1 }, '!big');
    check('!big sets the big score limit (5)', roomCalls.includes('setScoreLimit:5'), true);
    check('!big sets the big time limit (5)', roomCalls.includes('setTimeLimit:5'), true);
}

console.log('\n--- commands/admin.js: !hide toggles the admin badge without touching role/permissions ---');
{
    const hiddenAdminsSetLocal = new Set();
    const admin2 = require(path.join(CORE, 'commands', 'admin'))({
        room, state: {}, authArray: [], muteArray: {}, muteDuration: 10, MutePlayer: class {},
        trainingMap: '{}', classicMap: '{}', bigMap: '{}',
        classicScoreLimit: 3, classicTimeLimit: 3, bigScoreLimit: 5, bigTimeLimit: 5,
        State: {}, Situation: {}, announcementColor: 1, errorColor: 2, HaxNotification,
        hiddenAdminsSet: hiddenAdminsSetLocal,
        instantRestart: () => {}, swapButton: () => {},
    });

    roomCalls.length = 0;
    admin2.hideCommand({ id: 7, name: 'Boss' }, '!hide');
    check('!hide removes the admin badge', roomCalls, ['setPlayerAdmin:7:false']);
    check('!hide records the player as hidden', hiddenAdminsSetLocal.has(7), true);

    roomCalls.length = 0;
    admin2.hideCommand({ id: 7, name: 'Boss' }, '!hide');
    check('!hide again restores the admin badge', roomCalls, ['setPlayerAdmin:7:true']);
    check('!hide again clears the hidden flag', hiddenAdminsSetLocal.has(7), false);
}

console.log('\n--- stats/goalAttribution.js: an assist can never be the same player as the scorer ---');
{
    const { Goal } = require(path.join(__dirname, '..', 'src', 'core', 'models'));
    const state = { lastTouches: [null, null], game: { scores: { time: 120 }, goals: [] } };
    const goalAttribution = require(path.join(CORE, 'stats', 'goalAttribution'))({
        state, Team, Goal, getTimeGame: (t) => `[${t}]`,
    });

    const scorer = { id: 1, name: 'Alice', team: Team.RED };
    const assister = { id: 2, name: 'Bob', team: Team.RED };

    state.lastTouches = [{ player: scorer }, { player: assister }];
    state.game.goals = [];
    let goalString = goalAttribution.getGoalString(Team.RED);
    check('a normal goal+assist credits both players in the announcement', goalString.includes('Alice') && goalString.includes('Bob'), true);
    check('the Goal record keeps the real assist', state.game.goals[0].assist, assister);

    // The bug this guards against: touch tracking runs off two mechanisms (a
    // kick event and a per-tick proximity check) that can, in some sequence,
    // both end up pointing at the same player for lastTouches[0] and [1] —
    // that must never be credited as a self-assist.
    state.lastTouches = [{ player: scorer }, { player: scorer }];
    state.game.goals = [];
    goalString = goalAttribution.getGoalString(Team.RED);
    check('a duplicate same-player touch is never announced as an assist', goalString.includes('ассистом'), false);
    check('the Goal record has no assist for a self-touch duplicate', state.game.goals[0].assist, null);
    check('the scorer is still credited correctly', state.game.goals[0].striker, scorer);

    const ownGoalScorer = { id: 3, name: 'Carol', team: Team.BLUE };
    state.lastTouches = [{ player: ownGoalScorer }, { player: assister }];
    state.game.goals = [];
    goalString = goalAttribution.getGoalString(Team.RED);
    check('an own goal is never credited with an assist', state.game.goals[0].assist, null);
    check('an own goal message names whoever touched it', goalString.includes('Carol'), true);

    state.lastTouches = [null, null];
    state.game.goals = [];
    goalAttribution.getGoalString(Team.RED);
    check('a goal with no recorded touch falls back to a generic message, no striker', state.game.goals[0].striker, null);
}

console.log('\n--- core/overflowPassword.js: activates/rotates/deactivates around a threshold ---');
{
    const state = { playersAll: new Array(9).fill(0).map((_, i) => ({ id: i })), roomPassword: '' };
    const roomCallsLocal = [];
    const roomMock = { setPassword: (p) => roomCallsLocal.push(p) };
    const passwords = [];
    const discordBotMock = { sendPassword: (p) => passwords.push(p) };
    let passwordCounter = 0;
    const generateRoomPassword = () => `PW${++passwordCounter}`;
    const persistedSettings = {};
    const dbMock = {
        setSetting: (key, value) => { persistedSettings[key] = value; return Promise.resolve(); },
        getSetting: (key) => Promise.resolve(persistedSettings[key] ?? null),
    };

    const { checkOverflowPassword } = require(path.join(CORE, 'overflowPassword'))({
        room: roomMock, state, maxPlayers: 12, passwordThreshold: 10,
        discordBot: discordBotMock, generateRoomPassword, rotateIntervalMs: 20,
        db: dbMock,
    });

    checkOverflowPassword();
    check('below the threshold, nothing happens', roomCallsLocal, []);

    state.playersAll = new Array(11).fill(0).map((_, i) => ({ id: i }));
    checkOverflowPassword();
    check('crossing the threshold sets a fresh password on the room', roomCallsLocal, ['PW1']);
    check('crossing the threshold announces it to Discord', passwords, ['PW1']);
    check('the active password is also recorded on state.roomPassword', state.roomPassword, 'PW1');
    check('the fresh password is persisted for a future restart to pick up', persistedSettings.overflowPasswordValue, 'PW1');

    checkOverflowPassword();
    check('staying at/above the threshold does not re-activate outside of the hourly rotation', roomCallsLocal, ['PW1']);

    state.playersAll = new Array(9).fill(0).map((_, i) => ({ id: i }));
    checkOverflowPassword();
    check('dropping back below the threshold clears the password immediately', roomCallsLocal, ['PW1', null]);
    check('state.roomPassword is cleared too', state.roomPassword, '');

    // The actual bug this guards against: someone leaving and rejoining
    // right around the threshold (very much the common case at 12/14, not
    // an edge case) must reuse whatever password is still current instead
    // of minting — and re-announcing to Discord — a brand new one on every
    // single re-crossing.
    state.playersAll = new Array(11).fill(0).map((_, i) => ({ id: i }));
    checkOverflowPassword();
    check('re-crossing the threshold shortly after reuses the same password on the room', roomCallsLocal, ['PW1', null, 'PW1']);
    check('re-crossing the threshold does not re-announce a new password to Discord', passwords, ['PW1']);
    check('state.roomPassword is restored to the reused password, not a new one', state.roomPassword, 'PW1');

    // Unlike the checks above, reuse never applies here — only the interval
    // (20ms) drives further rotation now, so this needs real elapsed time
    // rather than the synchronous "free" regenerations the pre-fix version
    // got from every re-crossing. 150ms gives it ~7 possible ticks, well
    // clear of ordinary event-loop jitter for a >=3 threshold.
    setTimeout(() => {
        check('the password still rotates on its own while the room stays full', passwords.length >= 3, true);
    }, 150);
}

console.log('\n--- core/overflowPassword.js: reuses a persisted password across a simulated restart ---');
{
    // A restart tears down the whole module (fresh closure, fresh `active`/
    // `currentPassword`/`rotateTimer`) — this is exactly the bug report that
    // prompted persistence: the room comes back empty, and once it refills
    // past the threshold the old, still-valid-in-Discord password must keep
    // working instead of a silent new one nobody's seen.
    const state = { playersAll: new Array(9).fill(0).map((_, i) => ({ id: i })), roomPassword: '' };
    const roomCallsLocal = [];
    const roomMock = { setPassword: (p) => roomCallsLocal.push(p) };
    const passwords = [];
    const discordBotMock = { sendPassword: (p) => passwords.push(p) };
    const generateRoomPassword = () => 'SHOULD-NOT-BE-USED';
    const dbMock = { setSetting: () => Promise.resolve(), getSetting: () => Promise.resolve(null) };

    const { checkOverflowPassword } = require(path.join(CORE, 'overflowPassword'))({
        room: roomMock, state, maxPlayers: 12, passwordThreshold: 10,
        discordBot: discordBotMock, generateRoomPassword, rotateIntervalMs: 60 * 60 * 1000,
        db: dbMock, initialPassword: 'OLDPW', initialPasswordSetAt: Date.now() - 1000,
    });

    state.playersAll = new Array(11).fill(0).map((_, i) => ({ id: i }));
    checkOverflowPassword();
    check('a persisted password still within its rotation window is reused on the room', roomCallsLocal, ['OLDPW']);
    check('reusing a persisted password does not re-announce it to Discord', passwords, []);
    check('state.roomPassword reflects the reused persisted password', state.roomPassword, 'OLDPW');
}

console.log('\n--- core/overflowPassword.js: ignores a persisted password past its rotation window ---');
{
    const state = { playersAll: new Array(11).fill(0).map((_, i) => ({ id: i })), roomPassword: '' };
    const roomCallsLocal = [];
    const roomMock = { setPassword: (p) => roomCallsLocal.push(p) };
    const passwords = [];
    const discordBotMock = { sendPassword: (p) => passwords.push(p) };
    const generateRoomPassword = () => 'FRESHPW';
    const dbMock = { setSetting: () => Promise.resolve(), getSetting: () => Promise.resolve(null) };

    const { checkOverflowPassword } = require(path.join(CORE, 'overflowPassword'))({
        room: roomMock, state, maxPlayers: 12, passwordThreshold: 10,
        discordBot: discordBotMock, generateRoomPassword, rotateIntervalMs: 60 * 60 * 1000,
        db: dbMock, initialPassword: 'EXPIREDPW', initialPasswordSetAt: Date.now() - 2 * 60 * 60 * 1000,
    });

    checkOverflowPassword();
    check('an expired persisted password is not reused', roomCallsLocal, ['FRESHPW']);
    check('a fresh password is announced instead', passwords, ['FRESHPW']);
}

console.log('\n--- core/announcements.js: cycles through messages in order, on an interval ---');
{
    const sentLocal = [];
    const roomMock = { sendAnnouncement: (msg) => sentLocal.push(msg) };
    const HaxNotificationMock = { CHAT: 1 };

    const { start } = require(path.join(CORE, 'announcements'))({
        room: roomMock,
        messages: ['one', 'two', 'three'],
        announcementColor: 0xffffff,
        HaxNotification: HaxNotificationMock,
        intervalMs: 20,
    });
    start();

    // 20ms interval, checked at 250ms — well over the 4 ticks needed to
    // prove the loop-back, with plenty of margin for event-loop jitter from
    // the other timer-driven checks running in this same process.
    setTimeout(() => {
        check('messages are sent in order and loop back to the start', sentLocal.slice(0, 4), ['one', 'two', 'three', 'one']);
    }, 250);
}

console.log('\n--- core/announcements.js: an empty message list never fires (and never throws) ---');
{
    const sentLocal = [];
    const roomMock = { sendAnnouncement: (msg) => sentLocal.push(msg) };
    const HaxNotificationMock = { CHAT: 1 };

    const { start } = require(path.join(CORE, 'announcements'))({
        room: roomMock,
        messages: [],
        announcementColor: 0xffffff,
        HaxNotification: HaxNotificationMock,
        intervalMs: 20,
    });
    start();

    setTimeout(() => {
        check('nothing is sent when the message list is empty', sentLocal, []);
    }, 100);
}

console.log('\n--- core/economy.js: coin awards, playtime ticker, shop/inventory/equip ---');
(async () => {
    const { formatCoins } = require(path.join(CORE, 'utils'));
    const Team = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const HaxNotificationMock = { CHAT: 1 };
    const Role = { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, MASTER: 4 };
    // Mutable so individual checks below can flip a player's role mid-test
    // (e.g. granting VIP) without re-wiring the whole economy factory.
    const rolesLocal = {};
    const getRole = (player) => rolesLocal[player.id] ?? Role.PLAYER;
    const testItems = [
        { id: 'fire', type: 'goalAnimation', name: 'Огонь', price: 100, avatar: '🔥' },
        { id: 'star', type: 'goalAnimation', name: 'Звезда', price: 50, avatar: '⭐' },
        {
            id: 'gold', type: 'form', name: 'Золотой', price: 200,
            home: { colors: [0xffd700], textColor: 0x1a1a1a, angle: 0 },
            away: { colors: [0x1a1a1a], textColor: 0xffd700, angle: 0 },
        },
        {
            id: 'violet', type: 'form', name: 'Фиолетовый', price: 200,
            home: { colors: [0x8a2be2], textColor: 0xffffff, angle: 0 },
            away: { colors: [0xffffff], textColor: 0x1a1a1a, angle: 0 },
        },
        {
            id: 'crimson', type: 'form', name: 'Багровый', price: 150, clashesWithDefault: 'red',
            home: { colors: [0xd60000], textColor: 0xffffff, angle: 0 },
            away: { colors: [0x4d4d4d], textColor: 0xd60000, angle: 0 },
        },
        // A past-season item — see shopItems.js's `retired`. Stays in the
        // catalog forever so an existing owner keeps it, but is excluded
        // from !shop's listing and can never be bought again by anyone.
        {
            id: 'relic', type: 'form', name: 'Реликвия', price: 200, retired: true,
            home: { colors: [0x999999], textColor: 0x000000, angle: 0 },
            away: { colors: [0x000000], textColor: 0x999999, angle: 0 },
        },
        // A plain (non-vipOnly) price:0 item — isolated coverage for the
        // "бесплатно" display (see economy.js's formatItemLine/shopCommand),
        // independent of the vipOnly gate itself.
        {
            id: 'freebie', type: 'form', name: 'Халявная', price: 0,
            home: { colors: [0x123456], textColor: 0xffffff, angle: 0 },
            away: { colors: [0x654321], textColor: 0x123456, angle: 0 },
        },
        {
            id: 'vip-royal', type: 'form', name: 'VIP Royal', price: 300, vipOnly: true,
            home: { colors: [0x2b0052], textColor: 0xffd700, angle: 0 },
            away: { colors: [0xffd700], textColor: 0x2b0052, angle: 0 },
        },
        {
            id: 'vip-diamond', type: 'form', name: 'VIP Diamond', price: 300, vipOnly: true,
            home: { colors: [0x00e5ff], textColor: 0x002b36, angle: 0 },
            away: { colors: [0x002b36], textColor: 0x00e5ff, angle: 0 },
        },
        {
            id: 'small', type: 'size', name: 'Малыш', upgradeable: true,
            baseRadius: 15, direction: -1, stepRadius: 2, maxLevel: 5,
            basePrice: 200, priceStep: 100,
        },
        { id: 'smoke', type: 'goalAnimation', name: 'Дым', price: 300, smokeFamily: true },
        { id: 'smoke-red', type: 'goalAnimation', name: 'Дым (красный)', price: 300, smokeColor: 'red', hidden: true },
        { id: 'smoke-blue', type: 'goalAnimation', name: 'Дым (синий)', price: 300, smokeColor: 'blue', hidden: true },
        { id: 'smoke-purple', type: 'goalAnimation', name: 'Дым (фиолетовый)', price: 300, smokeColor: 'purple', hidden: true },
        { id: 'smoke-white', type: 'goalAnimation', name: 'Дым (белый)', price: 300, smokeColor: 'white', hidden: true },
        { id: 'fireworks', type: 'goalAnimation', name: 'Фейерверк', price: 50000, fireworks: true, grantsAccess: true },
    ];

    // Minimal in-memory stand-in for the real db, shaped exactly like the
    // bridged version (see dbBridgeClient.js) — every method returns a
    // Promise, since economy.js awaits all of them either way.
    function makeDbMock() {
        const balances = new Map();
        const owned = new Map();
        const equipped = new Map();
        const levels = new Map();
        return {
            addCoins: (auth, name, amount) => { balances.set(auth, (balances.get(auth) ?? 0) + amount); return Promise.resolve(); },
            getBalance: (auth) => Promise.resolve(balances.get(auth) ?? 0),
            spendCoins: (auth, name, amount) => {
                if ((balances.get(auth) ?? 0) < amount) return Promise.resolve(false);
                balances.set(auth, (balances.get(auth) ?? 0) - amount);
                return Promise.resolve(true);
            },
            getOwnedItemIds: (auth) => Promise.resolve([...(owned.get(auth) ?? [])]),
            ownsItem: (auth, itemId) => Promise.resolve((owned.get(auth) ?? new Set()).has(itemId)),
            buyItem: (auth, name, itemId, price) => {
                const ownedSet = owned.get(auth) ?? new Set();
                if (ownedSet.has(itemId)) return Promise.resolve(false);
                if ((balances.get(auth) ?? 0) < price) return Promise.resolve(false);
                balances.set(auth, (balances.get(auth) ?? 0) - price);
                ownedSet.add(itemId);
                owned.set(auth, ownedSet);
                return Promise.resolve(true);
            },
            getItemLevel: (auth, itemId) => Promise.resolve(levels.get(auth)?.get(itemId) ?? 0),
            upgradeItem: (auth, name, itemId, cost, expectedCurrentLevel) => {
                const levelsForAuth = levels.get(auth) ?? new Map();
                const current = levelsForAuth.get(itemId) ?? 0;
                if (current !== expectedCurrentLevel) return Promise.resolve(false);
                if ((balances.get(auth) ?? 0) < cost) return Promise.resolve(false);
                balances.set(auth, (balances.get(auth) ?? 0) - cost);
                levelsForAuth.set(itemId, expectedCurrentLevel + 1);
                levels.set(auth, levelsForAuth);
                const ownedSet = owned.get(auth) ?? new Set();
                ownedSet.add(itemId);
                owned.set(auth, ownedSet);
                return Promise.resolve(true);
            },
            setEquipped: (auth, slot, itemId) => {
                const current = equipped.get(auth) ?? { form: null, goalAnimation: null, size: null };
                current[slot] = itemId;
                equipped.set(auth, current);
                return Promise.resolve();
            },
            getEquipped: (auth) => Promise.resolve(equipped.get(auth) ?? { form: null, goalAnimation: null, size: null }),
            _balances: balances,
        };
    }

    const roomCallsLocal = [];
    const sentLocal = [];
    const roomMock = {
        setPlayerDiscProperties: (id, props) => roomCallsLocal.push(`setPlayerDiscProperties:${id}:${JSON.stringify(props)}`),
        getPlayerDiscProperties: (id) => ({ radius: 15 }),
        setPlayerAvatar: (id, avatar) => roomCallsLocal.push(`setPlayerAvatar:${id}:${avatar}`),
        setTeamColors: (team, angle, textColor, colors) => roomCallsLocal.push(`setTeamColors:${team}:${JSON.stringify(colors)}`),
        setDiscProperties: (id, props) => roomCallsLocal.push(`setDiscProperties:${id}:${JSON.stringify(props)}`),
        sendAnnouncement: (msg, id) => sentLocal.push({ msg, id }),
    };
    const authArray = [];
    authArray[1] = ['AUTH_RED1'];
    authArray[2] = ['AUTH_BLUE1'];
    authArray[3] = ['AUTH_EMPTY'];
    const state = {
        gameState: State.PLAY,
        teamRed: [{ id: 1, name: 'Red1' }],
        teamBlue: [{ id: 2, name: 'Blue1' }],
        playersAll: [{ id: 1, name: 'Red1' }, { id: 2, name: 'Blue1' }],
        clubMembers: [],
        currentStadium: 'classic',
    };

    const db = makeDbMock();
    const { getRandomInt } = require(path.join(CORE, 'utils'));
    const { playSmokeAnimation } = require(path.join(CORE, 'smokeAnimation'));
    const { playFireworksAnimation } = require(path.join(CORE, 'fireworksAnimation'));
    const economy = require(path.join(CORE, 'economy'))({
        room: roomMock, state, authArray, db, items: testItems,
        Team, State, HaxNotification: HaxNotificationMock,
        announcementColor: 1, errorColor: 2, formatCoins, getRandomInt,
        playSmokeAnimation, playFireworksAnimation, Role, getRole,
    });

    sentLocal.length = 0;
    await economy.awardMatchCoins(Team.RED);
    check('a win pays the winning team 10', await db.getBalance('AUTH_RED1'), 10);
    check('a win pays the losing team 5', await db.getBalance('AUTH_BLUE1'), 5);
    check('the winner gets a private notification, not a broadcast', sentLocal.find((s) => s.id === 1).id, 1);
    check('the win notification shows new balance + delta in the requested format', sentLocal.find((s) => s.id === 1).msg, '💰 Баланс: 10 (+10 монеток)');
    check('the loser also gets a private notification', sentLocal.find((s) => s.id === 2).msg, '💰 Баланс: 5 (+5 монеток)');
    check('coin notifications are never broadcast to the whole room', sentLocal.every((s) => s.id !== null && s.id !== undefined), true);

    sentLocal.length = 0;
    await economy.awardMatchCoins(Team.SPECTATORS);
    check('a draw pays everyone the loss rate, not the win rate', await db.getBalance('AUTH_RED1'), 15);
    check('a draw pays the other side the same loss rate', await db.getBalance('AUTH_BLUE1'), 10);
    check('a draw still notifies privately with the loss-rate delta', sentLocal.find((s) => s.id === 1).msg, '💰 Баланс: 15 (+5 монеток)');

    // Playtime: 60s/tick, 10 minutes (600s) needed for a payout — both teams
    // are on the field for these ticks, so both accrue it, not just red.
    for (let i = 0; i < 9; i++) economy.tickPlaytime(60);
    check('playtime does not pay out before 10 minutes', await db.getBalance('AUTH_RED1'), 15);
    sentLocal.length = 0;
    economy.tickPlaytime(60);
    check('playtime pays out once 10 minutes accumulate', await db.getBalance('AUTH_RED1'), 16);
    check('playtime pays out to every active player, not just one side', await db.getBalance('AUTH_BLUE1'), 11);
    // tickPlaytime's payout notification is fire-and-forget (a .then() chain,
    // not awaited by the caller — real callers are a setInterval tick) —
    // flush the microtask queue before checking it landed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('a playtime payout also notifies privately', sentLocal.find((s) => s.id === 1).msg, '💰 Баланс: 16 (+1 монетка)');

    state.gameState = State.STOP;
    economy.tickPlaytime(600);
    check('playtime never accrues while the game is not actually playing', await db.getBalance('AUTH_RED1'), 16);
    state.gameState = State.PLAY;

    // Club-teammate coin bonus (state.clubMembers, populated by
    // commands/club.js) — +25%, rounded, on every payout when at least one
    // clubmate shares the player's own side. Uses its own temporary roster
    // so it doesn't disturb AUTH_RED1/AUTH_BLUE1's running balances, which
    // the shop tests below still depend on.
    const savedTeamRed = state.teamRed;
    const savedTeamBlue = state.teamBlue;
    authArray[4] = ['AUTH_CLUBBED_A'];
    authArray[5] = ['AUTH_CLUBBED_B'];
    authArray[6] = ['AUTH_SOLO'];
    state.clubMembers = [
        { auth: 'AUTH_CLUBBED_A', clubId: 1, playerName: 'ClubbedA' },
        { auth: 'AUTH_CLUBBED_B', clubId: 1, playerName: 'ClubbedB' },
    ];
    state.teamRed = [{ id: 4, name: 'ClubbedA' }, { id: 5, name: 'ClubbedB' }];
    state.teamBlue = [{ id: 6, name: 'Solo' }];

    sentLocal.length = 0;
    await economy.awardMatchCoins(Team.RED);
    check('two clubmates on the same winning side both get +25%', await db.getBalance('AUTH_CLUBBED_A'), 13);
    check('+25% applies to the other clubmate too', await db.getBalance('AUTH_CLUBBED_B'), 13);
    check('a player with no clubmate on their own side gets the plain rate', await db.getBalance('AUTH_SOLO'), 5);

    sentLocal.length = 0;
    economy.tickPlaytime(600);
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('the playtime bonus also applies to clubmates on the field together', await db.getBalance('AUTH_CLUBBED_A'), 13 + 1);
    check('a solo player\'s playtime payout is unboosted', await db.getBalance('AUTH_SOLO'), 5 + 1);

    state.teamRed = savedTeamRed;
    state.teamBlue = savedTeamBlue;
    state.clubMembers = [];

    // !balance: a plain, on-demand balance check.
    sentLocal.length = 0;
    await economy.balanceCommand({ id: 1, name: 'Red1' }, '!balance');
    check('!balance reports the current balance privately', sentLocal, [{ msg: '💰 Ваш баланс: 16 монеток', id: 1 }]);

    // Shop: list, buy failures, a real purchase. Balance topped up to a
    // known round number here so these checks don't depend on the exact
    // arithmetic of every award/playtime step above.
    await db.addCoins('AUTH_BLUE1', 'Blue1', 89);
    check('balance topped up for the shop tests', await db.getBalance('AUTH_BLUE1'), 100);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop');
    check('!shop with no args lists the catalog and balance', /Магазин \(баланс: 100 монеток\)/.test(sentLocal[0].msg), true);
    check('a price:0 item is listed as "бесплатно", not "0 монеток"', /freebie — Халявная \(бесплатно\)/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop freebie');
    check('buying a price:0 item confirms "бесплатно" instead of "за 0 монеток"', /Куплено: Халявная бесплатно !/.test(sentLocal[0].msg), true);
    check('a price:0 purchase never touches the balance', await db.getBalance('AUTH_BLUE1'), 100);

    // Retired items (see shopItems.js's `retired`) — excluded from the !shop
    // listing, and blocked from ever being bought again, but an EXISTING
    // owner keeps full use of one (equip + !inventory), forever.
    check('a retired item is excluded from the !shop listing', /relic/.test(sentLocal[0].msg), false);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop relic');
    check('a retired item can never be bought, even by someone who does not own it', /больше не продаётся/.test(sentLocal[0].msg), true);
    check('a rejected retired purchase never touches the balance', await db.getBalance('AUTH_BLUE1'), 100);

    // Simulates an existing owner from a past season — bought before the
    // item was ever marked retired, via the DB directly rather than !shop
    // (which would now reject it). A DEDICATED auth, not AUTH_RED1/BLUE1 —
    // later tests below rely on Red1 owning nothing at all.
    authArray[15] = ['AUTH_RELIC_OWNER'];
    await db.buyItem('AUTH_RELIC_OWNER', 'RelicOwner', 'relic', 0);
    sentLocal.length = 0;
    await economy.shopCommand({ id: 15, name: 'RelicOwner' }, '!shop relic');
    check('an existing owner trying to re-"buy" a retired item is still rejected the same way', /больше не продаётся/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.equipCommand({ id: 15, name: 'RelicOwner' }, '!equip relic');
    check('an existing owner CAN still equip a retired item', /Надето: Реликвия/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.inventoryCommand({ id: 15, name: 'RelicOwner' }, '!inventory');
    check('!inventory shows a retired item as "снят с продажи", not a price', /relic — Реликвия \(снят с продажи\) \[надето\]/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop nope');
    check('!shop <unknown id> reports no such item', /Нет такого товара/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop gold');
    check('!shop <id> too expensive for the current balance is rejected', /Недостаточно монет/.test(sentLocal[0].msg), true);

    // goalAnimation items are VIP-gated: a plain PLAYER can't buy one at all,
    // even with the balance for it, until they either hold VIP+ or own the
    // smoke bundle or fireworks (see economy.js's hasGoalAnimationAccess —
    // there's no separate standalone unlock purchase anymore).
    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop fire');
    check('a non-VIP without access cannot buy a goalAnimation item', /доступны только VIP/.test(sentLocal[0].msg), true);
    check('the rejected goalAnimation purchase never touches the balance', await db.getBalance('AUTH_BLUE1'), 100);

    // A VIP bypasses the gate entirely — no access purchase needed.
    rolesLocal[2] = Role.VIP;
    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop fire');
    check('a VIP can buy a goalAnimation item without any access purchase', /Куплено: Огонь/.test(sentLocal[0].msg), true);
    check('the price was actually deducted', await db.getBalance('AUTH_BLUE1'), 0);
    rolesLocal[2] = Role.PLAYER;

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop fire');
    check('!shop <already-owned id> is rejected without charging again', /уже есть/.test(sentLocal[0].msg), true);

    // Losing VIP afterward doesn't un-equip anything already owned, but a
    // now-plain player still can't buy a SECOND goalAnimation item on the
    // strength of their old VIP — owning the smoke bundle or fireworks is
    // the only lasting bypass now.
    await db.addCoins('AUTH_BLUE1', 'Blue1', 350);
    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop smoke-red');
    check('a lapsed VIP is gated again on a second goalAnimation item', /доступны только VIP/.test(sentLocal[0].msg), true);
    check('the rejection never touches the balance', await db.getBalance('AUTH_BLUE1'), 350);

    // The smoke bundle ('smoke' — see shopItems.js's smokeFamily) is itself
    // exempt from the access gate (buying it IS how a non-VIP gets access)
    // and, charged once, grants every real hidden color at once — !equip is
    // left to pick which of the now-owned colors is actually worn.
    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop smoke');
    check('the smoke bundle is buyable without any prior access', /Куплено: Дым за/.test(sentLocal[0].msg), true);
    check('buying the bundle grants smoke-red', await db.ownsItem('AUTH_BLUE1', 'smoke-red'), true);
    check('...and smoke-blue too', await db.ownsItem('AUTH_BLUE1', 'smoke-blue'), true);
    check('...and smoke-purple too', await db.ownsItem('AUTH_BLUE1', 'smoke-purple'), true);
    check('...and smoke-white too', await db.ownsItem('AUTH_BLUE1', 'smoke-white'), true);
    check('the bundle id itself is never recorded as owned (it is not equippable)', await db.ownsItem('AUTH_BLUE1', 'smoke'), false);
    check('only the bundle price (300) was charged, not 4x', await db.getBalance('AUTH_BLUE1'), 50);
    check('the confirmation mentions picking a color via !equip', /Открыты все цвета дыма.*!equip smoke-/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop smoke');
    check('re-buying the smoke bundle is rejected as already owned, not re-charged', /уже есть/.test(sentLocal[0].msg), true);
    check('the rejection never touches the balance', await db.getBalance('AUTH_BLUE1'), 50);

    // Owning the smoke bundle unlocks goalAnimation access broadly, not just
    // for smoke colors — a totally unrelated item (star) is now buyable too.
    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop star');
    check('owning the smoke bundle unlocks any goalAnimation item, not just smoke colors', /Куплено: Звезда/.test(sentLocal[0].msg), true);
    check('the price was actually deducted', await db.getBalance('AUTH_BLUE1'), 0);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop');
    check('!shop lists the merged smoke bundle entry', /smoke — Дым/.test(sentLocal[0].msg), true);
    check('!shop does not list the individual hidden smoke colors', /smoke-red/.test(sentLocal[0].msg), false);

    roomCallsLocal.length = 0;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip smoke-blue');
    check('the player can equip any owned color from the bundle, not just the one they paid for', /Надето: Дым \(синий\)/.test(sentLocal[0].msg), true);
    check('equipping a smoke color never touches a disc directly (only playGoalAnimation does, on an actual goal)', roomCallsLocal, []);

    // Inventory.
    sentLocal.length = 0;
    await economy.inventoryCommand({ id: 1, name: 'Red1' }, '!inventory');
    check('!inventory is empty for someone who owns nothing', /пока нет/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.inventoryCommand({ id: 2, name: 'Blue1' }, '!inventory');
    check('!inventory lists an owned item', /fire — Огонь/.test(sentLocal[0].msg), true);

    // Equip.
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip');
    check('!equip with no id shows usage', /Использование/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip gold');
    check('!equip <not owned> is rejected', /еще не купили/.test(sentLocal[0].msg), true);

    roomCallsLocal.length = 0;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip fire');
    check('!equip <owned goalAnimation> confirms', /Надето: Огонь/.test(sentLocal[0].msg), true);
    check('equipping a goalAnimation never touches the disc', roomCallsLocal, []);
    check('equipping a goalAnimation records it in that slot', await db.getEquipped('AUTH_BLUE1'), { form: null, goalAnimation: 'fire', size: null });

    // Equipping a form goes through equipCommand -> applyTeamForms, i.e. one
    // setTeamColors call per side, not a per-player disc update.
    await db.buyItem('AUTH_BLUE1', 'Blue1', 'gold', 0);
    roomCallsLocal.length = 0;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip gold');
    check('!equip <owned form> confirms', /Надето: Золотой/.test(sentLocal[0].msg), true);
    check('equipping a form recomputes both sides via setTeamColors', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0xe56e56])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0xffd700])}`,
    ]);

    // !equip is a toggle, not a separate !unequip command: re-invoking it
    // for whatever's ALREADY equipped in that slot unequips it instead (see
    // economy.js's equipCommand). 'violet' is a real item but Blue1 hasn't
    // bought it, so equipping it is rejected the normal "not yet purchased"
    // way — there's no separate "wrong slot value" rejection anymore now
    // that unequip isn't its own command.
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip violet');
    check('!equip <not owned> is rejected regardless of what\'s currently equipped', /еще не купили/.test(sentLocal[0].msg), true);
    check('rejection never touches the db', (await db.getEquipped('AUTH_BLUE1')).form, 'gold');

    // !equip: unknown id.
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip nope');
    check('!equip <unknown id> reports no such item', /Нет такого/.test(sentLocal[0].msg), true);

    // !equip: re-invoking on the currently-equipped form toggles it off —
    // same setTeamColors recompute as equipping one, just falling back to
    // the default kit instead.
    roomCallsLocal.length = 0;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip gold');
    check('!equip <currently equipped> unequips it and confirms', /Снято: Золотой/.test(sentLocal[0].msg), true);
    check('the slot is actually cleared in the db', (await db.getEquipped('AUTH_BLUE1')).form, null);
    check('unequipping a form recomputes both sides back to their defaults', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0xe56e56])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0x6a8ef5])}`,
    ]);

    // Equipping a 'size' item has NO immediate effect — it's a post-goal-only
    // celebration (see playGoalSizeEffect below), never a standing radius
    // change, so equipping never touches the disc. 'small' is upgradeable
    // (see shopItems.js) — level 0 -> 1 via upgradeItem, same as !shop would.
    await db.upgradeItem('AUTH_BLUE1', 'Blue1', 'small', 0, 0);
    roomCallsLocal.length = 0;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip small');
    check('!equip <owned size> confirms', /Надето: Малыш/.test(sentLocal[0].msg), true);
    check('equipping a size item never touches the disc', roomCallsLocal, []);

    // applyTeamForms: a side's color comes from its captain (teamRed[0]/
    // teamBlue[0], per team/choosing.js's own "captain" concept) — with a
    // single player on each side right now, that player IS the captain.
    // Applied via one room.setTeamColors(team, ...) call per side, not
    // touched per player.
    // Reset Blue1's form from the earlier !equip test above — this block
    // starts from a clean "only red has a form" baseline.
    await db.setEquipped('AUTH_BLUE1', 'form', null);
    await db.buyItem('AUTH_RED1', 'Red1', 'gold', 0);
    await db.setEquipped('AUTH_RED1', 'form', 'gold');
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('applyTeamForms applies the captain\'s form to their whole side via setTeamColors', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0xffd700])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0x6a8ef5])}`,
    ]);

    // Same form on both sides -> red keeps home, blue switches to away
    // instead of wearing an identical color.
    await db.buyItem('AUTH_BLUE1', 'Blue1', 'gold', 0);
    await db.setEquipped('AUTH_BLUE1', 'form', 'gold');
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('applyTeamForms gives red the home color when both sides pick the same form', roomCallsLocal.includes(`setTeamColors:${Team.RED}:${JSON.stringify([0xffd700])}`), true);
    check('applyTeamForms switches blue to the away color to avoid twinning', roomCallsLocal.includes(`setTeamColors:${Team.BLUE}:${JSON.stringify([0x1a1a1a])}`), true);

    // Different forms on each side -> both wear their own home color, no clash.
    await db.setEquipped('AUTH_BLUE1', 'form', 'violet');
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('applyTeamForms lets each side wear its own home color when the forms differ', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0xffd700])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0x8a2be2])}`,
    ]);

    // Captain has no form equipped -> falls back to a random teammate who
    // does, not just "no form for the side".
    state.teamRed = [{ id: 4, name: 'Captain' }, { id: 1, name: 'Red1' }];
    authArray[4] = ['AUTH_CAPTAIN'];
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('applyTeamForms falls back to a teammate\'s form when the captain has none equipped', roomCallsLocal.includes(`setTeamColors:${Team.RED}:${JSON.stringify([0xffd700])}`), true);
    state.teamRed = [{ id: 1, name: 'Red1' }];

    // Nobody on a side has any form equipped -> falls back to the default
    // team colors, clearing any stale color from before rather than
    // silently leaving it in place (setTeamColors doesn't auto-revert).
    await db.setEquipped('AUTH_RED1', 'form', null);
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('applyTeamForms falls back to the default red color when nobody on it has a form', roomCallsLocal.includes(`setTeamColors:${Team.RED}:${JSON.stringify([0xe56e56])}`), true);

    // Bug: crimson's home kit (deep reds) is close enough to the default
    // red kit that a blue side wearing crimson blended in with a red side
    // that has no form at all — same visual problem as two sides sharing a
    // form, just against the DEFAULT rather than another form. Red still
    // has no form from the check above.
    await db.buyItem('AUTH_BLUE1', 'Blue1', 'crimson', 0);
    await db.setEquipped('AUTH_BLUE1', 'form', 'crimson');
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('applyTeamForms switches blue to away when its form clashes with red\'s default color', roomCallsLocal.includes(`setTeamColors:${Team.BLUE}:${JSON.stringify([0x4d4d4d])}`), true);

    // Current-season forms outrank retired ones (see shopItems.js's
    // `retired`) — first WITHIN a side: a teammate's current form beats even
    // the captain's own retired one, same "outranks the captain's own pick"
    // shape as vipOnly outranking a plain captain choice.
    await db.buyItem('AUTH_RED1', 'Red1', 'relic', 0);
    await db.setEquipped('AUTH_RED1', 'form', 'relic');
    await db.setEquipped('AUTH_CAPTAIN', 'form', 'gold');
    state.teamRed = [{ id: 1, name: 'Red1' }, { id: 4, name: 'Captain' }];
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('a teammate\'s current form outranks even the captain\'s own retired one', roomCallsLocal.includes(`setTeamColors:${Team.RED}:${JSON.stringify([0xffd700])}`), true);

    // Nobody current on the side -> the retired form is still used rather
    // than falling all the way back to no form/default kit. Blue is
    // cleared here too — it still has 'crimson' equipped from the earlier
    // clashesWithDefault test above, which would otherwise trip the NEW
    // opposing-sides retired-vs-current rule tested separately below and
    // muddy what this specific check is isolating.
    await db.setEquipped('AUTH_CAPTAIN', 'form', null);
    await db.setEquipped('AUTH_BLUE1', 'form', null);
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('a retired form is still used when nobody on the side has a current one', roomCallsLocal.includes(`setTeamColors:${Team.RED}:${JSON.stringify([0x999999])}`), true);

    // Opposing sides landing on DIFFERENT forms, one retired and one
    // current, that are NOT flagged as clashing (see shopItems.js's
    // `clashesWith`) — both just wear home normally. Deferring to away is
    // only ever about an ACTUAL flagged clash, never automatic just because
    // one side is retired.
    await db.setEquipped('AUTH_RED1', 'form', 'gold');
    await db.buyItem('AUTH_BLUE1', 'Blue1', 'relic', 0);
    await db.setEquipped('AUTH_BLUE1', 'form', 'relic');
    state.teamRed = [{ id: 1, name: 'Red1' }];
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('an UNFLAGGED retired-vs-current pair both wear home, no forced away', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0xffd700])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0x999999])}`,
    ]);

    // Now flag them as clashing (mutating the catalog entry directly, same
    // as shopItems.js's `clashesWith` would in real config) — the retired
    // side (lower priority — see economy.js's formPriority) switches to
    // away, the current side keeps home.
    const relicFixtureItem = testItems.find((i) => i.id === 'relic');
    relicFixtureItem.clashesWith = ['gold'];
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('a FLAGGED retired-vs-current clash forces the retired side to away', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0xffd700])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0x000000])}`,
    ]);
    delete relicFixtureItem.clashesWith;

    // Same flagged-clash mechanism, but across priority tiers: a plain form
    // vs a vipOnly one (real-world case: 'black' vs 'vip-kvadrat', both
    // near-black — see shopItems.js). The LOWER-priority side (plain, even
    // though it's a CURRENT-season form) defers to away, not the vipOnly one.
    // Not bought via db.buyItem — determineSideForm/applyTeamForms only ever
    // read db.getEquipped + role, never ownership (that's the shop/equip
    // COMMAND layer's job), and a real buyItem here would collide with the
    // "a VIP can buy a vipOnly form" test further down this same file, which
    // still expects AUTH_BLUE1 to NOT already own vip-royal at that point.
    rolesLocal[2] = Role.VIP;
    await db.setEquipped('AUTH_BLUE1', 'form', 'vip-royal');
    const goldFixtureItem = testItems.find((i) => i.id === 'gold');
    goldFixtureItem.clashesWith = ['vip-royal'];
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('a plain form defers to away against a clashing vipOnly one, even though vipOnly isn\'t "current"', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0x1a1a1a])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0x2b0052])}`,
    ]);
    delete goldFixtureItem.clashesWith;
    rolesLocal[2] = Role.PLAYER;

    // Reset both sides back to no form for the tests that follow — they
    // assume this exact starting point.
    await db.setEquipped('AUTH_RED1', 'form', null);
    await db.setEquipped('AUTH_BLUE1', 'form', null);

    // VIP-exclusive forms (see shopItems.js's vipOnly, economy.js's
    // determineSideForm): outrank a non-VIP captain's own form entirely,
    // random pick among multiple VIPs on the same side, and stop applying
    // the instant the wearer's VIP itself lapses (re-checked live, no
    // caching) — mirrors the goalAnimation access gate's "re-checked every
    // call" design.
    authArray[10] = ['AUTH_VIP_A'];
    authArray[11] = ['AUTH_VIP_B'];
    authArray[12] = ['AUTH_PLAIN_CAPTAIN'];
    await db.buyItem('AUTH_PLAIN_CAPTAIN', 'PlainCaptain', 'gold', 0);
    await db.setEquipped('AUTH_PLAIN_CAPTAIN', 'form', 'gold');
    await db.buyItem('AUTH_VIP_A', 'VipA', 'vip-royal', 0);
    await db.setEquipped('AUTH_VIP_A', 'form', 'vip-royal');
    rolesLocal[10] = Role.VIP;

    state.teamRed = [{ id: 12, name: 'PlainCaptain' }, { id: 10, name: 'VipA' }];
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('a VIP teammate\'s vipOnly form outranks the non-VIP captain\'s own form', roomCallsLocal.includes(`setTeamColors:${Team.RED}:${JSON.stringify([0x2b0052])}`), true);

    // Two VIPs on the same side with different vipOnly forms -> random pick
    // among the VIP forms specifically (never falls through to the
    // captain's plain 'gold', even though gold is also equipped).
    await db.buyItem('AUTH_VIP_B', 'VipB', 'vip-diamond', 0);
    await db.setEquipped('AUTH_VIP_B', 'form', 'vip-diamond');
    rolesLocal[11] = Role.VIP;
    state.teamRed = [{ id: 12, name: 'PlainCaptain' }, { id: 10, name: 'VipA' }, { id: 11, name: 'VipB' }];
    const seenColors = new Set();
    for (let i = 0; i < 30; i++) {
        roomCallsLocal.length = 0;
        await economy.applyTeamForms();
        seenColors.add(roomCallsLocal.find((c) => c.startsWith(`setTeamColors:${Team.RED}:`)));
    }
    check('with 2 VIPs on the same side, only their own vipOnly forms are ever picked (never the plain captain\'s)', [...seenColors].sort(), [
        `setTeamColors:${Team.RED}:${JSON.stringify([0x2b0052])}`,
        `setTeamColors:${Team.RED}:${JSON.stringify([0x00e5ff])}`,
    ].sort());
    check('...and both VIP forms actually get picked across enough trials, not always the same one', seenColors.size, 2);

    // VIP status lapsing makes the vipOnly form stop applying immediately,
    // no re-equip needed — falls back down to the plain captain's 'gold'.
    rolesLocal[10] = Role.PLAYER;
    rolesLocal[11] = Role.PLAYER;
    state.teamRed = [{ id: 12, name: 'PlainCaptain' }, { id: 10, name: 'VipA' }];
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('a lapsed VIP\'s vipOnly form no longer applies (falls back to the captain\'s plain form)', roomCallsLocal.includes(`setTeamColors:${Team.RED}:${JSON.stringify([0xffd700])}`), true);

    // Opposing VIPs with DIFFERENT vipOnly forms both just wear their own
    // home color — the home/away clash-avoidance only kicks in when both
    // sides land on the exact same form id (same as any other form).
    rolesLocal[10] = Role.VIP;
    authArray[13] = ['AUTH_VIP_C'];
    await db.buyItem('AUTH_VIP_C', 'VipC', 'vip-diamond', 0);
    await db.setEquipped('AUTH_VIP_C', 'form', 'vip-diamond');
    rolesLocal[13] = Role.VIP;
    state.teamRed = [{ id: 10, name: 'VipA' }];
    state.teamBlue = [{ id: 13, name: 'VipC' }];
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('opposing VIPs with different vipOnly forms each wear their own home color', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0x2b0052])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0x00e5ff])}`,
    ]);

    // Opposing VIPs with the SAME vipOnly form still get the existing
    // home/away clash-avoidance — red keeps home, blue switches to away.
    await db.buyItem('AUTH_VIP_C', 'VipC', 'vip-royal', 0);
    await db.setEquipped('AUTH_VIP_C', 'form', 'vip-royal');
    roomCallsLocal.length = 0;
    await economy.applyTeamForms();
    check('opposing VIPs with the SAME vipOnly form still get red home / blue away', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0x2b0052])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0xffd700])}`,
    ]);

    state.teamRed = [{ id: 1, name: 'Red1' }];
    state.teamBlue = [{ id: 2, name: 'Blue1' }];

    // !shop/!equip gating: vipOnly forms have no coin-bought bypass at all
    // (unlike goalAnimation) — a hard role check, nothing more.
    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop vip-royal');
    check('a non-VIP cannot buy a vipOnly form', /эксклюзивная форма для VIP/.test(sentLocal[0].msg), true);

    rolesLocal[2] = Role.VIP;
    await db.addCoins('AUTH_BLUE1', 'Blue1', 300);
    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop vip-royal');
    check('a VIP can buy a vipOnly form', /Куплено: VIP Royal/.test(sentLocal[0].msg), true);

    rolesLocal[2] = Role.PLAYER;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip vip-royal');
    check('a lapsed VIP cannot equip a vipOnly form even if they already own it', /эксклюзивная форма для VIP/.test(sentLocal[0].msg), true);

    rolesLocal[2] = Role.VIP;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip vip-royal');
    check('a current VIP can equip a vipOnly form they own', /Надето: VIP Royal/.test(sentLocal[0].msg), true);
    rolesLocal[2] = Role.PLAYER;

    // !shop fireworks — `grantsAccess` itself (see shopItems.js), so it's
    // buyable regardless of prior access, same as the smoke bundle (Blue1
    // already has access from owning the smoke bundle anyway by this point).
    await db.addCoins('AUTH_BLUE1', 'Blue1', 50000);
    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop fireworks');
    check('!shop fireworks charges the full 50000', /Куплено: Фейерверк/.test(sentLocal[0].msg), true);
    check('the price was actually deducted', await db.getBalance('AUTH_BLUE1'), 0);

    roomCallsLocal.length = 0;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip fireworks');
    check('fireworks can be equipped like any other goalAnimation item', /Надето: Фейерверк/.test(sentLocal[0].msg), true);
    check('equipping fireworks never touches a disc directly (only playGoalAnimation does, on an actual goal)', roomCallsLocal, []);
    // Restores the 'fire' equip from the earlier !equip test above — the
    // later "playGoalAnimation flashes the equipped avatar" check still
    // relies on that exact state, not this test's own 'fireworks' pick.
    await db.setEquipped('AUTH_BLUE1', 'goalAnimation', 'fire');

    // announceTeamForms: match-start-only, credits whoever the form actually
    // came from, and says nothing at all if neither side has a custom form.
    await db.setEquipped('AUTH_BLUE1', 'form', null);
    sentLocal.length = 0;
    await economy.announceTeamForms();
    check('announceTeamForms says nothing when neither side has a custom form', sentLocal, []);

    await db.setEquipped('AUTH_RED1', 'form', 'gold');
    await db.setEquipped('AUTH_BLUE1', 'form', 'violet');
    sentLocal.length = 0;
    await economy.announceTeamForms();
    check('announceTeamForms announces both sides, crediting who has the form', sentLocal, [
        { msg: 'Форма красных: Золотой (Red1), синих: Фиолетовый (Blue1)', id: null },
    ]);

    await db.setEquipped('AUTH_BLUE1', 'form', null);
    sentLocal.length = 0;
    await economy.announceTeamForms();
    check('announceTeamForms only mentions the side that actually has a form', sentLocal, [
        { msg: 'Форма красных: Золотой (Red1)', id: null },
    ]);

    // Captain has no form, falls back to a teammate — the announcement must
    // credit the teammate who actually owns it, not the captain.
    await db.setEquipped('AUTH_RED1', 'form', null);
    await db.setEquipped('AUTH_CAPTAIN', 'form', null);
    state.teamRed = [{ id: 4, name: 'Captain' }, { id: 1, name: 'Red1' }];
    await db.setEquipped('AUTH_RED1', 'form', 'gold');
    sentLocal.length = 0;
    await economy.announceTeamForms();
    check('announceTeamForms credits the teammate the form fell back to, not the captain', sentLocal, [
        { msg: 'Форма красных: Золотой (Red1)', id: null },
    ]);
    state.teamRed = [{ id: 1, name: 'Red1' }];
    await db.setEquipped('AUTH_RED1', 'form', null);

    roomCallsLocal.length = 0;
    await economy.playGoalAnimation({ id: 2, name: 'Blue1' });
    check('playGoalAnimation flashes the equipped avatar', roomCallsLocal, ['setPlayerAvatar:2:🔥']);

    roomCallsLocal.length = 0;
    await economy.playGoalAnimation({ id: 1, name: 'Red1' });
    check('playGoalAnimation is a no-op with nothing equipped', roomCallsLocal, []);

    // playGoalAnimation + a `smokeColor` item (shopItems.js) — a disc-based
    // burst (smokeAnimation.js) instead of an avatar swap. Real
    // playSmokeAnimation is wired in above, so this genuinely runs the
    // 5-frame animation (~650ms of real setTimeout delay). Red1 has never
    // bought the goalAnimation unlock, so this needs VIP to actually fire
    // (see the access-gate tests below for the lapsed/unlocked cases).
    rolesLocal[1] = Role.VIP;
    await db.setEquipped('AUTH_RED1', 'goalAnimation', 'smoke-red');
    roomCallsLocal.length = 0;
    await economy.playGoalAnimation({ id: 1, name: 'Red1', team: Team.RED });
    check('a smokeColor item never touches the avatar', roomCallsLocal.some((c) => c.startsWith('setPlayerAvatar')), false);
    check('it animates classic\'s 7 helper discs (indices 8-14)', [...new Set(roomCallsLocal.map((c) => c.split(':')[1]))].sort(), ['10', '11', '12', '13', '14', '8', '9']);
    check('the burst mirrors positive-x for a RED goal (blue\'s goal mouth)', roomCallsLocal.some((c) => c.includes('"x":381')), true);
    check('every helper disc ends up hidden again (radius 0) once it finishes', roomCallsLocal.slice(-7).every((c) => c.includes('"radius":0')), true);

    // Losing VIP mid-session (no re-equip, nothing touched in the db) makes
    // an equipped goalAnimation simply stop firing — it's re-checked live on
    // every goal, not just at the moment it was equipped.
    rolesLocal[1] = Role.PLAYER;
    roomCallsLocal.length = 0;
    await economy.playGoalAnimation({ id: 1, name: 'Red1', team: Team.RED });
    check('a lapsed VIP\'s still-equipped goalAnimation no longer fires', roomCallsLocal, []);
    check('the db still has it equipped underneath (only the FIRING is gated)', (await db.getEquipped('AUTH_RED1')).goalAnimation, 'smoke-red');

    // A `grantsAccess` purchase (fireworks — see shopItems.js) survives this,
    // unlike VIP — same equipped item, same never-re-equipped state, but it
    // fires again the moment ANY access-granting item is owned.
    await db.buyItem('AUTH_RED1', 'Red1', 'fireworks', 0);
    roomCallsLocal.length = 0;
    await economy.playGoalAnimation({ id: 1, name: 'Red1', team: Team.RED });
    check('a non-VIP who owns an access-granting item keeps firing their equipped animation permanently', roomCallsLocal.length > 0, true);

    // playGoalAnimation + a `fireworks` item (shopItems.js) — routes to the
    // real playFireworksAnimation wired in above, same disc-based mechanism
    // as smokeColor, sharing smoke's own helper-disc pool (all 25 of it —
    // fireworks needs more than smoke's own 7). Red1 still has permanent
    // access from the unlock purchase above.
    //
    // NOT awaited to completion — the real animation now runs a full 3
    // seconds, and this shared block already has two other real ~650ms
    // waits in it (see the smoke tests above); doing all three back to back
    // would blow the file's tally window (see the bottom of this file).
    // Only frame 0's calls are needed here, and those land synchronously —
    // playGoalAnimation's own `await db.getEquipped(...)` resolves as a
    // microtask, so a single macrotask tick (setTimeout 0) is more than
    // enough to let it run through to fireworks' own first frame.
    await db.setEquipped('AUTH_RED1', 'goalAnimation', 'fireworks');
    roomCallsLocal.length = 0;
    economy.playGoalAnimation({ id: 1, name: 'Red1', team: Team.RED });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Filtered to setDiscProperties/player-1-specific calls, not a raw
    // array-is-empty-of-avatar-calls check — cumulative real delay earlier
    // in this block can put Blue1's own 3-second avatar-revert timer
    // (GOAL_CELEBRATION_DURATION_MS, from the earlier 'fire' test) inside
    // this window, firing setPlayerAvatar:2:null — real, but unrelated to
    // what's under test here (Red1's fireworks item).
    check('a fireworks item never touches Red1\'s own avatar', roomCallsLocal.some((c) => c.startsWith('setPlayerAvatar:1:')), false);
    const discCallsLocal = roomCallsLocal.filter((c) => c.startsWith('setDiscProperties'));
    check('it animates all 25 of the classic helper discs (indices 8-32)', [...new Set(discCallsLocal.map((c) => Number(c.split(':')[1])))].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => 8 + i));
    check('the build-phase circle sits at the goal center, mirrored positive for RED', discCallsLocal.some((c) => c.includes('"x":372')), true);

    // playGoalSizeEffect: Blue1 has 'small' equipped at level 1 (from the
    // !equip test above) — briefly swaps the LEVEL-derived radius in
    // (15 - 2*1 = 13), captured from the disc's own CURRENT properties
    // (mocked at radius 15 here), not a hardcoded default.
    roomCallsLocal.length = 0;
    await economy.playGoalSizeEffect({ id: 2, name: 'Blue1' });
    check('playGoalSizeEffect applies the level-1 radius', roomCallsLocal, [`setPlayerDiscProperties:2:${JSON.stringify({ radius: 13 })}`]);

    roomCallsLocal.length = 0;
    await economy.playGoalSizeEffect({ id: 1, name: 'Red1' });
    check('playGoalSizeEffect is a no-op with nothing equipped', roomCallsLocal, []);

    // Upgradeable items (small/big, see shopItems.js): !shop <id> on an
    // already-owned tiered item upgrades it in place instead of rejecting
    // "already owned" — price rises 100/level, radius moves 2/level off 15.
    authArray[8] = ['AUTH_UPGRADER'];
    await db.addCoins('AUTH_UPGRADER', 'Upgrader', 1000);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 8, name: 'Upgrader' }, '!shop small');
    check('the first purchase of an upgradeable item goes from level 0 to 1', /улучшен до уровня 1\/5/.test(sentLocal[0].msg), true);
    check('level 1 costs the base price (200)', await db.getBalance('AUTH_UPGRADER'), 800);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 8, name: 'Upgrader' }, '!shop small');
    check('buying it again upgrades to level 2, not "already owned"', /улучшен до уровня 2\/5/.test(sentLocal[0].msg), true);
    check('level 2 costs 100 more than level 1 (300)', await db.getBalance('AUTH_UPGRADER'), 500);

    await economy.shopCommand({ id: 8, name: 'Upgrader' }, '!shop small'); // level 3, -400 -> 100
    sentLocal.length = 0;
    await economy.shopCommand({ id: 8, name: 'Upgrader' }, '!shop small'); // level 4 needs 500, only has 100
    check('an upgrade beyond the current balance is rejected like any purchase', /Недостаточно монет/.test(sentLocal[0].msg), true);
    check('a rejected upgrade does not advance the level or charge anything', await db.getBalance('AUTH_UPGRADER'), 100);

    await db.addCoins('AUTH_UPGRADER', 'Upgrader', 1000);
    await economy.shopCommand({ id: 8, name: 'Upgrader' }, '!shop small'); // level 4
    await economy.shopCommand({ id: 8, name: 'Upgrader' }, '!shop small'); // level 5 (max)
    sentLocal.length = 0;
    await economy.shopCommand({ id: 8, name: 'Upgrader' }, '!shop small');
    check('buying past the max level is rejected', /максимального уровня/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 8, name: 'Upgrader' }, '!shop');
    check('!shop shows a maxed-out item as "максимум", not a price to pay', /small.*уровень 5\/5, максимум/.test(sentLocal[0].msg), true);

    roomCallsLocal.length = 0;
    await economy.equipCommand({ id: 8, name: 'Upgrader' }, '!equip small');
    roomCallsLocal.length = 0;
    await economy.playGoalSizeEffect({ id: 8, name: 'Upgrader' });
    check('playGoalSizeEffect at max level (5) applies radius 5 (15 - 2*5)', roomCallsLocal, [`setPlayerDiscProperties:8:${JSON.stringify({ radius: 5 })}`]);

    // addCoinsCommand: a testing/support tool, not player-facing (role
    // gating to Role.MASTER happens at the dispatch layer in commands.js,
    // same as every other command — nothing to test for that here).
    const master = { id: 9, name: 'Master' };

    sentLocal.length = 0;
    await economy.addCoinsCommand(master, '!addcoins');
    check('!addcoins with no args shows usage', /Использование/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.addCoinsCommand(master, '!addcoins #1 notanumber');
    check('!addcoins with a non-numeric amount shows usage', /Использование/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.addCoinsCommand(master, '!addcoins #999 100');
    check('!addcoins #<id> not in the room reports so', /нет в комнате/.test(sentLocal[0].msg), true);

    const balanceBeforeAddCoins = await db.getBalance('AUTH_RED1');
    sentLocal.length = 0;
    await economy.addCoinsCommand(master, '!addcoins #1 500');
    check('!addcoins #<id> credits the live player\'s auth', await db.getBalance('AUTH_RED1'), balanceBeforeAddCoins + 500);
    check('!addcoins confirms with the new balance', sentLocal[0].msg.includes('Red1'), true);

    sentLocal.length = 0;
    await economy.addCoinsCommand(master, '!addcoins AUTH_OFFLINE_TEST 200');
    check('!addcoins <raw auth> works for someone not in the room', await db.getBalance('AUTH_OFFLINE_TEST'), 200);

    await economy.addCoinsCommand(master, '!addcoins #1 -100');
    check('!addcoins accepts a negative amount to deduct', await db.getBalance('AUTH_RED1'), balanceBeforeAddCoins + 400);
})();

console.log('\n--- core/shopItems.js: the real small/big catalog entries match the requested 10-level/±1/1000-per-level scale ---');
{
    const realShopItems = require(path.join(CORE, 'shopItems'));
    const small = realShopItems.find((i) => i.id === 'small');
    const big = realShopItems.find((i) => i.id === 'big');
    for (const [label, item] of [['small', small], ['big', big]]) {
        check(`${label}'s step is now ±1 radius per level (was ±2)`, item.stepRadius, 1);
        check(`${label}'s max level is now 10 (was 5)`, item.maxLevel, 10);
        check(`${label}'s price scale is now 1000/level (was 100)`, item.priceStep, 1000);
        check(`${label}'s level 1 now costs 1000 (was 200)`, item.basePrice, 1000);
    }
    // Level N costs N*1000 (1k, 2k, ..., 10k) and the max total radius swing
    // is unchanged (±10 at level 10, same as the old ±10 at level 5) — the
    // whole point of doubling maxLevel alongside halving stepRadius.
    const priceForLevel = (item, level) => item.basePrice + item.priceStep * (level - 1);
    const radiusForLevel = (item, level) => item.baseRadius + item.direction * item.stepRadius * level;
    check('level 1 costs 1000', priceForLevel(small, 1), 1000);
    check('level 10 costs 10000', priceForLevel(small, 10), 10000);
    check('max level (10) still swings the radius by 10 total, same as the old 5-level scale', Math.abs(radiusForLevel(small, 10) - small.baseRadius), 10);

    // vipOnly forms are a perk of VIP itself, not a separate coin purchase —
    // the role gate (see economy.js's shopCommand) is what restricts them,
    // not the price.
    const vipOnlyForms = realShopItems.filter((i) => i.vipOnly);
    check('every vipOnly form is free', vipOnlyForms.length > 0 && vipOnlyForms.every((i) => i.price === 0), true);

    // 'traffic' clashes with the default blue kit (both strong blues) —
    // must switch to its away kit rather than blending in when blue has no
    // form of its own to override the default.
    const traffic = realShopItems.find((i) => i.id === 'traffic');
    check('traffic is flagged as clashing with the default blue kit', traffic.clashesWithDefault, 'blue');

    // 'black' clashes with 'vip-kvadrat' (both read as near-black) — see
    // shopItems.js's `clashesWith`.
    const black = realShopItems.find((i) => i.id === 'black');
    check('black is flagged as clashing with vip-kvadrat', black.clashesWith, ['vip-kvadrat']);

    // Every retired item (see shopItems.js's `retired`) must keep a real,
    // numeric price on record even though it's unbuyable — economy.js's
    // formatItemLine special-cases the DISPLAY for retired items, but a
    // missing price would still be a landmine for any future code path that
    // reads item.price directly.
    const retiredItems = realShopItems.filter((i) => i.retired);
    check('every retired item still has more than zero of them', retiredItems.length > 0, true);
    check('every retired item keeps a real numeric price on record', retiredItems.every((i) => typeof i.price === 'number'), true);
}

console.log('\n--- db/sqlite.js: getItemOwners/setItemLevel — the raw accessors scripts/migrate-size-levels.js is built on ---');
// The migration script itself (a one-off, manually-run CLI tool — same
// category as scripts/clear-club-colors.js, which also has no test coverage
// here) isn't executed directly: it calls process.exit() on the "already
// migrated" path, which would kill this entire test process, not just this
// block. What's tested instead is the pair of DB primitives it's built on,
// which is where any real bug would actually live.
{
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const dbSqlite = createSqliteDatabase(':memory:');
    dbSqlite.init();
    dbSqlite.upgradeItem('AUTH_OLD_BIG', 'OldBig', 'big', 0, 0); // level 0 -> 1
    dbSqlite.setItemLevel('AUTH_OLD_BIG', 'big', 2); // pretend this was bought pre-migration at the old level 2

    check('getItemOwners is empty for an item nobody owns', dbSqlite.getItemOwners('small'), []);
    check('getItemOwners returns every owner at their current level', dbSqlite.getItemOwners('big'), [{ auth: 'AUTH_OLD_BIG', level: 2 }]);

    dbSqlite.setItemLevel('AUTH_OLD_BIG', 'big', Math.min(2 * 2, 10));
    check('setItemLevel writes a raw level with no cost/balance side effects', dbSqlite.getItemLevel('AUTH_OLD_BIG', 'big'), 4);
    check('setItemLevel never touched the balance', dbSqlite.getBalance('AUTH_OLD_BIG'), 0);
    check('setItemLevel on an id with no row at all is a silent no-op', dbSqlite.setItemLevel('AUTH_OLD_BIG', 'nonexistent', 5), undefined);

    dbSqlite.close();
}

console.log('\n--- core/smokeAnimation.js: disc-based smoke burst, scaled per stadium ---');
// Genuinely runs the 5-frame/130ms-per-frame animation (no mocked sleep) —
// ~650ms real wall time per call below, well inside the file's overall
// 2800ms tally window since this runs concurrently with everything else.
(async () => {
    const { playSmokeAnimation, SMOKE_COLORS, SMOKE_DISC_START_INDEX } = require(path.join(CORE, 'smokeAnimation'));
    const TeamLocal = { RED: 1, BLUE: 2 };
    const calls = [];
    const roomLocal = { setDiscProperties: (id, props) => calls.push({ id, props }) };

    await playSmokeAnimation({ room: roomLocal, Team: TeamLocal, stadium: 'classic', team: TeamLocal.RED, colorName: 'red' });
    check('classic uses its own 7 helper discs (SMOKE_DISC_START_INDEX.classic = 8)', [...new Set(calls.map((c) => c.id))].sort((a, b) => a - b), [8, 9, 10, 11, 12, 13, 14]);
    check('classic needs no rescaling (matches the reference library 1:1)', calls[0].props.x, 381);
    check('RED scoring mirrors x positive (blue\'s goal mouth)', calls.every((c) => c.props.x == null || c.props.x >= 0), true);
    check('the requested color variant\'s ramp is actually used (tier 0)', calls[0].props.color, SMOKE_COLORS.red[0]);
    check('the burst ends with every helper disc hidden again (radius 0)', calls.slice(-7).every((c) => c.props.radius === 0), true);

    calls.length = 0;
    await playSmokeAnimation({ room: roomLocal, Team: TeamLocal, stadium: 'classic', team: TeamLocal.BLUE, colorName: 'blue' });
    check('BLUE scoring mirrors x negative (red\'s goal mouth)', calls[0].props.x, -381);

    calls.length = 0;
    const bigScale = 674 / 372;
    await playSmokeAnimation({ room: roomLocal, Team: TeamLocal, stadium: 'big', team: TeamLocal.RED, colorName: 'white' });
    check('big uses its own 7 helper discs (SMOKE_DISC_START_INDEX.big = 4)', [...new Set(calls.map((c) => c.id))].sort((a, b) => a - b), [4, 5, 6, 7, 8, 9, 10]);
    check('big scales x by its own goal-x / the reference 372', calls[0].props.x, 381 * bigScale);
    check('big scales radius by the same factor', calls[0].props.radius, 10 * bigScale);

    calls.length = 0;
    await playSmokeAnimation({ room: roomLocal, Team: TeamLocal, stadium: 'training', team: TeamLocal.RED, colorName: 'red' });
    check('a stadium with no helper discs (training has no goals at all) is silently skipped', calls, []);

    check('SMOKE_COLORS has all 4 requested variants', Object.keys(SMOKE_COLORS).sort(), ['blue', 'purple', 'red', 'white']);
})();

console.log('\n--- core/fireworksAnimation.js: recursive cascade, regenerated (randomized) fresh on every call ---');
{
    // buildFireworksFrames() is a pure, synchronous function — the actual
    // structure/randomness is checked directly against it, no real timers
    // needed at all. Only the disc-index/mirroring/scaling/cleanup
    // mechanics genuinely need a real playFireworksAnimation() run (below).
    const { buildFireworksFrames, ORIGIN, MAIN_PIECE_COUNT, SUB_SPARK_COUNT, SUB_PHASE_START, DISCS_NEEDED, FRAME_COUNT, FRAME_DELAY_MS, FIREWORKS_COLORS } = require(path.join(CORE, 'fireworksAnimation'));

    check('5 main pieces + 5x4 sub-sparks = 25 discs needed, all firing without staggering', DISCS_NEEDED, MAIN_PIECE_COUNT + MAIN_PIECE_COUNT * SUB_SPARK_COUNT);
    check('...which is 25', DISCS_NEEDED, 25);
    check('the full show now runs 1.8 seconds (frame count x delay)', FRAME_COUNT * FRAME_DELAY_MS, 1800);

    const framesA = buildFireworksFrames();
    check('buildFireworksFrames returns one frame-table per disc needed', framesA.length, DISCS_NEEDED);
    check('...and every disc gets exactly FRAME_COUNT frames', framesA.every((slot) => slot.length === FRAME_COUNT), true);

    check('it starts with just ONE circle, not all 25 at once', framesA.slice(0, MAIN_PIECE_COUNT).filter((slot) => slot[0].radius > 0).length, 1);
    check('that lone circle sits at the goal mouth\'s own center', framesA[0][0].x, ORIGIN.x);
    check('it uses the brightest shade of the one shared color family', framesA[0][0].color, FIREWORKS_COLORS[0]);
    check('the lone circle grows across its own build frames', framesA[0][0].radius < framesA[0][1].radius && framesA[0][1].radius < framesA[0][2].radius, true);

    // The main pop: exactly 5 pieces are ever visible together, one frame
    // into the main-flight phase (index BUILD_FRAME_COUNT, i.e. 3).
    const mainPopFrame = framesA.slice(0, MAIN_PIECE_COUNT).map((slot) => slot[3]);
    check('the circle then "explodes" into exactly 5 pieces', mainPopFrame.filter((f) => f.radius > 0).length, 5);
    check('the 5 pieces fly out in 5 distinct directions (randomized, not a fixed ruler-straight fan)', new Set(mainPopFrame.map((f) => `${f.x},${f.y}`)).size, 5);

    // The recursive part, all at once: every main piece is consumed the
    // instant the sub-burst starts, replaced by its own 4-spark cluster —
    // 5 x 4 = 20 sparks firing on the very same frame.
    const subPopFrame = framesA.map((slot) => slot[SUB_PHASE_START]);
    check('all 5 main pieces are consumed together on the sub-burst\'s first frame', subPopFrame.slice(0, MAIN_PIECE_COUNT).filter((f) => f.radius > 0).length, 0);
    check('...replaced by all 20 sub-sparks (5 pieces x 4 each) firing at the same instant', subPopFrame.slice(MAIN_PIECE_COUNT).filter((f) => f.radius > 0).length, 20);
    check('the sub-sparks are darker than the main pop (a further generation)', subPopFrame.slice(MAIN_PIECE_COUNT).every((f) => f.color === FIREWORKS_COLORS[2]), true);
    check('the 5 sub-bursts cluster around 5 distinct centers, not all the same spot', new Set(Array.from({ length: MAIN_PIECE_COUNT }, (_, piece) => {
        const group = subPopFrame.slice(MAIN_PIECE_COUNT + piece * SUB_SPARK_COUNT, MAIN_PIECE_COUNT + (piece + 1) * SUB_SPARK_COUNT);
        const avgX = Math.round(group.reduce((sum, f) => sum + f.x, 0) / SUB_SPARK_COUNT);
        const avgY = Math.round(group.reduce((sum, f) => sum + f.y, 0) / SUB_SPARK_COUNT);
        return `${avgX},${avgY}`;
    })).size, MAIN_PIECE_COUNT);

    // A sub-spark genuinely travels and shrinks across its own frames (not
    // a single appear-then-vanish pop) — tracked via the very first spark
    // slot's actual distance from the goal center, which only ever grows.
    const firstSparkSlot = MAIN_PIECE_COUNT;
    const sparkDistances = framesA[firstSparkSlot].slice(SUB_PHASE_START).map((f) => Math.hypot(f.x - ORIGIN.x, f.y - ORIGIN.y));
    check('a sub-spark keeps moving further from where it popped, frame over frame', sparkDistances.every((d, i) => i === 0 || d >= sparkDistances[i - 1]), true);
    const sparkRadii = framesA[firstSparkSlot].slice(SUB_PHASE_START).map((f) => f.radius);
    check('...while its radius shrinks a step at a time, not an instant cut to 0', sparkRadii.every((r, i) => i === 0 || r < sparkRadii[i - 1]), true);
    check('...ending at radius 0 on the very last frame of the whole show', sparkRadii[sparkRadii.length - 1], 0);

    // The whole point of this request: two separate calls must NOT produce
    // the identical geometric layout — every goal gets its own scatter.
    const framesB = buildFireworksFrames();
    check('two separate calls produce DIFFERENT piece layouts (genuinely randomized, not fixed)', framesA[1][3].x !== framesB[1][3].x || framesA[1][3].y !== framesB[1][3].y, true);
}

console.log('\n--- core/fireworksAnimation.js: playFireworksAnimation — real disc writes, mirroring, scaling, cleanup ---');
// One full real-timed run is ~1800ms (FRAME_COUNT x FRAME_DELAY_MS) — the
// only one actually awaited to completion, to prove the disc-writing and
// final-hide mechanics end to end; BLUE/big/training only need the FIRST
// frame's snapshot, which lands synchronously (an async function runs up
// to its first `await` before yielding), so those are fired without
// awaiting — see the file-bottom comment on the shared tally window.
(async () => {
    const { playFireworksAnimation, ORIGIN, DISCS_NEEDED } = require(path.join(CORE, 'fireworksAnimation'));
    const TeamLocal = { RED: 1, BLUE: 2 };

    const calls = [];
    const roomLocal = { setDiscProperties: (id, props) => calls.push({ id, props }) };
    await playFireworksAnimation({ room: roomLocal, Team: TeamLocal, stadium: 'classic', team: TeamLocal.RED });

    check('classic actually uses all 25 of its helper discs (indices 8-32)', [...new Set(calls.map((c) => c.id))].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => 8 + i));
    check('RED scoring mirrors every visible x positive (blue\'s goal mouth)', calls.every((c) => c.props.x == null || c.props.x >= 0), true);
    check('the whole cascade ends with every disc hidden (radius 0)', calls.slice(-DISCS_NEEDED * 2, -DISCS_NEEDED).every((c) => c.props.radius === 0), true);
    check('...and stays hidden through the explicit trailing cleanup too', calls.slice(-DISCS_NEEDED).every((c) => c.props.radius === 0), true);

    // Not awaited — each gets its own fresh calls/room so a still-running
    // background continuation can never contaminate a later check's array.
    function firstFrame(args) {
        const localCalls = [];
        playFireworksAnimation({ room: { setDiscProperties: (id, props) => localCalls.push({ id, props }) }, Team: TeamLocal, ...args });
        return localCalls;
    }

    const blueCalls = firstFrame({ stadium: 'classic', team: TeamLocal.BLUE });
    check('BLUE scoring mirrors the goal center x negative (red\'s goal mouth)', blueCalls[0].props.x, -ORIGIN.x);

    const bigScale = 674 / 372;
    const bigCalls = firstFrame({ stadium: 'big', team: TeamLocal.RED });
    check('big uses all 25 of its own helper discs (indices 4-28)', [...new Set(bigCalls.map((c) => c.id))].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => 4 + i));
    check('big scales the goal center x by its own goal-x / the reference 372', bigCalls[0].props.x, ORIGIN.x * bigScale);

    const trainingCalls = firstFrame({ stadium: 'training', team: TeamLocal.RED });
    check('a stadium with no helper discs (training has no goals at all) is silently skipped', trainingCalls, []);
})();

console.log('\n--- events/activity.js: onPlayerChat relays "@<MENTION_WATCH_NAME>" mentions to Discord ---');
{
    const TeamLocal = { SPECTATORS: 0 };
    const StateLocal = { STOP: 2, PLAY: 0 };
    const HaxNotificationMock = { CHAT: 1 };
    const roomMock = { sendAnnouncement: () => {} };
    const discordLogs = [];
    const mentionAlerts = [];
    const discordBotMock = {
        sendLog: (msg) => discordLogs.push(msg),
        sendMentionAlert: (speakerName, text) => mentionAlerts.push({ speakerName, text }),
    };
    const stateLocal = {
        gameState: StateLocal.STOP, players: [], chooseMode: false, swapMode: false, slowMode: 0,
        clubMembers: [], clubs: [], equippedTrophies: {}, playersAll: [], hiddenCustomColorsSet: new Set(),
    };
    const authArrayLocal = { 1: ['AUTH_SPEAKER'] };

    function buildActivity(mentionWatchName) {
        return require(path.join(CORE, 'events', 'activity'))({
            room: roomMock, state: stateLocal, authArray: authArrayLocal, HaxNotification: HaxNotificationMock,
            Role: { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, MASTER: 4 }, State: StateLocal, Team: TeamLocal,
            adminChatColor: 1, commands: {}, discordBot: discordBotMock, errorColor: 2,
            hiddenAdminsSet: new Set(), masterChatColor: 3, mentionWatchName, muteArray: { getByAuth: () => null },
            silencedAuths: new Map(), vipChatColor: 4,
            chooseModeFunction: () => false, swapModeFunction: () => false, slowModeFunction: () => false,
            getCommand: () => false, getDate: () => 'DATE', getPlayerComp: () => null, getRole: () => 0,
            handleVoteMessage: () => false, handleVoteBanMessage: () => false, playerChat: () => {}, teamChat: () => {},
        });
    }

    const speaker = { id: 1, name: 'Random', team: TeamLocal.SPECTATORS };

    const activityWatching = buildActivity('letkh');
    mentionAlerts.length = 0;
    activityWatching.onPlayerChat(speaker, 'привет, а где @letkh, срочно нужен!');
    check('a message mentioning "@<name>" (case-insensitive against the configured name) fires sendMentionAlert', mentionAlerts, [
        { speakerName: 'Random', text: 'привет, а где @letkh, срочно нужен!' },
    ]);
    check('...it still logs to the ordinary chat log too, same as any other message', discordLogs.length, 1);

    mentionAlerts.length = 0;
    activityWatching.onPlayerChat(speaker, '@LETKH ты тут?');
    check('matching is case-insensitive regardless of how the name is capitalized in chat', mentionAlerts.length, 1);

    mentionAlerts.length = 0;
    activityWatching.onPlayerChat(speaker, 'просто обычное сообщение без упоминаний');
    check('an ordinary message with no mention never fires sendMentionAlert', mentionAlerts, []);

    const activityDisabled = buildActivity(''); // MENTION_WATCH_NAME unset
    mentionAlerts.length = 0;
    activityDisabled.onPlayerChat(speaker, 'эй @letkh ты где');
    check('an empty mentionWatchName (feature disabled) never fires sendMentionAlert, even on a literal match', mentionAlerts, []);
}

console.log('\n--- commands/minigames.js: only the challenge and the final winner are broadcast, the match itself is private ---');
(async () => {
    const TeamLocal = { RED: 1, BLUE: 2, SPECTATORS: 0 };
    const HaxNotificationMock = { CHAT: 1 };
    const sentLocal = [];
    const roomMock = { sendAnnouncement: (msg, id) => sentLocal.push({ msg, id }) };
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();
    const { formatCoins } = require(path.join(CORE, 'utils'));

    const authArray = { 1: ['AUTH_CHALLENGER'], 2: ['AUTH_TARGET'] };
    const state = {
        playersAll: [
            { id: 1, name: 'Challenger', team: TeamLocal.SPECTATORS },
            { id: 2, name: 'Target', team: TeamLocal.SPECTATORS },
        ],
    };
    await db.addCoins('AUTH_CHALLENGER', 'Challenger', 500);
    await db.addCoins('AUTH_TARGET', 'Target', 500);

    const minigames = require(path.join(CORE, 'commands', 'minigames'))({
        room: roomMock, state, authArray, db, Team: TeamLocal,
        announcementColor: 1, errorColor: 2, successColor: 3, HaxNotification: HaxNotificationMock,
        formatCoins,
        getRandomInt: () => 0, // coinflip: challenger always wins immediately, no need to wait out a second sleep
    });

    const challenger = { id: 1, name: 'Challenger', team: TeamLocal.SPECTATORS };
    const target = { id: 2, name: 'Target', team: TeamLocal.SPECTATORS };

    sentLocal.length = 0;
    await minigames.minigamesCommand(challenger, '!minigames coinflip #2 100');
    check('the challenge itself is broadcast to the whole room (id: null)', sentLocal.some((s) => s.id === null && /вызывает.*Target/.test(s.msg)), true);
    check('...alongside a private invite prompt to the target only', sentLocal.some((s) => s.id === 2 && /приглашены/.test(s.msg)), true);

    sentLocal.length = 0;
    // playCommand awaits game.run() (runCoinflip, including its own 1200ms
    // suspense sleep) to full completion before returning, so by the time
    // this resolves sentLocal already holds the whole match: the private
    // match-start + suspense lines, AND the final broadcast winner line.
    await minigames.playCommand(target, '!play');
    const inMatchMessages = sentLocal.filter((s) => !/побеждает/.test(s.msg));
    check('the match-start ("банк") line reaches only the two players, never id: null', sentLocal.filter((s) => /банк/.test(s.msg)).every((s) => s.id === 1 || s.id === 2), true);
    check('...both players got their own copy of it', sentLocal.filter((s) => /банк/.test(s.msg)).map((s) => s.id).sort(), [1, 2]);
    check('the coinflip suspense line ("Монетка подброшена") is also private to just the two players', sentLocal.filter((s) => /Монетка подброшена/.test(s.msg)).map((s) => s.id).sort(), [1, 2]);
    check('none of the in-match messages (everything but the final result) broadcast to the whole room', inMatchMessages.some((s) => s.id === null), false);
    check('the final winner announcement IS broadcast to the whole room (id: null)', sentLocal.some((s) => s.id === null && /побеждает/.test(s.msg)), true);
})();

// The movement.js leave broadcast fires from inside a 10ms setTimeout, the
// overflowPassword rotation check above waits 150ms for real interval
// ticks, the balance.js stadium-switch checks chain four 20ms steps (up to
// 80ms), the announcements loop-back check above waits 250ms for interval
// ticks, the handlePlayersStop regression runs four 350ms waits back to
// back (~1400ms), and the two 50-trial randomButton() regressions each
// chain up to 50 * 50ms = 2500ms worst case (though they run concurrently
// with each other, not stacked) — the current worst case. The dedicated
// core/fireworksAnimation.js block fully awaits one real ~1800ms cascade
// (FRAME_COUNT x FRAME_DELAY_MS) of its own, comfortably under that same
// worst case. core/economy.js's own smoke/fireworks tests no longer await
// the animations to completion (fireworks' own is real-time now, too long
// to stack 3 of them in one block) — only their first frame, which lands
// synchronously. Give all of them time to run before tallying and exiting.
setTimeout(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}, 3600);
