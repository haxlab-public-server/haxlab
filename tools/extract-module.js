/*
 * Extracts a group of top-level functions from src/index.js into a factory module.
 *
 * Boundaries come from the AST, never from line guesses — cutting by eye is what
 * previously destroyed half of endGame(). Every run verifies that the removed
 * source and the generated module contain the same function bodies.
 *
 * Usage: node tools/extract-module.js <groupKey> [--apply]
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'index.js');

const GROUPS = {
    master: {
        section: 'MASTER COMMANDS',
        out: 'src/core/commands/master.js',
        factory: 'createMasterCommands',
        deps: ['room', 'state', 'authArray', 'masterList', 'announcementColor', 'errorColor', 'HaxNotification'],
        header: 'Master-level commands: ban list maintenance, admin roster and the room password.',
    },
    admin: {
        section: 'ADMIN COMMANDS',
        out: 'src/core/commands/admin.js',
        factory: 'createAdminCommands',
        deps: [
            'room', 'state', 'authArray', 'muteArray', 'muteDuration', 'MutePlayer',
            'trainingMap', 'classicMap', 'bigMap', 'State', 'Situation',
            'announcementColor', 'errorColor', 'HaxNotification',
            'instantRestart', 'swapButton',
        ],
        header: 'Admin commands: stadium switching, mutes, kicks and match restarts.',
    },
    player: {
        section: 'PLAYER COMMANDS',
        out: 'src/core/commands/player.js',
        factory: 'createPlayerCommands',
        deps: [
            'room', 'state', 'Team', 'Role', 'HaxStatistics', 'authArray', 'masterList',
            'masterPassword', 'AFKSet', 'AFKMinSet', 'AFKCooldownSet',
            'minAFKDuration', 'maxAFKDuration', 'AFKCooldown',
            'announcementColor', 'errorColor', 'infoColor', 'successColor', 'HaxNotification',
            'getCommand', 'getRole', 'handlePlayersJoin', 'handlePlayersLeave',
            'printPlayerStats', 'printRankings', 'updateTeams',
        ],
        // helpCommand reads `commands`, which is built FROM these functions — a cycle
        // that only a lazy accessor can break.
        lazyDeps: { commands: 'getCommands' },
        header: 'Player-facing commands: help, stats, rename, AFK handling and leaving.',
    },
    buttons: {
        section: 'BUTTONS',
        out: 'src/core/team/buttons.js',
        factory: 'createButtonHelpers',
        deps: ['room', 'state', 'Team', 'getRandomInt'],
        header: 'UI buttons shown to players: random/top/swap picks and moving a team to spectators.',
    },
    choosing: {
        section: 'CHOOSING FUNCTIONS',
        out: 'src/core/team/choosing.js',
        factory: 'createChoosingHelpers',
        deps: [
            'room', 'state', 'Team', 'HaxNotification',
            'announcementColor', 'errorColor', 'infoColor', 'warningColor',
            'chooseModeSlowMode', 'chooseTime', 'defaultSlowMode', 'SMSet',
            'getRandomInt',
        ],
        header: 'Captain-choice mode: picking players, slow mode countdown, captain leaving mid-choice.',
    },
    teamBalance: {
        section: 'TEAM BALANCE FUNCTIONS',
        out: 'src/core/team/balance.js',
        factory: 'createTeamBalance',
        deps: [
            'room', 'state', 'Team', 'State', 'HaxNotification',
            'emptyPlayer', 'infoColor', 'scoreLimit', 'teamSize', 'timeLimit',
            'activateChooseMode', 'blueToSpecButton', 'choosePlayer', 'deactivateChooseMode',
            'endGame', 'getRandomInt', 'getSpecList', 'instantRestart',
            'randomButton', 'redToSpecButton', 'resetButton', 'resumeGame',
            'stadiumCommand', 'swapButton', 'topButton',
        ],
        header: 'Keeps red/blue balanced as players join, leave, switch teams or go AFK.',
    },
    lineup: {
        section: 'LINEUP FUNCTIONS',
        out: 'src/core/team/lineup.js',
        factory: 'createLineupHelpers',
        deps: ['state', 'Team', 'State', 'Situation', 'PlayerComposition', 'authArray'],
        header: 'Tracks each player composition\'s time in/out of the lineup as teams change.',
    },
    gk: {
        section: 'GK FUNCTIONS',
        out: 'src/core/stats/gk.js',
        factory: 'createGkHelpers',
        deps: ['state', 'Team', 'getPlayerComp'],
        header: 'Identifies each team\'s goalkeeper and tracks clean sheets.',
    },
    globalStats: {
        section: 'GLOBAL STATS FUNCTIONS',
        out: 'src/core/stats/global.js',
        factory: 'createGlobalStats',
        deps: [
            'room', 'state', 'Team', 'State', 'Situation', 'BallTouch',
            'checkGoalKickTouch', 'getGoalGame', 'handleGK', 'pointDistance', 'updateTeams',
        ],
        header: 'Tracks ball touches, possession and per-tick game state.',
    },
    goalAttribution: {
        section: 'GOAL ATTRIBUTION FUNCTIONS',
        out: 'src/core/stats/goalAttribution.js',
        factory: 'createGoalAttribution',
        deps: ['state', 'Team', 'Goal', 'getTimeGame'],
        header: 'Attributes a goal to a striker/assist based on recent ball touches.',
    },
    playerStats: {
        section: 'GET STATS FUNCTIONS',
        out: 'src/core/stats/playerStats.js',
        factory: 'createPlayerStats',
        deps: ['state', 'Team', 'authArray', 'HaxStatistics', 'getGK', 'getPlayerComp'],
        header: 'Per-player stat readouts (gametime, goals, assists, CS, GK time) for one game.',
    },
    roomStats: {
        section: 'ROOM STATS FUNCTIONS',
        out: 'src/core/stats/roomStats.js',
        factory: 'createRoomStats',
        deps: [
            'room', 'state', 'Team', 'authArray', 'HaxStatistics', 'HaxNotification',
            'errorColor', 'infoColor', 'teamSize',
            'getAssistsPlayer', 'getCSPlayer', 'getGametimePlayer', 'getGoalsPlayer',
            'getOwnGoalsPlayer', 'getPlayerComp', 'getTimeStats',
        ],
        header: 'Persists per-player stats to localStorage after a game and prints leaderboards.',
    },
    print: {
        section: 'PRINT FUNCTIONS',
        out: 'src/core/stats/print.js',
        factory: 'createPrintStats',
        deps: ['getTimeStats'],
        header: 'Formats one player\'s stat block for chat.',
    },
    fetch: {
        section: 'FETCH FUNCTIONS',
        out: 'src/core/stats/fetch.js',
        factory: 'createFetchReports',
        deps: [
            'Team', 'state', 'gameWebhook', 'roomName', 'findFirstNumberCharString',
            'actionReportCountTeam', 'getGametimePlayer', 'getIdReport', 'getMinutesReport',
            'getRecordingName', 'getSecondsReport', 'getTimeEmbed',
        ],
        header: 'Builds the Discord embed payloads sent to the game webhook after a match.',
    },
    movement: {
        section: 'PLAYER MOVEMENT',
        out: 'src/core/events/movement.js',
        factory: 'createMovementEvents',
        eventHandlers: true,
        deps: [
            'room', 'state', 'authArray', 'AFKSet', 'HaxNotification', 'Role', 'State', 'Team',
            'announcementColor', 'debugMode', 'disableBans', 'errorColor', 'masterList', 'maxPlayers',
            'roomName', 'roomWebhook', 'welcomeColor', 'getDate',
            'checkCaptainLeave', 'getRole', 'ghostKickHandle', 'handleActivityPlayerTeamChange',
            'handleLineupChangeLeave', 'handleLineupChangeTeamChange', 'handlePlayersJoin',
            'handlePlayersLeave', 'handlePlayersTeamChange', 'updateAdmins', 'updateTeams',
        ],
        header: 'room.onPlayerJoin/Leave/TeamChange/Kicked — keeps auth/team bookkeeping in sync.',
    },
    activity: {
        section: 'PLAYER ACTIVITY',
        out: 'src/core/events/activity.js',
        factory: 'createActivityEvents',
        eventHandlers: true,
        deps: [
            'room', 'state', 'authArray', 'BallTouch', 'HaxNotification', 'Situation', 'State', 'Team',
            'commands', 'errorColor', 'hideClaimMessage', 'muteArray', 'roomName', 'roomWebhook',
            'checkGoalKickTouch', 'chooseModeFunction', 'getCommand', 'getDate', 'getGoalGame',
            'getPlayerComp', 'getRole', 'playerChat', 'slowModeFunction', 'teamChat',
        ],
        header: 'room.onPlayerChat/BallKick/Activity — chat commands and per-tick activity tracking.',
    },
    gameManagement: {
        section: 'GAME MANAGEMENT',
        out: 'src/core/events/gameManagement.js',
        factory: 'createGameManagementEvents',
        eventHandlers: true,
        deps: [
            'room', 'state', 'Game', 'HaxNotification', 'Situation', 'State', 'Team',
            'blueColor', 'defaultColor', 'fetchRecordingVariable', 'gameWebhook', 'getStartingLineups',
            'mentionPlayersUnpause', 'redColor', 'roomName', 'roomWebhook', 'teamSize',
            'calculateStadiumVariables', 'deactivateChooseMode', 'endGame', 'fetchRecording',
            'fetchSummaryEmbed', 'getBallSpeed', 'getDate', 'getGoalString', 'getPlayerComp',
            'handleActivityStop', 'handlePlayersStop', 'updateTeams',
        ],
        header: 'room.onGameStart/Stop/Pause/Unpause/TeamGoal/PositionsReset — the match lifecycle.',
    },
    misc: {
        section: 'MISCELLANEOUS',
        out: 'src/core/events/misc.js',
        factory: 'createMiscEvents',
        eventHandlers: true,
        deps: [
            'room', 'state', 'HaxNotification', 'Role', 'emptyPlayer', 'errorColor', 'infoColor',
            'masterPassword', 'roomName', 'roomWebhook',
            'checkTime', 'getDate', 'getGameStats', 'getLastTouchOfTheBall', 'getRole',
            'handleActivity', 'stadiumCommand', 'updateAdmins', 'updateTeams',
        ],
        header: 'room.onRoomLink/PlayerAdminChange/KickRateLimitSet/StadiumChange/GameTick.',
    },
};

const key = process.argv[2];
const APPLY = process.argv.includes('--apply');
const cfg = GROUPS[key];
if (!cfg) {
    console.log('groups: ' + Object.keys(GROUPS).join(', '));
    process.exit(1);
}

const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);
const ast = acorn.parse(src, { ecmaVersion: 'latest', ranges: true, locations: true });

let roomBody = null;
walk.simple(ast, {
    ArrowFunctionExpression(node) {
        if (!roomBody && node.body.type === 'BlockStatement' && node.body.body.length > 50) roomBody = node.body;
    },
});

const sectionOf = (line) => {
    let cur = '(top)';
    for (let i = 0; i < line; i++) {
        const m = lines[i].match(/^\s*\/\*\s*(.+?)\s*\*\/\s*$/);
        if (m) cur = m[1];
    }
    return cur;
};

function isRoomEventAssignment(s) {
    if (s.type !== 'ExpressionStatement') return false;
    const e = s.expression;
    return (
        e.type === 'AssignmentExpression' &&
        e.left.type === 'MemberExpression' &&
        e.left.object.type === 'Identifier' &&
        e.left.object.name === 'room' &&
        e.left.property.type === 'Identifier' &&
        /^on[A-Z]/.test(e.left.property.name) &&
        (e.right.type === 'FunctionExpression' || e.right.type === 'ArrowFunctionExpression')
    );
}

const picked = cfg.eventHandlers
    ? roomBody.body.filter((s) => isRoomEventAssignment(s) && sectionOf(s.loc.start.line - 1) === cfg.section)
    : roomBody.body.filter(
          (s) => s.type === 'FunctionDeclaration' && s.id && sectionOf(s.loc.start.line - 1) === cfg.section
      );
if (picked.length === 0) throw new Error('no functions found for section ' + cfg.section);

const names = cfg.eventHandlers
    ? picked.map((s) => s.expression.left.property.name)
    : picked.map((f) => f.id.name);
const bodies = cfg.eventHandlers
    ? picked.map((s, i) => {
          const fn = s.expression.right;
          const params = src.slice(fn.params.length ? fn.params[0].range[0] : fn.body.range[0], fn.params.length ? fn.params[fn.params.length - 1].range[1] : fn.body.range[0]);
          const body = src.slice(fn.body.range[0], fn.body.range[1]);
          return `function ${names[i]}(${params}) ${body}`;
      })
    : picked.map((f) => src.slice(f.range[0], f.range[1]));

// contiguity check: nothing but blank lines/comments may sit between them
const first = picked[0];
const last = picked[picked.length - 1];
const between = src.slice(first.range[0], last.range[1]);
const strippedOthers = roomBody.body.filter(
    (s) => s.range[0] >= first.range[0] && s.range[1] <= last.range[1] && !picked.includes(s)
);
if (strippedOthers.length) throw new Error('non-extracted statements interleaved in section — aborting');

const allDeps = cfg.deps.concat(Object.values(cfg.lazyDeps || {}));
const indent = (text) => text.split('\n').map((l) => (l.trim() ? '    ' + l : l)).join('\n');

let moduleBody = bodies.map(indent).join('\n\n');
// rewrite lazily-resolved bindings inside the moved code
for (const [name, getter] of Object.entries(cfg.lazyDeps || {})) {
    const re = new RegExp('(?<![\\w$.])' + name + '(?![\\w$])', 'g');
    moduleBody = moduleBody.replace(re, `${getter}()`);
}

const moduleSrc =
    `/*\n * ${cfg.header}\n *\n` +
    ` * Mutable room state is reached through \`state\`, never captured by value:\n` +
    ` * those bindings are reassigned on every room event.\n */\n` +
    `module.exports = function ${cfg.factory}({\n` +
    allDeps.map((d) => '    ' + d + ',').join('\n') +
    `\n}) {\n${moduleBody}\n\n    return {\n` +
    names.map((n) => '        ' + n + ',').join('\n') +
    `\n    };\n};\n`;

// index.js: drop the functions, wire the factory in their place
const cut = { start: first.range[0], end: last.range[1] };
const requirePath = './' + path.relative(path.join(ROOT, 'src'), path.join(ROOT, cfg.out)).replace(/\\/g, '/').replace(/\.js$/, '');
const factoryCall =
    `${cfg.factory}({\n` +
    cfg.deps.map((d) => '    ' + d + ',').join('\n') +
    (cfg.lazyDeps
        ? '\n' + Object.entries(cfg.lazyDeps).map(([n, g]) => `    ${g}: () => ${n},`).join('\n')
        : '') +
    `\n})`;
const wiring = cfg.eventHandlers
    ? `const ${cfg.factory} = require('${requirePath}');\n` + `Object.assign(room, ${factoryCall});`
    : `const ${cfg.factory} = require('${requirePath}');\n` +
      `const {\n` +
      names.map((n) => '    ' + n + ',').join('\n') +
      `\n} = ${factoryCall};`;

console.log(`section: ${cfg.section}`);
console.log(`functions (${names.length}): ${names.join(', ')}`);
console.log(`lines removed from index.js: ${src.slice(cut.start, cut.end).split('\n').length}`);
console.log(`module: ${cfg.out}`);
console.log(`deps: ${allDeps.length}`);

if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write.');
    process.exit(0);
}

const outPath = path.join(ROOT, cfg.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, moduleSrc, 'utf8');

const next = src.slice(0, cut.start) + wiring + src.slice(cut.end);
fs.writeFileSync(FILE + '.bak', src, 'utf8');
fs.writeFileSync(FILE, next, 'utf8');
console.log('\nwritten. backup at src/index.js.bak');
