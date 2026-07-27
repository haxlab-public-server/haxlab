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

console.log('--- stats/print.js: only playtime is shown, per haxchill\'s no-stat-race policy ---');
{
    const createPrintStats = require(path.join(CORE, 'stats', 'print'));
    const printStats = createPrintStats({ getTimeStats: (seconds) => `${Math.floor(seconds / 60)}m` });
    const stats = {
        playerName: 'Alice', games: 10, wins: 7, winrate: '70.0%', playtime: 600,
        goals: 25, assists: 12, CS: 3, ownGoals: 1,
    };
    const output = printStats.printPlayerStats(stats);
    check('shows the player name', output.includes('Alice'), true);
    check('shows playtime', output.includes('Время игры: 10m'), true);
    check('does not show a Games label', /\bGames\b/.test(output), false);
    check('does not show a Goals label', /\bGoals\b/.test(output), false);
    check('does not show Wins/Winrate labels', /\bWin/i.test(output), false);
    check('does not show an Assists label', /Assist/i.test(output), false);
    check('does not show CS/Own Goals labels', /\bCS\b|Own\s?Goal/i.test(output), false);
}

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
    const { formatBanRemaining } = require(path.join(CORE, 'utils'));
    const master = require(path.join(CORE, 'commands', 'master'))({
        room, state, authArray, db, masterList: ['AUTH_CALLER'],
        announcementColor: 1, errorColor: 2, HaxNotification,
        formatBanRemaining,
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
    // should ever be touched by these.
    roomCalls.length = 0;
    await master.setVipCommand(caller, '!setvip #5');
    check('setVipCommand adds to the in-memory vipList', state.vipList, [['AUTH_TARGET', 'NewAdmin']]);
    check('setVipCommand persists the VIP to the database', db.getVips(), [{ auth: 'AUTH_TARGET', playerName: 'NewAdmin' }]);
    check('setVipCommand never touches the room admin badge', roomCalls.some((c) => c.startsWith('setPlayerAdmin')), false);

    sent.length = 0;
    await master.setVipCommand(caller, '!setvip #5');
    check('setVipCommand rejects someone who is already VIP', /уже является VIP/.test(sent[0].msg), true);

    sent.length = 0;
    master.vipListCommand(caller, '!vips');
    check('vipListCommand lists the current VIP', sent[0].msg, '📢 Список VIP : NewAdmin[0].');

    roomCalls.length = 0;
    await master.removeVipCommand(caller, '!removevip #5');
    check('removeVipCommand clears the in-memory vipList', state.vipList, []);
    check('removeVipCommand removes the VIP from the database', db.getVips(), []);
    check('removeVipCommand never touches the room admin badge', roomCalls.some((c) => c.startsWith('setPlayerAdmin')), false);

    sent.length = 0;
    master.vipListCommand(caller, '!vips');
    check('vipListCommand reports an empty VIP list', /никого нет/.test(sent[0].msg), true);

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

    const player = require(path.join(CORE, 'commands', 'player'))({
        room, state, Team, Role: { PLAYER: 0 }, HaxStatistics, authArray, db,
        AFKSet: new Set(), AFKMinSet: new Set(), AFKCooldownSet: new Set(),
        minAFKDuration: 0, maxAFKDuration: 0, AFKCooldown: 0,
        announcementColor: 1, errorColor: 3, infoColor: 5, successColor: 6, HaxNotification,
        getCommand: () => false, getRole: () => 0, handlePlayersJoin: () => {}, handlePlayersLeave: () => {},
        printPlayerStats: (s) => `stats-for-${s.playerName}`, printRankings: () => {}, updateTeams: () => {},
        getCommands: () => ({}),
    });

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
    check('addVip records the VIP', db.getVips(), [{ auth: 'AUTH_DONOR', playerName: 'Donor' }]);
    db.addVip('AUTH_DONOR', 'DonorRenamed');
    check('addVip upserts the player name rather than duplicating', db.getVips(), [{ auth: 'AUTH_DONOR', playerName: 'DonorRenamed' }]);
    db.removeVip('AUTH_DONOR');
    check('removeVip clears it', db.getVips(), []);

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

    check('getEquipped starts with all three slots empty', db.getEquipped('AUTH_NEWBIE'), { form: null, goalAnimation: null, size: null });
    db.setEquipped('AUTH_NEWBIE', 'goalAnimation', 'fire');
    check('setEquipped fills only the targeted slot', db.getEquipped('AUTH_NEWBIE'), { form: null, goalAnimation: 'fire', size: null });
    db.buyItem('AUTH_NEWBIE', 'Newbie', 'gold', 0);
    db.setEquipped('AUTH_NEWBIE', 'form', 'gold');
    check('setEquipped on a second slot leaves the first untouched', db.getEquipped('AUTH_NEWBIE'), { form: 'gold', goalAnimation: 'fire', size: null });
    db.buyItem('AUTH_NEWBIE', 'Newbie', 'small', 0);
    db.setEquipped('AUTH_NEWBIE', 'size', 'small');
    check('setEquipped on the size slot leaves the other two untouched', db.getEquipped('AUTH_NEWBIE'), { form: 'gold', goalAnimation: 'fire', size: 'small' });

    // backup() must take a consistent, queryable snapshot (VACUUM INTO) even
    // though the source db here is a live, still-open :memory: database.
    {
        const os = require('os');
        const backupPath = path.join(os.tmpdir(), `haxchill-smoke-backup-${Date.now()}.sqlite`);
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

console.log('\n--- discord.js: message/interaction-handling logic (no live Discord connection needed) ---');
// Wrapped in an async IIFE: handleIncomingMessage/handleSlashCommand are now
// async (kickPlayerByAuth crosses to the game process over IPC in real use —
// see core/discordProcess.js), so their result must be awaited. This runs
// concurrently with the synchronous sections below it (there's no top-level
// await in CommonJS); the final tally at the bottom of this file waits long
// enough for it to finish before counting pass/fail.
(async () => {
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const { handleIncomingMessage, handleSlashCommand, handleGuildMemberAdd, listCurrentPlayers } = require(path.join(CORE, 'discord'));
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

    // Auto-role on join: every new Discord member gets the configured role,
    // regardless of whether they've ever linked a HaxBall account.
    const addedRoles = [];
    const newMember = { roles: { add: (roleId) => { addedRoles.push(roleId); return Promise.resolve(); } } };
    handleGuildMemberAdd(newMember, { discordAutoRoleId: 'ROLE_123' });
    check('handleGuildMemberAdd assigns the configured role', addedRoles, ['ROLE_123']);

    addedRoles.length = 0;
    handleGuildMemberAdd(newMember, { discordAutoRoleId: '' });
    check('handleGuildMemberAdd is a no-op when no role is configured', addedRoles, []);

    db.close();
})();

console.log('\n--- events/activity.js: MASTER/ADMIN/VIP get a chat prefix, regular players don\'t ---');
{
    const Role = { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, MASTER: 4 };
    const State = { PLAY: 0, PAUSE: 1, STOP: 2 };
    const state = { gameState: State.STOP, chooseMode: false, slowMode: 0 };
    const authArray = [];
    authArray[1] = ['AUTH_MASTER'];
    authArray[2] = ['AUTH_ADMIN'];
    authArray[3] = ['AUTH_VIP'];
    authArray[4] = ['AUTH_PLAIN'];
    // getRole is mocked here (rather than reusing index.js's real hierarchy)
    // since this test only exercises activity.js's own branching logic.
    const roles = { 1: Role.MASTER, 2: Role.ADMIN_TEMP, 3: Role.VIP, 4: Role.PLAYER };
    const discordLogs = [];
    const activity = require(path.join(CORE, 'events', 'activity'))({
        room, state, authArray, BallTouch: class {}, HaxNotification, Role,
        Situation: {}, State, Team,
        adminChatColor: 'ADMIN_COLOR', masterChatColor: 'MASTER_COLOR', vipChatColor: 'VIP_COLOR',
        commands: {}, discordBot: { sendLog: (m) => discordLogs.push(m) }, errorColor: 2,
        muteArray: { getByAuth: () => null },
        checkGoalKickTouch: () => null, chooseModeFunction: () => false,
        getCommand: () => false, getDate: () => 'DATE', getGoalGame: () => null,
        getPlayerComp: () => null, getRole: (p) => roles[p.id],
        playerChat: () => {}, slowModeFunction: () => false, teamChat: () => {},
    });

    sent.length = 0;
    const masterResult = activity.onPlayerChat({ id: 1, name: 'Boss', team: Team.SPECTATORS, admin: true }, 'hello everyone');
    check('MASTER chat is suppressed (native bubble replaced)', masterResult, false);
    check('MASTER gets a [ВЛАДЕЛЕЦ] prefix', sent[0], { msg: '👑 [ВЛАДЕЛЕЦ] Boss: hello everyone', id: null, style: 'bold' });

    sent.length = 0;
    const adminResult = activity.onPlayerChat({ id: 2, name: 'Mod', team: Team.SPECTATORS, admin: true }, 'hi');
    check('ADMIN chat is suppressed', adminResult, false);
    check('ADMIN gets an [АДМИН] prefix', sent[0], { msg: '🛡️ [АДМИН] Mod: hi', id: null, style: 'bold' });

    sent.length = 0;
    const vipResult = activity.onPlayerChat({ id: 3, name: 'Donor', team: Team.SPECTATORS, admin: false }, 'yo');
    check('VIP chat is suppressed', vipResult, false);
    check('VIP gets a [ВИП] prefix', sent[0], { msg: '⭐ [ВИП] Donor: yo', id: null, style: 'bold' });

    sent.length = 0;
    const plainResult = activity.onPlayerChat({ id: 4, name: 'Regular', team: Team.SPECTATORS, admin: false }, 'sup');
    check('a regular player is untouched: no announcement is sent', sent, []);
    check('a regular player\'s message falls through to the native chat bubble', plainResult, undefined);

    check('all four messages were still logged to Discord', discordLogs.length, 4);
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
    roomCalls.length = 0;
    calls.length = 0;
    balance.balanceTeams();
    check('a running 1v1 on classic pulls in exactly one pair from spectators to make 2v2', roomCalls, [`setPlayerTeam:3:${Team.RED}`, `setPlayerTeam:4:${Team.BLUE}`]);
    check('growing within the current map does not restart or switch stadiums', calls, []);

    // Once at classic's 2v2 cap, further spectators keep waiting — this is
    // exactly the "already-full match" case the very first check in this
    // block covers, just reached by growth instead of starting there.
    state.teamRed = [{ id: 1 }, { id: 3 }];
    state.teamBlue = [{ id: 2 }, { id: 4 }];
    state.teamSpec = [{ id: 5 }, { id: 6 }];
    roomCalls.length = 0;
    calls.length = 0;
    balance.balanceTeams();
    check('a 2v2 already at classic\'s cap leaves the rest of the spectators waiting', roomCalls, []);

    // Big allows growing all the way to a full 4v4 (still short of the
    // 8-player choose-mode threshold covered separately below).
    state.currentStadium = 'big';
    state.teamRed = [{ id: 1 }, { id: 3 }];
    state.teamBlue = [{ id: 2 }, { id: 4 }];
    state.teamSpec = [{ id: 5 }, { id: 6 }];
    state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
    roomCalls.length = 0;
    calls.length = 0;
    balance.balanceTeams();
    check('a running 2v2 on big grows to 3v3', roomCalls, [`setPlayerTeam:5:${Team.RED}`, `setPlayerTeam:6:${Team.BLUE}`]);
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
    roomCalls.length = 0;
    calls.length = 0;
    balance.balanceTeams();
    check('a match shrinking down to 2 players does not restart or switch stadium', calls, []);
    check('the shrunk match still rebalances to 1v1 from the remaining spectator', roomCalls, [`setPlayerTeam:2:${Team.BLUE}`]);

    // Same for shrinking down to 5 (more excess on one side than there are
    // spectators to cover) — the excess used to get benched to spectators to
    // force parity; the room's policy now is to just keep playing uneven
    // instead of pulling a player off the field because their opponent quit.
    state.teamRed = [{ id: 1 }, { id: 2 }, { id: 3 }];
    state.teamBlue = [{ id: 4 }];
    state.teamSpec = [{ id: 5 }];
    state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    roomCalls.length = 0;
    calls.length = 0;
    balance.balanceTeams();
    check('a match shrinking down to 5 players does not restart or switch stadium', calls, []);
    check('the excess player is left on the field instead of being benched', roomCalls, []);

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
    roomCalls.length = 0;
    balance.balanceTeams();
    check('dropping to 7 players (teamSize*2-1) does not bench anyone', roomCalls, []);
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
    state.currentStadium = 'classic';

    // Captain-choosing mode is reserved for a genuine full 4v4 house (8
    // players) — below that, an imbalanced team with excess spectators should
    // just get balanced directly, not send everyone into the pick ritual.
    state.teamRed = [{ id: 1 }, { id: 2 }];
    state.teamBlue = [{ id: 3 }];
    state.teamSpec = [{ id: 5 }, { id: 6 }];
    state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 5 }, { id: 6 }];
    roomCalls.length = 0;
    calls.length = 0;
    balance.balanceTeams();
    check('below a full house, an imbalanced team is balanced directly instead of entering choose mode', calls.includes('activateChooseMode'), false);
    check('exactly one spectator fills the smaller team, the rest keep waiting', roomCalls, [`setPlayerTeam:5:${Team.BLUE}`]);

    // Same shape, but now with a full 8-player house — choose mode is warranted.
    state.teamRed = [{ id: 1 }, { id: 2 }, { id: 7 }, { id: 8 }];
    state.teamBlue = [{ id: 3 }, { id: 9 }, { id: 10 }];
    state.teamSpec = [{ id: 5 }, { id: 6 }];
    state.players = new Array(9).fill(0).map((_, i) => ({ id: i }));
    roomCalls.length = 0;
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

    // Bug fix: 3v3/4v4 must use the big map — it must not stay on classic
    // just because the room grew into that size without an explicit !big.
    // Wrapped in an outer setTimeout so any earlier test's own deferred
    // stadiumCommand call (e.g. the single-player -> training case above,
    // itself scheduled via setTimeout(5)) has already fired and can't leak
    // into stadiumCalls; each scenario below is then chained the same way,
    // only starting once the previous one's check has run.
    setTimeout(() => {
        state.chooseMode = true;
        state.currentStadium = 'classic';
        state.players = new Array(8).fill(0).map((_, i) => ({ id: i }));
        stadiumCalls.length = 0;
        balance.handlePlayersStop(null);
        setTimeout(() => {
            check('a full 4v4 switches to the big map if it was still on classic', stadiumCalls, ['!big']);

            state.chooseMode = false;
            state.currentStadium = 'classic';
            state.players = new Array(6).fill(0).map((_, i) => ({ id: i }));
            stadiumCalls.length = 0;
            balance.handlePlayersStop(null);
            setTimeout(() => {
                check('a 3v3 switches to the big map if it was still on classic', stadiumCalls, ['!big']);

                state.currentStadium = 'big';
                state.players = new Array(6).fill(0).map((_, i) => ({ id: i }));
                stadiumCalls.length = 0;
                balance.handlePlayersStop(null);
                setTimeout(() => {
                    check('a 3v3 already on the big map does not needlessly re-switch', stadiumCalls, []);

                    state.currentStadium = 'big';
                    state.players = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
                    stadiumCalls.length = 0;
                    balance.handlePlayersStop(null);
                    setTimeout(() => {
                        check('a 2v2 switches back to classic if it was still on the big map', stadiumCalls, ['!classic']);

                        // 9+ players: choose mode's "any other count" branch
                        // (not exactly 2*teamSize) must also assert big — it's
                        // still a full-house-or-more scenario by definition.
                        state.chooseMode = true;
                        state.currentStadium = 'classic';
                        state.lastWinner = Team.RED;
                        state.players = new Array(9).fill(0).map((_, i) => ({ id: i }));
                        stadiumCalls.length = 0;
                        balance.handlePlayersStop(null);
                        setTimeout(() => {
                            check('9 players inside choose mode also asserts the big map', stadiumCalls, ['!big']);

                            // Defensive-only: 9+ outside choose mode shouldn't
                            // normally happen (endGame already turns choose
                            // mode on by then), but if it did, it must not be
                            // left on classic either.
                            state.chooseMode = false;
                            state.currentStadium = 'classic';
                            state.players = new Array(9).fill(0).map((_, i) => ({ id: i }));
                            stadiumCalls.length = 0;
                            balance.handlePlayersStop(null);
                            setTimeout(() => {
                                check('9 players outside choose mode (defensive edge case) also asserts the big map', stadiumCalls, ['!big']);
                            }, 20);
                        }, 20);
                    }, 20);
                }, 20);
            }, 20);
        }, 20);
    }, 20);
}

console.log('\n--- events/misc.js: nobody keeps an admin badge unless they are MASTER/ADMIN_PERM ---');
{
    const Role = { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, MASTER: 4 };
    const roles = { 1: Role.PLAYER, 2: Role.ADMIN_PERM, 3: Role.MASTER };
    const misc = require(path.join(CORE, 'events', 'misc'))({
        room, state: {}, HaxNotification, Role,
        discordBot: { sendLog: () => {} }, emptyPlayer: {}, errorColor: 2, infoColor: 5,
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
    const testItems = [
        { id: 'fire', type: 'goalAnimation', name: 'Огонь', price: 100, avatar: '🔥' },
        { id: 'gold', type: 'form', name: 'Золотой', price: 200, color: 0xffd700 },
        { id: 'small', type: 'size', name: 'Малыш', price: 50, radius: 12 },
    ];

    // Minimal in-memory stand-in for the real db, shaped exactly like the
    // bridged version (see dbBridgeClient.js) — every method returns a
    // Promise, since economy.js awaits all of them either way.
    function makeDbMock() {
        const balances = new Map();
        const owned = new Map();
        const equipped = new Map();
        return {
            addCoins: (auth, name, amount) => { balances.set(auth, (balances.get(auth) ?? 0) + amount); return Promise.resolve(); },
            getBalance: (auth) => Promise.resolve(balances.get(auth) ?? 0),
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
        setPlayerAvatar: (id, avatar) => roomCallsLocal.push(`setPlayerAvatar:${id}:${avatar}`),
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
    };

    const db = makeDbMock();
    const economy = require(path.join(CORE, 'economy'))({
        room: roomMock, state, authArray, db, items: testItems,
        Team, State, HaxNotification: HaxNotificationMock,
        announcementColor: 1, errorColor: 2, formatCoins,
    });

    await economy.awardMatchCoins(Team.RED);
    check('a win pays the winning team 50', await db.getBalance('AUTH_RED1'), 50);
    check('a win pays the losing team 25', await db.getBalance('AUTH_BLUE1'), 25);

    await economy.awardMatchCoins(Team.SPECTATORS);
    check('a draw pays everyone the loss rate, not the win rate', await db.getBalance('AUTH_RED1'), 75);
    check('a draw pays the other side the same loss rate', await db.getBalance('AUTH_BLUE1'), 50);

    // Playtime: 60s/tick, 10 minutes (600s) needed for a payout — both teams
    // are on the field for these ticks, so both accrue it, not just red.
    for (let i = 0; i < 9; i++) economy.tickPlaytime(60);
    check('playtime does not pay out before 10 minutes', await db.getBalance('AUTH_RED1'), 75);
    economy.tickPlaytime(60);
    check('playtime pays out once 10 minutes accumulate', await db.getBalance('AUTH_RED1'), 85);
    check('playtime pays out to every active player, not just one side', await db.getBalance('AUTH_BLUE1'), 60);

    state.gameState = State.STOP;
    economy.tickPlaytime(600);
    check('playtime never accrues while the game is not actually playing', await db.getBalance('AUTH_RED1'), 85);
    state.gameState = State.PLAY;

    // Shop: list, buy failures, a real purchase. Balance topped up to a
    // known round number here so these checks don't depend on the exact
    // arithmetic of every award/playtime step above.
    await db.addCoins('AUTH_BLUE1', 'Blue1', 40);
    check('balance topped up for the shop tests', await db.getBalance('AUTH_BLUE1'), 100);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop');
    check('!shop with no args lists the catalog and balance', /Магазин \(баланс: 100 монеток\)/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop nope');
    check('!shop <unknown id> reports no such item', /Нет такого товара/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop gold');
    check('!shop <id> too expensive for the current balance is rejected', /Недостаточно монет/.test(sentLocal[0].msg), true);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop fire');
    check('!shop <id> within budget succeeds', /Куплено: Огонь/.test(sentLocal[0].msg), true);
    check('the price was actually deducted', await db.getBalance('AUTH_BLUE1'), 0);

    sentLocal.length = 0;
    await economy.shopCommand({ id: 2, name: 'Blue1' }, '!shop fire');
    check('!shop <already-owned id> is rejected without charging again', /уже есть/.test(sentLocal[0].msg), true);

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

    // Equipping a 'size' item goes through applyEquippedDiscCosmetics too
    // (same as 'form'), unlike goalAnimation above.
    await db.buyItem('AUTH_BLUE1', 'Blue1', 'small', 0);
    roomCallsLocal.length = 0;
    sentLocal.length = 0;
    await economy.equipCommand({ id: 2, name: 'Blue1' }, '!equip small');
    check('!equip <owned size> confirms', /Надето: Малыш/.test(sentLocal[0].msg), true);
    check('equipping a size item applies it to the disc immediately', roomCallsLocal, [`setPlayerDiscProperties:2:${JSON.stringify({ radius: 12 })}`]);

    // applyEquippedDiscCosmetics / playGoalAnimation, called directly (as
    // gameManagement.js/movement.js would on join/team-change/goal).
    await db.buyItem('AUTH_RED1', 'Red1', 'gold', 0);
    await db.setEquipped('AUTH_RED1', 'form', 'gold');
    roomCallsLocal.length = 0;
    await economy.applyEquippedDiscCosmetics({ id: 1, name: 'Red1' });
    check('applyEquippedDiscCosmetics applies the equipped disc color', roomCallsLocal, [`setPlayerDiscProperties:1:${JSON.stringify({ color: 0xffd700 })}`]);

    // Blue1 has BOTH a form (none equipped) and a size (small) at this
    // point — only size should show up in the applied properties.
    roomCallsLocal.length = 0;
    await economy.applyEquippedDiscCosmetics({ id: 2, name: 'Blue1' });
    check('applyEquippedDiscCosmetics applies only the slots that are actually equipped', roomCallsLocal, [`setPlayerDiscProperties:2:${JSON.stringify({ radius: 12 })}`]);

    await db.setEquipped('AUTH_RED1', 'size', 'small');
    roomCallsLocal.length = 0;
    await economy.applyEquippedDiscCosmetics({ id: 1, name: 'Red1' });
    check('applyEquippedDiscCosmetics combines form + size into one call', roomCallsLocal, [`setPlayerDiscProperties:1:${JSON.stringify({ color: 0xffd700, radius: 12 })}`]);

    roomCallsLocal.length = 0;
    await economy.applyEquippedDiscCosmetics({ id: 3, name: 'Empty' });
    check('applyEquippedDiscCosmetics is a no-op with nothing equipped in either slot', roomCallsLocal, []);

    roomCallsLocal.length = 0;
    await economy.playGoalAnimation({ id: 2, name: 'Blue1' });
    check('playGoalAnimation flashes the equipped avatar', roomCallsLocal, ['setPlayerAvatar:2:🔥']);

    roomCallsLocal.length = 0;
    await economy.playGoalAnimation({ id: 1, name: 'Red1' });
    check('playGoalAnimation is a no-op with nothing equipped', roomCallsLocal, []);

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

// The movement.js leave broadcast fires from inside a 10ms setTimeout, the
// overflowPassword rotation check above waits 150ms for real interval
// ticks, the balance.js stadium-switch checks chain four 20ms steps (up to
// 80ms), and the announcements loop-back check above waits 250ms for
// interval ticks — give all of them time to run before tallying and exiting.
setTimeout(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}, 400);
