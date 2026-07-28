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
{
    const createPrintStats = require(path.join(CORE, 'stats', 'print'));
    const printStats = createPrintStats({ getTimeStats: (seconds) => `${Math.floor(seconds / 60)}m` });
    const stats = {
        playerName: 'Alice', games: 10, wins: 7, winrate: '70.0%', playtime: 600,
        goals: 25, assists: 12, CS: 3, ownGoals: 1,
    };
    const output = printStats.printPlayerStats(stats);
    check('shows the player name', output.includes('Alice'), true);
    check('shows games', output.includes('Игры: 10'), true);
    check('shows wins and winrate', output.includes('Победы: 7 (70.0%)'), true);
    check('shows playtime', output.includes('Время игры: 10m'), true);
    check('shows goals', output.includes('Голы: 25'), true);
    check('shows assists', output.includes('Ассисты: 12'), true);
    check('shows clean sheets', output.includes('Сухие матчи: 3'), true);
    check('shows own goals', output.includes('Автоголы: 1'), true);
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
    const hiddenAdminsSetMock = new Set();
    const activity = require(path.join(CORE, 'events', 'activity'))({
        room, state, authArray, BallTouch: class {}, HaxNotification, Role,
        Situation: {}, State, Team,
        adminChatColor: 'ADMIN_COLOR', masterChatColor: 'MASTER_COLOR', vipChatColor: 'VIP_COLOR',
        commands: {}, discordBot: { sendLog: (m) => discordLogs.push(m) }, errorColor: 2,
        hiddenAdminsSet: hiddenAdminsSetMock,
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

    // !hide (commands/admin.js) — suppresses just the MASTER/ADMIN prefix,
    // native chat bubble takes over same as a regular player would get.
    hiddenAdminsSetMock.add(1);
    sent.length = 0;
    const hiddenMasterResult = activity.onPlayerChat({ id: 1, name: 'Boss', team: Team.SPECTATORS, admin: true }, 'sneaky');
    check('a hidden MASTER gets no prefix announcement', sent, []);
    check('a hidden MASTER\'s message falls through to the native chat bubble', hiddenMasterResult, undefined);
    hiddenAdminsSetMock.delete(1);
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
        await wait(2100);
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
        await wait(2100);

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
        // bench/swap — see its own comment), but before the 2000ms
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

        await new Promise((resolve) => setTimeout(resolve, 1600));
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

console.log('\n--- team/balance.js: computeSpectatorsToInsert() counts the just-benched loser even when their setPlayerTeam lands a few ms late ---');
{
    // Reported live: 9 players at match end (2v2 + 5 waiting) settled on a
    // 3v3 with 3 non-AFK spectators left over, instead of the 4v4 those
    // numbers could fill. Root cause: computeSpectatorsToInsert() used to
    // be called SYNCHRONOUSLY right after blueToSpecButton()'s own tight
    // loop of room.setPlayerTeam() calls — but real headless HaxBall (via
    // Puppeteer) doesn't reliably deliver room.onPlayerTeamChange
    // synchronously for back-to-back calls (the same reasoning behind
    // every other "index [0], staggered 5ms apart" pattern in this file).
    // The just-benched losers weren't reliably counted yet, undercounting
    // how many were actually available. Fixed by deferring the count (and
    // the refill it schedules) by a tick. This mock specifically delays
    // ONLY the bench's own two moves landing by a few ms (simulating that
    // real lag) while everything else stays synchronous, to isolate
    // exactly the diagnosed gap. Kept well under the fix's own defer, not
    // right at the boundary — this whole test file runs dozens of blocks
    // sharing one event loop (a concurrency load no single real room ever
    // sees), so a tight margin here flakes on load unrelated to the fix.
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
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 300 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, setCustomStadium: () => {}, setDefaultStadium: () => {},
        stopGame: () => {}, startGame: () => {}, pauseGame: () => {},
        kickPlayer: () => {}, sendAnnouncement: () => {},
        setPlayerTeam: (id, team) => {
            if (benchTargets.has(id) && team === Team.SPECTATORS) {
                benchTargets.delete(id);
                setTimeout(() => applyMove(id, team), 2);
            } else {
                applyMove(id, team);
            }
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
        await new Promise((resolve) => setTimeout(resolve, 600));
        check('reaches a clean 4v4 with only the genuine 1-player leftover, not stuck at 3v3', [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [4, 4, 1]);
    })();
}

console.log('\n--- team/balance.js: an exact 4v4 finish (with genuine waiting spectators) benches the loser via WinStay and correctly switches to big, with chooseMode never touched ---');
{
    // Companion to the shared-block check above (which only verifies
    // activateChooseMode is never called, since that block stubs out the
    // actual bench/refill functions) — this uses the REAL button
    // implementations to confirm the full outcome: endGame() no longer
    // defensively activates choose mode for a full-or-bigger house (see
    // its own comment in entry.js), so handlePlayersStop's non-chooseMode
    // path now handles exactly 8 (with genuine spectators already waiting
    // — the realistic "9+" shape) via the same WinStay bench+refill logic
    // already used for every other total: RED (the winner) stays intact,
    // BLUE gets benched and refilled from the waiting spectators (not
    // randomFillAll()'s from-scratch reshuffle, which only kicks in when
    // teamSpec is genuinely empty), and the stadium still correctly
    // asserts to 'big'.
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
    };
    state.teamRed = players.filter((p) => p.team === Team.RED);
    state.teamBlue = players.filter((p) => p.team === Team.BLUE);
    state.teamSpec = players.filter((p) => p.team === Team.SPECTATORS);

    const stadiumCalls = [];
    const activateChooseModeCalls = [];
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
        activateChooseMode: () => activateChooseModeCalls.push(1), blueToSpecButton: buttons.blueToSpecButton, choosePlayer: () => {},
        deactivateChooseMode: () => {}, endGame: () => {}, getRandomInt: () => 0,
        getSpecList: () => {}, instantRestart: () => {}, randomButton: buttons.randomButton,
        redToSpecButton: buttons.redToSpecButton, resetButton: buttons.resetButton, resumeGame: () => {},
        stadiumCommand: (emptyPlayer, cmd) => { stadiumCalls.push(cmd); state.currentStadium = cmd.replace('!', ''); },
        swapButton: buttons.swapButton, topButton: buttons.topButton,
    });

    balance.handlePlayersStop(null);
    (async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        check('RED (the winner) stayed intact', state.teamRed.map((p) => p.id).sort(), [1, 2, 3, 4]);
        check('BLUE got fully refilled back to 4', state.teamBlue.length, 4);
        check('chooseMode was never activated for this', activateChooseModeCalls.length, 0);
        check('the stadium correctly asserts to big for a 4v4', stadiumCalls.includes('!big'), true);
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
            await new Promise((resolve) => setTimeout(resolve, 2100));
            const label = lastWinner === Team.RED ? 'RED' : 'BLUE';
            check(`1v1 (${label} won) + 1 waiting spectator settles on 1v1, spectator still waiting`, [state.teamRed.length, state.teamBlue.length, state.teamSpec.length], [1, 1, 1]);
        })();
    }
}

console.log('\n--- team/balance.js: handlePlayersStop with MORE than a full house rebuilds cleanly, not 4v5 ---');
{
    // Reported live, only reachable with players.length > 2*teamSize (a
    // full house PLUS extra waiting spectators): the refill used to count
    // spectatorsToInsert as players to insert, one per scheduled call, but
    // topButton() could insert 2 at once (its own pair branch, once
    // red==blue mid-loop) — confirmed in practice this overfilled past
    // 2*teamSize (4v5 instead of 4v4). Fixed by filling directly with
    // safeMoveNextSpec (always exactly one player) instead of topButton()
    // — now shared via pullSpectatorsToParity(), which every refill path
    // in this file goes through.
    //
    // This used to also cover a second bug: reaching this branch with
    // state.chooseMode still true (from endGame()'s own defensive
    // activateChooseMode() — since removed, see its own comment) used to
    // hit an entirely separate, near-identical copy of this branch that
    // forgot to deactivate choose mode, letting a second, uncoordinated
    // process react to every setPlayerTeam() call mid-rebuild. That whole
    // copy — and the scenario that reached it — no longer exists:
    // activateChooseMode() is never called defensively anymore, so
    // chooseMode is always false by the time a match naturally ends.
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

    const bogusPrompts = [];
    const roomMock = {
        getScores: () => ({ red: 0, blue: 0, scoreLimit: 3, time: 0, timeLimit: 3 }),
        setScoreLimit: () => {}, setTimeLimit: () => {}, pauseGame: () => {}, startGame: () => {},
        sendAnnouncement: (msg) => { if (msg.includes('Для выбора игрока')) bogusPrompts.push(msg); },
        kickPlayer: () => bogusPrompts.push('KICK'),
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
        check('more than a full house rebuilds to exactly 4v4, not 4v5', [state.teamRed.length, state.teamBlue.length], [4, 4]);
        check('no bogus "pick a player" prompt or kick fires during the automatic rebuild', bogusPrompts, []);
        check('chooseMode is off once the automatic rebuild settles', state.chooseMode, false);
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

        // Bug: a full 4v4 (teamSize=4) plus MORE waiting spectators than
        // room for (3 extra, 11 total) — endGame() activates choose mode
        // defensively any time players >= 2*teamSize, so this is a mainline
        // path, not an edge case. spectatorsToInsert used to equal
        // state.teamSpec.length outright (7, after benching the losing
        // side) instead of capping at how many actually fit up to teamSize
        // per side (4) — draining every one of them regardless kept calling
        // topButton() after both sides already reached teamSize, growing
        // the match to 5v5 and beyond instead of stopping at a clean 4v4
        // with the genuine extras left waiting.
        const state4 = runScenario(4, 4, Team.RED, true, 3);
        await wait(350);
        check('11 players (4v4 full + 3 extra spectators): stops at a clean 4v4, does not overgrow', [state4.teamRed.length, state4.teamBlue.length], [4, 4]);
        check('11 players (4v4 full + 3 extra spectators): the genuine extras are left waiting, not forced in', state4.teamSpec.length, 3);
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
    const HaxNotificationMock = { CHAT: 1 };
    const roomCallsLocal = [];
    const roomMock = { setPlayerTeam: (id, team) => roomCallsLocal.push(`setPlayerTeam:${id}:${team}`), sendAnnouncement: () => {} };
    const AFKSetLocal = new Set();
    const player = require(path.join(CORE, 'commands', 'player'))({
        room: roomMock, state: { players: [{ id: 1 }, { id: 2 }] }, Team, AFKSet: AFKSetLocal,
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
    const soloState = { players: [{ id: 3 }] };
    const soloAFKSet = new Set();
    const soloPlayer = require(path.join(CORE, 'commands', 'player'))({
        room: roomMock, state: soloState, Team, AFKSet: soloAFKSet,
        AFKMinSet: new Set(), AFKCooldownSet: new Set(), minAFKDuration: 5, maxAFKDuration: 30, AFKCooldown: 2,
        announcementColor: 1, errorColor: 2, HaxNotification: HaxNotificationMock,
        handlePlayersJoin: () => {}, handlePlayersLeave: () => {}, updateTeams: () => {},
    });
    roomCallsLocal.length = 0;
    soloPlayer.afkCommand({ id: 3, name: 'Solo', team: Team.RED }, '!afk');
    check('!afk from the lone remaining player, still on a team, does move them to spectators', roomCallsLocal, [`setPlayerTeam:3:${Team.SPECTATORS}`]);
}

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
    const testItems = [
        { id: 'fire', type: 'goalAnimation', name: 'Огонь', price: 100, avatar: '🔥' },
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
        getPlayerDiscProperties: (id) => ({ radius: 15 }),
        setPlayerAvatar: (id, avatar) => roomCallsLocal.push(`setPlayerAvatar:${id}:${avatar}`),
        setTeamColors: (team, angle, textColor, colors) => roomCallsLocal.push(`setTeamColors:${team}:${JSON.stringify(colors)}`),
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
    const { getRandomInt } = require(path.join(CORE, 'utils'));
    const economy = require(path.join(CORE, 'economy'))({
        room: roomMock, state, authArray, db, items: testItems,
        Team, State, HaxNotification: HaxNotificationMock,
        announcementColor: 1, errorColor: 2, formatCoins, getRandomInt,
    });

    sentLocal.length = 0;
    await economy.awardMatchCoins(Team.RED);
    check('a win pays the winning team 50', await db.getBalance('AUTH_RED1'), 50);
    check('a win pays the losing team 25', await db.getBalance('AUTH_BLUE1'), 25);
    check('the winner gets a private notification, not a broadcast', sentLocal.find((s) => s.id === 1).id, 1);
    check('the win notification shows new balance + delta in the requested format', sentLocal.find((s) => s.id === 1).msg, '💰 Баланс: 50 (+50 монеток)');
    check('the loser also gets a private notification', sentLocal.find((s) => s.id === 2).msg, '💰 Баланс: 25 (+25 монеток)');
    check('coin notifications are never broadcast to the whole room', sentLocal.every((s) => s.id !== null && s.id !== undefined), true);

    sentLocal.length = 0;
    await economy.awardMatchCoins(Team.SPECTATORS);
    check('a draw pays everyone the loss rate, not the win rate', await db.getBalance('AUTH_RED1'), 75);
    check('a draw pays the other side the same loss rate', await db.getBalance('AUTH_BLUE1'), 50);
    check('a draw still notifies privately with the loss-rate delta', sentLocal.find((s) => s.id === 1).msg, '💰 Баланс: 75 (+25 монеток)');

    // Playtime: 60s/tick, 10 minutes (600s) needed for a payout — both teams
    // are on the field for these ticks, so both accrue it, not just red.
    for (let i = 0; i < 9; i++) economy.tickPlaytime(60);
    check('playtime does not pay out before 10 minutes', await db.getBalance('AUTH_RED1'), 75);
    sentLocal.length = 0;
    economy.tickPlaytime(60);
    check('playtime pays out once 10 minutes accumulate', await db.getBalance('AUTH_RED1'), 85);
    check('playtime pays out to every active player, not just one side', await db.getBalance('AUTH_BLUE1'), 60);
    // tickPlaytime's payout notification is fire-and-forget (a .then() chain,
    // not awaited by the caller — real callers are a setInterval tick) —
    // flush the microtask queue before checking it landed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('a playtime payout also notifies privately', sentLocal.find((s) => s.id === 1).msg, '💰 Баланс: 85 (+10 монеток)');

    state.gameState = State.STOP;
    economy.tickPlaytime(600);
    check('playtime never accrues while the game is not actually playing', await db.getBalance('AUTH_RED1'), 85);
    state.gameState = State.PLAY;

    // !balance: a plain, on-demand balance check.
    sentLocal.length = 0;
    await economy.balanceCommand({ id: 1, name: 'Red1' }, '!balance');
    check('!balance reports the current balance privately', sentLocal, [{ msg: '💰 Ваш баланс: 85 монеток', id: 1 }]);

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

    // !unequip: rejects an id that isn't currently equipped. 'violet' is a
    // real item (so this exercises the "wrong slot value" rejection, not
    // just "unknown id") but Blue1 has neither bought nor equipped it —
    // gold is what's actually in the form slot right now.
    sentLocal.length = 0;
    await economy.unequipCommand({ id: 2, name: 'Blue1' }, '!unequip violet');
    check('!unequip <not currently equipped> is rejected', /не надето/.test(sentLocal[0].msg), true);
    check('rejection never touches the db', (await db.getEquipped('AUTH_BLUE1')).form, 'gold');

    // !unequip: unknown id.
    sentLocal.length = 0;
    await economy.unequipCommand({ id: 2, name: 'Blue1' }, '!unequip nope');
    check('!unequip <unknown id> reports no such item', /Нет такого/.test(sentLocal[0].msg), true);

    // !unequip: the currently-equipped form — same setTeamColors recompute
    // as equipping one, just falling back to the default kit instead.
    roomCallsLocal.length = 0;
    sentLocal.length = 0;
    await economy.unequipCommand({ id: 2, name: 'Blue1' }, '!unequip gold');
    check('!unequip <currently equipped> confirms', /Снято: Золотой/.test(sentLocal[0].msg), true);
    check('the slot is actually cleared in the db', (await db.getEquipped('AUTH_BLUE1')).form, null);
    check('unequipping a form recomputes both sides back to their defaults', roomCallsLocal, [
        `setTeamColors:${Team.RED}:${JSON.stringify([0xe56e56])}`,
        `setTeamColors:${Team.BLUE}:${JSON.stringify([0x6a8ef5])}`,
    ]);

    // Equipping a 'size' item has NO immediate effect — it's a post-goal-only
    // celebration (see playGoalSizeEffect below), never a standing radius
    // change, so equipping never touches the disc.
    await db.buyItem('AUTH_BLUE1', 'Blue1', 'small', 0);
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

    // playGoalSizeEffect: Blue1 has 'small' equipped (from the !equip test
    // above) — briefly swaps the radius in, captured from the disc's own
    // CURRENT properties (mocked at radius 15 here), not a hardcoded default.
    roomCallsLocal.length = 0;
    await economy.playGoalSizeEffect({ id: 2, name: 'Blue1' });
    check('playGoalSizeEffect applies the equipped radius', roomCallsLocal, [`setPlayerDiscProperties:2:${JSON.stringify({ radius: 12 })}`]);

    roomCallsLocal.length = 0;
    await economy.playGoalSizeEffect({ id: 1, name: 'Red1' });
    check('playGoalSizeEffect is a no-op with nothing equipped', roomCallsLocal, []);

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
// 80ms), the announcements loop-back check above waits 250ms for interval
// ticks, the handlePlayersStop regression runs four 350ms waits back to
// back (~1400ms), and the two 50-trial randomButton() regressions each
// chain up to 50 * 50ms = 2500ms worst case (the slowest of the bunch,
// though they run concurrently with each other, not stacked) — give all
// of them time to run before tallying and exiting.
setTimeout(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}, 2800);
