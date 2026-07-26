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
}

console.log('\n--- commands/master.js: writes must land in shared state ---');
{
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

    const state = { banList: [], roomPassword: '', adminList: [], vipList: [], playersAll: [] };
    const authArray = [];
    authArray[9] = ['AUTH_CALLER'];
    authArray[5] = ['AUTH_TARGET'];
    const master = require(path.join(CORE, 'commands', 'master'))({
        room, state, authArray, db, masterList: ['AUTH_CALLER'],
        announcementColor: 1, errorColor: 2, HaxNotification,
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
    room.getPlayer = (id) => (id === 5 ? { id: 5, name: 'NewAdmin' } : null);
    roomCalls.length = 0;
    master.setAdminCommand(caller, '!setadmin #5');
    check('setAdminCommand adds to in-memory adminList', state.adminList, [['AUTH_TARGET', 'NewAdmin']]);
    check('setAdminCommand persists the admin to the database', db.getAdmins(), [{ auth: 'AUTH_TARGET', playerName: 'NewAdmin' }]);
    check('setAdminCommand grants the room admin badge', roomCalls.includes('setPlayerAdmin:5:true'), true);

    roomCalls.length = 0;
    master.removeAdminCommand(caller, '!removeadmin #5');
    check('removeAdminCommand clears the in-memory adminList', state.adminList, []);
    check('removeAdminCommand removes the admin from the database', db.getAdmins(), []);
    check('removeAdminCommand revokes the room admin badge', roomCalls.includes('setPlayerAdmin:5:false'), true);

    // VIP grants no permissions — unlike setAdminCommand, no room admin badge
    // should ever be touched by these.
    roomCalls.length = 0;
    master.setVipCommand(caller, '!setvip #5');
    check('setVipCommand adds to the in-memory vipList', state.vipList, [['AUTH_TARGET', 'NewAdmin']]);
    check('setVipCommand persists the VIP to the database', db.getVips(), [{ auth: 'AUTH_TARGET', playerName: 'NewAdmin' }]);
    check('setVipCommand never touches the room admin badge', roomCalls.some((c) => c.startsWith('setPlayerAdmin')), false);

    sent.length = 0;
    master.setVipCommand(caller, '!setvip #5');
    check('setVipCommand rejects someone who is already VIP', /уже является VIP/.test(sent[0].msg), true);

    sent.length = 0;
    master.vipListCommand(caller, '!vips');
    check('vipListCommand lists the current VIP', sent[0].msg, '📢 Список VIP : NewAdmin[0].');

    roomCalls.length = 0;
    master.removeVipCommand(caller, '!removevip #5');
    check('removeVipCommand clears the in-memory vipList', state.vipList, []);
    check('removeVipCommand removes the VIP from the database', db.getVips(), []);
    check('removeVipCommand never touches the room admin badge', roomCalls.some((c) => c.startsWith('setPlayerAdmin')), false);

    sent.length = 0;
    master.vipListCommand(caller, '!vips');
    check('vipListCommand reports an empty VIP list', /никого нет/.test(sent[0].msg), true);

    // Auth-ban commands: must work on someone currently in the room (kicked
    // immediately) as well as an auth that isn't online right now.
    state.playersAll = [{ id: 5, name: 'Cheater' }];
    roomCalls.length = 0;
    sent.length = 0;
    master.banAuthCommand(caller, '!banauth AUTH_TARGET aimbot');
    check('banAuthCommand records the ban under the live player\'s current name', db.getAuthBan('AUTH_TARGET'), { auth: 'AUTH_TARGET', playerName: 'Cheater', reason: 'aimbot' });
    check('banAuthCommand kicks the player if they are currently online', roomCalls.includes('kickPlayer:5:Вы забанены: aimbot:false'), true);

    roomCalls.length = 0;
    sent.length = 0;
    master.banAuthCommand(caller, '!banauth AUTH_OFFLINE griefing');
    check('banAuthCommand records an offline auth using the auth itself as the name', db.getAuthBan('AUTH_OFFLINE'), { auth: 'AUTH_OFFLINE', playerName: 'AUTH_OFFLINE', reason: 'griefing' });
    check('banAuthCommand does not try to kick when nobody with that auth is online', roomCalls.some((c) => c.startsWith('kickPlayer')), false);

    sent.length = 0;
    master.unbanAuthCommand(caller, '!unbanauth AUTH_NEVER_BANNED');
    check('unbanAuthCommand reports an auth that was never banned', /не забанен/.test(sent[0].msg), true);

    sent.length = 0;
    master.unbanAuthCommand(caller, '!unbanauth AUTH_TARGET');
    check('unbanAuthCommand clears the ban', db.getAuthBan('AUTH_TARGET'), null);

    sent.length = 0;
    master.authBanListCommand(caller, '!authbans');
    check('authBanListCommand lists the remaining auth ban', /AUTH_OFFLINE/.test(sent[0].msg), true);

    sent.length = 0;
    master.playersListCommand(caller, '!players');
    check('playersListCommand lists the live room roster with auth', sent[0].msg, '📢 Игроки в комнате : Cheater [AUTH_TARGET].');

    state.playersAll = [];
    sent.length = 0;
    master.playersListCommand(caller, '!players');
    check('playersListCommand reports an empty room', /никого нет/.test(sent[0].msg), true);

    db.close();
}

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
{
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();

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
    roomStats.updatePlayerStats({ id: 1, name: 'Alice' }, Team.RED);
    roomStats.updatePlayerStats({ id: 2, name: 'Bob' }, Team.BLUE);
    check('goals persisted for the winner', db.getPlayerStats('AUTH_ALICE').goals, 5);
    check('wins only counted for the winning team', db.getPlayerStats('AUTH_BOB').wins, 0);
    check('wins counted for the winning team', db.getPlayerStats('AUTH_ALICE').wins, 1);

    check('games increments across saves', (() => {
        roomStats.updatePlayerStats({ id: 1, name: 'Alice' }, Team.RED);
        return db.getPlayerStats('AUTH_ALICE').games;
    })(), 2);
    check('goals accumulate across saves', db.getPlayerStats('AUTH_ALICE').goals, 10);

    // 2 players so far (Alice, Bob); 2 more fillers keeps it at 4 — still short of 5.
    for (let i = 0; i < 2; i++) db.savePlayerStats(`AUTH_FILLER${i}`, new HaxStatistics(`Filler${i}`));
    sent.length = 0;
    roomStats.printRankings('goals', 0);
    check('leaderboard needs >= 5 entries before announcing', sent.length, 0);

    db.savePlayerStats('AUTH_FILLER2', Object.assign(new HaxStatistics('Filler2'), { goals: 100 }));
    sent.length = 0;
    roomStats.printRankings('goals', 0);
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
    player.globalStatsCommand({ id: 1, name: 'Alice' }, '!me');
    check('globalStatsCommand reads the same row updatePlayerStats wrote', sent[0].msg, 'stats-for-Alice');

    sent.length = 0;
    player.renameCommand({ id: 1, name: 'Alice' }, '!rename Queen Alice');
    check('renameCommand updates only the name', db.getPlayerStats('AUTH_ALICE').playerName, 'Queen Alice');
    check('renameCommand preserves other stats', db.getPlayerStats('AUTH_ALICE').goals, 10);

    sent.length = 0;
    player.renameCommand({ id: 3, name: 'NewPlayer' }, '!rename');
    check('renameCommand on a player with no games reports the error, not a crash', /еще не играли/.test(sent[0].msg), true);

    sent.length = 0;
    player.linkDiscordCommand({ id: 1, name: 'Alice' }, '!discord 123456789012345678');
    check('linkDiscordCommand stores the link', db.getDiscordIdByAuth('AUTH_ALICE'), '123456789012345678');
    check('linkDiscordCommand confirms success', /связан/.test(sent[0].msg), true);

    sent.length = 0;
    player.linkDiscordCommand({ id: 1, name: 'Alice' }, '!discord not-a-real-id');
    check('linkDiscordCommand rejects a non-numeric ID', /Неверный ID Discord/.test(sent[0].msg), true);
    check('linkDiscordCommand does not overwrite the valid link with garbage', db.getDiscordIdByAuth('AUTH_ALICE'), '123456789012345678');

    sent.length = 0;
    player.linkDiscordCommand({ id: 1, name: 'Alice' }, '!discord');
    check('linkDiscordCommand requires an argument', /Неверный ID Discord/.test(sent[0].msg), true);

    check('getAuthByDiscordId resolves the link back to the auth', db.getAuthByDiscordId('123456789012345678'), 'AUTH_ALICE');
    check('getAuthByDiscordId returns null for an unknown id', db.getAuthByDiscordId('999999999999999999'), null);

    check('getAuthBan returns null when nobody is banned', db.getAuthBan('AUTH_GHOST'), null);
    db.banAuth('AUTH_CHEATER', 'Cheater', 'aimbot');
    check('banAuth records the ban', db.getAuthBan('AUTH_CHEATER'), { auth: 'AUTH_CHEATER', playerName: 'Cheater', reason: 'aimbot' });
    check('getAuthBans lists it', db.getAuthBans(), [{ auth: 'AUTH_CHEATER', playerName: 'Cheater', reason: 'aimbot' }]);

    db.banAuth('AUTH_CHEATER', 'Cheater', 'updated reason');
    check('banAuth upserts rather than duplicating', db.getAuthBans().length, 1);
    check('banAuth upsert updates the reason', db.getAuthBan('AUTH_CHEATER').reason, 'updated reason');

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
}

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
        db,
        state: discordState,
        getAuthArray: () => discordAuthArray,
        getPrintPlayerStats: () => (stats) => `${stats.playerName}: ${stats.goals}G`,
        relayToRoom: (username, content) => relayed.push({ username, content }),
    };
    const msg = (authorId, content, bot = false) => ({ author: { id: authorId, bot, displayName: authorId }, content });

    await handleIncomingMessage(msg('OWNER_ID', '!say hello room'), deps);
    check('!say from the owner relays the text (prefix stripped) with the sender name', relayed, [{ username: 'OWNER_ID', content: 'hello room' }]);

    relayed.length = 0;
    await handleIncomingMessage(msg('SOME_OTHER_USER', '!say hello room'), deps);
    check('!say from a non-owner is ignored', relayed, []);

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
    const interaction = (userId, commandName, options = {}) => ({
        user: { id: userId, displayName: userId },
        commandName,
        options: { getString: (name) => options[name] ?? null },
    });

    relayed.length = 0;
    const ownerReply = await handleSlashCommand(interaction('OWNER_ID', 'say', { message: 'hi from slash' }), deps);
    check('/say from the owner relays the text with the sender name', relayed, [{ username: 'OWNER_ID', content: 'hi from slash' }]);
    check('/say confirms back to the owner, ephemerally', ownerReply, { content: 'Отправлено: hi from slash', ephemeral: true });

    relayed.length = 0;
    const strangerReply = await handleSlashCommand(interaction('SOME_OTHER_USER', 'say', { message: 'hi from slash' }), deps);
    check('/say from a non-owner is rejected, not relayed', relayed, []);
    check('/say rejection is ephemeral', strangerReply.ephemeral, true);

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

    check('!banauth with no auth shows usage', await handleIncomingMessage(msg('OWNER_ID', '!banauth'), authBanDeps), 'Использование: !banauth <auth> [причина]');
    check('!banauth from a non-owner is ignored', await handleIncomingMessage(msg('SOME_OTHER_USER', '!banauth AUTH_X cheating'), authBanDeps), null);

    kicked.length = 0;
    const banReply = await handleIncomingMessage(msg('OWNER_ID', '!banauth AUTH_X cheating'), authBanDeps);
    check('!banauth on a currently-online auth kicks them', kicked, [{ auth: 'AUTH_X', reason: 'cheating' }]);
    check('!banauth on a currently-online auth confirms by name', banReply, 'NewNick забанен по auth и выгнан из комнаты.');
    check('!banauth records the ban in the db', db.getAuthBan('AUTH_X'), { auth: 'AUTH_X', playerName: 'NewNick', reason: 'cheating' });

    kicked.length = 0;
    const banOfflineReply = await handleIncomingMessage(msg('OWNER_ID', '!banauth AUTH_OFFLINE griefing'), authBanDeps);
    check('!banauth on an offline auth does not attempt a kick', kicked, []);
    check('!banauth on an offline auth confirms without a kick', banOfflineReply, 'AUTH_OFFLINE забанен по auth (сейчас не в комнате).');

    check('!unbanauth with no auth shows usage', await handleIncomingMessage(msg('OWNER_ID', '!unbanauth'), authBanDeps), 'Использование: !unbanauth <auth>');
    check('!unbanauth from a non-owner is ignored', await handleIncomingMessage(msg('SOME_OTHER_USER', '!unbanauth AUTH_X'), authBanDeps), null);
    check('!unbanauth on an auth that was never banned reports so', await handleIncomingMessage(msg('OWNER_ID', '!unbanauth AUTH_GHOST'), authBanDeps), 'Этот auth не забанен.');
    check('!unbanauth clears an existing ban', await handleIncomingMessage(msg('OWNER_ID', '!unbanauth AUTH_X'), authBanDeps), 'NewNick разбанен по auth.');
    check('!unbanauth actually removed the ban from the db', db.getAuthBan('AUTH_X'), null);

    // Same commands again, as slash interactions this time.
    check('/players from the owner lists the room', await handleSlashCommand(interaction('OWNER_ID', 'players', {}), authBanDeps), { content: 'Игроки в комнате:\nNewNick [AUTH_X]', ephemeral: true });
    check('/players from a non-owner is rejected', (await handleSlashCommand(interaction('SOME_OTHER_USER', 'players', {}), authBanDeps)).ephemeral, true);

    kicked.length = 0;
    const slashBanReply = await handleSlashCommand(interaction('OWNER_ID', 'banauth', { auth: 'AUTH_X', reason: 'cheating' }), authBanDeps);
    check('/banauth on a currently-online auth kicks them', kicked, [{ auth: 'AUTH_X', reason: 'cheating' }]);
    check('/banauth on a currently-online auth confirms by name', slashBanReply, { content: 'NewNick забанен по auth и выгнан из комнаты.', ephemeral: true });

    check('/unbanauth clears the ban just placed', await handleSlashCommand(interaction('OWNER_ID', 'unbanauth', { auth: 'AUTH_X' }), authBanDeps), { content: 'NewNick разбанен по auth.', ephemeral: true });
    check('/unbanauth on an auth that was never banned reports so', await handleSlashCommand(interaction('OWNER_ID', 'unbanauth', { auth: 'AUTH_GHOST' }), authBanDeps), { content: 'Этот auth не забанен.', ephemeral: true });

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
{
    const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
    const db = createSqliteDatabase(':memory:');
    db.init();
    db.banAuth('AUTH_BANNED', 'Banned', 'aimbot');

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
    movement.onPlayerJoin({ id: 7, name: 'Banned', auth: 'AUTH_BANNED', conn: 'CONN1' });
    check('a banned auth is kicked immediately on join, even on a brand new connection', roomCalls, ['kickPlayer:7:Вы забанены: aimbot:false']);
    check('a banned auth never gets the join broadcast or welcome message', sent, []);

    roomCalls.length = 0;
    sent.length = 0;
    state.playersAll = [{ id: 8, name: 'Newbie' }];
    movement.onPlayerJoin({ id: 8, name: 'Newbie', auth: 'AUTH_NEW', conn: 'CONN2' });
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

    const { checkOverflowPassword } = require(path.join(CORE, 'overflowPassword'))({
        room: roomMock, state, maxPlayers: 12, passwordThreshold: 10,
        discordBot: discordBotMock, generateRoomPassword, rotateIntervalMs: 20,
    });

    checkOverflowPassword();
    check('below the threshold, nothing happens', roomCallsLocal, []);

    state.playersAll = new Array(11).fill(0).map((_, i) => ({ id: i }));
    checkOverflowPassword();
    check('crossing the threshold sets a fresh password on the room', roomCallsLocal, ['PW1']);
    check('crossing the threshold announces it to Discord', passwords, ['PW1']);
    check('the active password is also recorded on state.roomPassword', state.roomPassword, 'PW1');

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

// The movement.js leave broadcast fires from inside a 10ms setTimeout, the
// overflowPassword rotation check above waits 150ms for real interval
// ticks, and the balance.js stadium-switch checks chain four 20ms steps (up
// to 80ms) — give all of them time to run before tallying and exiting.
setTimeout(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}, 350);
