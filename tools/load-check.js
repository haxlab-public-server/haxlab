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
function makeRoom() {
    return new Proxy(
        {},
        {
            get(target, prop) {
                if (prop in target) return target[prop];
                return (...args) => {
                    calls.push(String(prop));
                    if (prop === 'getScores') return { red: 0, blue: 0, time: 0, timeLimit: 0 };
                    if (prop === 'getPlayerList') return [];
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
global.HBInit = () => makeRoom();
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
    process.exit(0);
});
