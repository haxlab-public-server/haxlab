/*
 * Loads src/index.js end to end with haxball.js stubbed out.
 *
 * This catches initialisation-order faults — TDZ errors, undefined factory
 * arguments, functions wired before they exist — without touching the network
 * or opening a real room. No connection is made and no room is created.
 *
 * The haxball.js stub below invokes the room-scope callback SYNCHRONOUSLY inside
 * a try/catch, rather than returning a real Promise. This is deliberate: in this
 * sandboxed environment, process.on('unhandledRejection'/'uncaughtException')
 * were observed to print the error text and then let execution continue with
 * exit code 0 — i.e. they do not reliably fail the process here. Catching the
 * throw directly, synchronously, sidesteps that unreliability entirely.
 *
 * Usage: node tools/load-check.js
 */
const path = require('path');
const Module = require('module');

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

let initError = null;
const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'haxball.js') {
        return {
            default: () =>
                // A minimal thenable: calls the room-scope callback synchronously
                // and captures any throw, instead of a real (async, event-based) Promise.
                ({
                    then(onFulfilled) {
                        try {
                            onFulfilled(() => makeRoom());
                        } catch (err) {
                            initError = err;
                        }
                        return { catch() {} };
                    },
                }),
        };
    }
    if (request === '../api/database') {
        // Exercise the real database module, but against an in-memory database —
        // this check must never touch (or create) the production sqlite file.
        // backup() is overridden to a no-op too: index.js runs one at startup,
        // and VACUUM INTO writes to a real disk path regardless of the source
        // DB being in-memory, which would otherwise litter db/backups/ on
        // every `npm run check`.
        const { createSqliteDatabase } = require(path.join(__dirname, '..', 'db', 'sqlite'));
        return {
            createDatabaseApi: () => ({ ...createSqliteDatabase(':memory:'), backup: () => {} }),
        };
    }
    if (request === 'node:child_process') {
        // index.js forks a real, separate OS process for the Discord bot
        // (core/discordProcess.js) — this Module._load hook only patches
        // requires inside *this* process, so a real fork() would run that
        // module unstubbed: a real DB connection against the real sqlite
        // file, a real (if token-less) discord.js client, a real backup
        // timer. Stubbed out to a no-op object with the same shape index.js
        // calls (on/send/kill), so init is exercised without ever spawning
        // that process.
        return {
            fork: () => ({
                on: () => {},
                send: () => {},
                kill: () => {},
            }),
        };
    }
    return origLoad.apply(this, arguments);
};

require(path.join(__dirname, '..', 'src', 'index.js'));

if (initError) {
    console.log('INITIALISATION FAILED:');
    console.log(initError.stack || initError);
    process.exit(1);
}

console.log('initialised without throwing');
console.log('room API used during init: ' + [...new Set(calls)].sort().join(', '));
process.exit(0);
