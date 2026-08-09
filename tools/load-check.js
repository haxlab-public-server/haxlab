/*
 * Loads src/browser/entry.js end to end with browser globals stubbed out.
 *
 * This catches initialisation-order faults — TDZ errors, undefined factory
 * arguments, functions wired before they exist — without a real browser or
 * a real room. This is where that risk actually lives post-Puppeteer-
 * migration: src/index.js (the orchestrator) just launches a real browser
 * and injects the bundle, which isn't appropriate to do on every
 * `npm run check` — all the factory-wiring order this check exists to catch
 * now happens inside entry.js instead, which runs fine directly under Node
 * once HBInit/window are stubbed the same way a real page would provide them.
 *
 * Usage: node tools/load-check.js
 */
const path = require('path');

const calls = [];
// Shared with the synthetic onPlayerJoin/onPlayerTeamChange/onPlayerLeave
// round-trip below — getPlayerList() needs to actually reflect whatever
// that round-trip does (join, then a team move) for updateTeams() to see a
// consistent state.playersAll/teamRed/teamSpec, the same way a real
// room.setPlayerTeam() call would update what a real HaxBall room reports.
const stubPlayers = [];
function makeRoom() {
    return new Proxy(
        {},
        {
            get(target, prop) {
                if (prop in target) return target[prop];
                return (...args) => {
                    calls.push(String(prop));
                    if (prop === 'getScores') return { red: 0, blue: 0, time: 0, timeLimit: 0 };
                    if (prop === 'getPlayerList') return stubPlayers;
                    if (prop === 'getDiscProperties' || prop === 'getPlayerDiscProperties')
                        return { radius: 10, x: 0, y: 0, xspeed: 0, yspeed: 0 };
                    return undefined;
                };
            },
            set(target, prop, value) {
                target[prop] = value;
                return true;
            },
        }
    );
}

// entry.js only ever reaches two things outside the room object itself:
// HBInit (a real page global) and window.__secrets/__dbCall/__discordSend
// (the bridge — see dbBridgeClient.js/discordBridgeClient.js). Neither
// api/database.js nor node:child_process are touched here at all anymore —
// those live entirely in src/index.js (the orchestrator) now, not in the
// bundle this check exercises.
let capturedRoom = null;
global.HBInit = () => {
    capturedRoom = makeRoom();
    return capturedRoom;
};
const dbCalls = [];
global.window = {
    __secrets: { token: '', roomPassword: '' },
    __dbCall: (method) => {
        dbCalls.push(method);
        // getAdmins/getVips/getMasters are awaited directly during init
        // (state.adminList/vipList, masterList) — every other bridged
        // method only ever runs later, from an actual command/event.
        if (method === 'getAdmins' || method === 'getVips') return Promise.resolve([]);
        if (method === 'getMasters') return Promise.resolve([]);
        // getEquipped is chained straight into `.form`/`.avatar` reads
        // (economy.js's determineSideForm, applyTeamForms) — only reached
        // once the synthetic onPlayerTeamChange round-trip below actually
        // runs, but null would throw there the same way getAll*/
        // getTopPlayers would during init.
        if (method === 'getEquipped') return Promise.resolve({});
        // Every other getAll*/getTopPlayers call is immediately chained
        // (.reduce/.map/new Set()) during init — null would throw before
        // this check ever gets a chance to catch a real wiring fault.
        if (method.startsWith('getAll') || method === 'getTopPlayers') return Promise.resolve([]);
        return Promise.resolve(null);
    },
    __discordSend: () => {},
    // entry.js registers window.addEventListener('error'/'unhandledrejection')
    // as its browser-side crash reporter — never actually fired during a
    // normal init, just needs to exist so wiring it up doesn't throw.
    addEventListener: () => {},
};
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

const { ready } = require(path.join(__dirname, '..', 'src', 'browser', 'entry.js'));

ready.then((errorOrResult) => {
    if (errorOrResult instanceof Error) {
        console.log('INITIALISATION FAILED:');
        console.log(errorOrResult.stack || errorOrResult);
        process.exit(1);
    }

    console.log('initialised without throwing');
    console.log('room API used during init: ' + [...new Set(calls)].sort().join(', '));
    console.log('db bridge methods called during init: ' + [...new Set(dbCalls)].sort().join(', '));

    // Structural check the smoke tests can't do (they exercise individual
    // command functions in isolation, not the actual createCommands({...})
    // call in entry.js): a command can be fully wired everywhere else —
    // its own module, commands.js's factory params, the commands object
    // entry — and still end up with .function === undefined if it's simply
    // never threaded through that one final call. Calling an undefined
    // function throws inside onPlayerChat's try/catch (safeEventHandlers),
    // which silently falls through to the native chat bubble instead of
    // running the command OR showing the "command doesn't exist" error —
    // this is exactly how !hide shipped broken.
    const commands = errorOrResult && errorOrResult.commands;
    if (!commands) {
        console.log('INITIALISATION FAILED: main() did not return a commands object');
        process.exit(1);
    }
    const brokenCommands = Object.keys(commands).filter((name) => typeof commands[name].function !== 'function');
    if (brokenCommands.length > 0) {
        console.log('INITIALISATION FAILED: these commands are registered but not wired to a real function:');
        console.log('  ' + brokenCommands.join(', '));
        process.exit(1);
    }
    console.log(`all ${Object.keys(commands).length} registered commands have a real .function`);

    // Structural check the smoke tests ALSO can't do: they exercise
    // events/movement.js, events/activity.js etc. in isolation with
    // hand-written mocks for every dependency the factory declares — which
    // proves the module works IF wired correctly, but says nothing about
    // whether entry.js's own destructuring actually lines up with what the
    // dependency (e.g. core/betting.js) really exports. A plain name
    // mismatch there (destructuring a property that doesn't exist) yields
    // `undefined`, not a crash, at wiring time — the resulting "X is not a
    // function" only ever throws later, inside a real event, where
    // safeEventHandlers.js's try/catch silently swallows it into a
    // console.error and the rest of that handler's body (here,
    // handlePlayersTeamChange — which is what actually stops captain
    // picking at teamSize and starts the pre-match swap phase) never runs.
    // Reported live exactly this way: "8+ players forces everyone into
    // picking, matches start 5v5/7v7, captains can't substitute" — traced
    // to entry.js destructuring core/betting.js's `refundIfSubbedIn` as
    // `refundBetIfSubbedIn` with no rename, silently wiring `undefined`
    // into every single onPlayerTeamChange call. Firing a real join / team
    // change / leave round-trip here, through the REAL entry.js wiring
    // (not a mock), is the only way to catch that class of bug before it
    // reaches production.
    const { Team } = require(path.join(__dirname, '..', 'src', 'core', 'constants'));
    const wiringErrors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => {
        wiringErrors.push(args.map(String).join(' '));
        originalConsoleError(...args);
    };
    const fakePlayer = { id: 999001, name: 'LoadCheckProbe', auth: 'LOAD_CHECK_PROBE_AUTH', conn: 'LOAD_CHECK_PROBE_CONN', team: Team.SPECTATORS, admin: false };
    stubPlayers.push(fakePlayer);
    (async () => {
        await capturedRoom.onPlayerJoin(fakePlayer);
        fakePlayer.team = Team.RED;
        capturedRoom.onPlayerTeamChange(fakePlayer, null);
        fakePlayer.team = Team.SPECTATORS;
        capturedRoom.onPlayerTeamChange(fakePlayer, null);
        capturedRoom.onPlayerLeave(fakePlayer);
        // Every step above is synchronous or fire-and-forget (no handler
        // here awaits anything the caller can observe) — one microtask
        // tick is enough for every .catch()-chained async call any of them
        // kicked off (refundBetIfSubbedIn, applyTeamForms, etc.) to have
        // actually run and reported any wiring error.
        await new Promise((resolve) => setTimeout(resolve, 0));
        console.error = originalConsoleError;

        const brokenWiring = wiringErrors.filter((msg) => /is not a function/i.test(msg));
        if (brokenWiring.length > 0) {
            console.log('INITIALISATION FAILED: a real join/team-change/leave round-trip hit an undefined dependency:');
            console.log('  ' + brokenWiring.join('\n  '));
            process.exit(1);
        }
        console.log('a real join/team-change/leave round-trip produced no "is not a function" wiring errors');
        process.exit(0);
    })();
});
