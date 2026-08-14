/*
 * Same purpose as load-check.js, for src/browser/bffEntry.js instead of
 * entry.js — a genuinely separate bundle entry point (see
 * haxchill-second-room-plan project memory), so a wiring fault there (a
 * destructured name that doesn't exist on some dependency, a factory param
 * left unwired) is invisible to load-check.js, which never touches this
 * file at all. Deliberately a separate script rather than folded into
 * load-check.js: both mutate the same global.window/global.HBInit, and
 * keeping them as two independent processes means a fault in one can never
 * leave stale global state for the other to trip over.
 *
 * Usage: node tools/load-check-bff.js
 */
const path = require('path');

const calls = [];
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

// bffEntry.js reaches window.__secrets.bffToken/bffRoomPassword/testMode
// (see bffIndex.js's page.evaluate call) — different key names than the
// main room's own window.__secrets.token/roomPassword.
let capturedRoom = null;
global.HBInit = () => {
    capturedRoom = makeRoom();
    return capturedRoom;
};
const dbCalls = [];
global.window = {
    __secrets: { bffToken: '', bffRoomPassword: '', testMode: false },
    __dbCall: (method) => {
        dbCalls.push(method);
        if (method === 'getAdmins' || method === 'getVips') return Promise.resolve([]);
        if (method === 'getMasters') return Promise.resolve([]);
        // overflowPassword.js's init reads these two settings directly.
        if (method === 'getSetting') return Promise.resolve(null);
        return Promise.resolve(null);
    },
    __discordSend: () => {},
    addEventListener: () => {},
};
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

const { ready } = require(path.join(__dirname, '..', 'src', 'browser', 'bffEntry.js'));

ready.then((errorOrResult) => {
    if (errorOrResult instanceof Error) {
        console.log('BFF INITIALISATION FAILED:');
        console.log(errorOrResult.stack || errorOrResult);
        process.exit(1);
    }

    console.log('BFF initialised without throwing');
    console.log('room API used during init: ' + [...new Set(calls)].sort().join(', '));
    console.log('db bridge methods called during init: ' + [...new Set(dbCalls)].sort().join(', '));

    // Same structural check as load-check.js: a command wired everywhere
    // except the final commands table entry ends up with .function ===
    // undefined, which only throws later, inside onPlayerChat's try/catch
    // (safeEventHandlers.js), silently swallowed into a console.error.
    const commands = errorOrResult && errorOrResult.commands;
    if (!commands) {
        console.log('BFF INITIALISATION FAILED: main() did not return a commands object');
        process.exit(1);
    }
    const brokenCommands = Object.keys(commands).filter((name) => typeof commands[name].function !== 'function');
    if (brokenCommands.length > 0) {
        console.log('BFF INITIALISATION FAILED: these commands are registered but not wired to a real function:');
        console.log('  ' + brokenCommands.join(', '));
        process.exit(1);
    }
    console.log(`all ${Object.keys(commands).length} registered BFF commands have a real .function`);

    // Same real join/team-change/leave/chat round-trip as load-check.js,
    // through the REAL bffEntry.js wiring (not a mock) — this is the only
    // way to catch a destructuring name mismatch that yields `undefined`
    // silently at wiring time instead of throwing there.
    const { Team } = require(path.join(__dirname, '..', 'src', 'core', 'constants'));
    const wiringErrors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => {
        wiringErrors.push(args.map(String).join(' '));
        originalConsoleError(...args);
    };
    const fakePlayer = { id: 999001, name: 'BffLoadCheckProbe', auth: 'BFF_LOAD_CHECK_PROBE_AUTH', conn: 'BFF_LOAD_CHECK_PROBE_CONN', team: Team.SPECTATORS, admin: false };
    stubPlayers.push(fakePlayer);
    (async () => {
        await capturedRoom.onPlayerJoin(fakePlayer);
        fakePlayer.team = Team.RED;
        capturedRoom.onPlayerTeamChange(fakePlayer, null);
        fakePlayer.team = Team.SPECTATORS;
        capturedRoom.onPlayerTeamChange(fakePlayer, null);
        // Exercises onPlayerActivity's own wiring (added 2026-08-14 — real
        // bug fixed: it was never wired at all before, so a player's
        // inactivityTicks counter never reset on genuine movement/input,
        // eventually auto-kicking them regardless of how active they
        // actually were). Not exercising the actual reset here (gameState
        // is STOP in this stub, so the guard inside short-circuits) — this
        // just proves it's wired and doesn't throw.
        capturedRoom.onPlayerActivity(fakePlayer);
        // Exercises onPlayerChat's spam-guard/voteban/command-dispatch path
        // too — a plain chat message (not a command, not a vote), which is
        // exactly the path checkSpamFlood/handleVoteBanMessage/isMuted run
        // on every single message.
        capturedRoom.onPlayerChat(fakePlayer, 'hello from load-check');
        // Also exercises the bare 't' team-chat shortcut's own wiring
        // (teamChat, gated by its own separate mute check) — a real
        // destructuring mismatch there wouldn't throw synchronously, same
        // "is not a function" risk class this whole file exists to catch.
        capturedRoom.onPlayerChat(fakePlayer, 't hello from load-check');
        capturedRoom.onPlayerLeave(fakePlayer);
        await new Promise((resolve) => setTimeout(resolve, 0));
        console.error = originalConsoleError;

        const brokenWiring = wiringErrors.filter((msg) => /is not a function/i.test(msg));
        if (brokenWiring.length > 0) {
            console.log('BFF INITIALISATION FAILED: a real join/team-change/chat/leave round-trip hit an undefined dependency:');
            console.log('  ' + brokenWiring.join('\n  '));
            process.exit(1);
        }
        console.log('a real BFF join/team-change/chat/leave round-trip produced no "is not a function" wiring errors');
        process.exit(0);
    })();
});
