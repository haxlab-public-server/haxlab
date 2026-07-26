/*
 * Parity check against the upstream monolith.
 *
 * The refactor must never lose code BY ACCIDENT: every top-level function and
 * variable of HaxBot_public.js has to still exist somewhere in src/, either as
 * a declaration or as a property of the shared `state` object.
 *
 * INTENTIONAL_REMOVALS lists functionality deliberately dropped by explicit
 * request, so a real future accident isn't lost in the noise of an
 * expected-and-explained diff. Only add to it for a genuine feature removal,
 * never to silence a check that caught something real.
 *
 * Usage: node tools/audit-parity.js [path-to-upstream]
 */
const fs = require('fs');
const path = require('path');

const INTENTIONAL_REMOVALS = {
    masterCommand: '2026-07-25: the !claim command was removed — masters are now added directly to the database (scripts/add-master.js), never granted at runtime.',
    masterPassword: '2026-07-25: no longer needed once !claim (masterCommand) was removed.',
    hideClaimMessage: '2026-07-25: no longer needed once !claim (masterCommand) was removed.',
    roomWebhook: '2026-07-25: replaced by a real Discord bot (src/core/discord.js) — see discordLogChannelId in config.js.',
    gameWebhook: '2026-07-25: replaced by a real Discord bot (src/core/discord.js) — see discordReportChannelId in config.js.',
    updateAdmins: '2026-07-26: removed the auto-fill-admin-slots mechanic — the room works fine with nobody admin; onPlayerAdminChange (misc.js) now explicitly revokes any admin badge from a non-master/non-permanent-admin instead (e.g. HaxBall auto-granting it to the first player in an empty room).',
    maxAdmins: '2026-07-26: only used by updateAdmins, removed alongside it.',
};

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const ORIG =
    process.argv[2] ||
    path.join(ROOT, '..', 'haxball_bot_headless', 'HaxBot_public.js');

if (!fs.existsSync(ORIG)) {
    console.log('upstream reference not found: ' + ORIG);
    console.log('pass its path as an argument to run the parity check.');
    process.exit(2);
}

function walkFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walkFiles(p);
        return e.name.endsWith('.js') ? [p] : [];
    });
}

const orig = fs.readFileSync(ORIG, 'utf8');
const files = walkFiles(SRC);
const ours = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const names = (text, re) => {
    const out = new Set();
    let m;
    while ((m = re.exec(text))) out.add(m[1]);
    return out;
};

const origFns = names(orig, /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm);
const origVars = names(orig, /^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm);

const ourFns = names(ours, /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm);
const ourVars = names(ours, /^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm);
const stateProps = names(ours, /\bstate\.([A-Za-z_$][\w$]*)/g);
const bound = new Set();
for (const m of ours.matchAll(/^\s{0,8}([A-Za-z_$][\w$]*),\s*$/gm)) bound.add(m[1]); // destructured / factory params
const classes = names(ours, /^\s*(?:class|module\.exports\s*=\s*class)\s+([A-Za-z_$][\w$]*)/gm);

const known = (n) =>
    ourFns.has(n) || ourVars.has(n) || stateProps.has(n) || classes.has(n) || bound.has(n);

const missingFns = [...origFns].filter((n) => !known(n) && !INTENTIONAL_REMOVALS[n]);
const missingVars = [...origVars].filter((n) => !known(n) && !INTENTIONAL_REMOVALS[n]);
const removedFns = [...origFns].filter((n) => !known(n) && INTENTIONAL_REMOVALS[n]);
const removedVars = [...origVars].filter((n) => !known(n) && INTENTIONAL_REMOVALS[n]);

console.log('files scanned: ' + files.length);
console.log('upstream functions: ' + origFns.size + ', vars: ' + origVars.size);
console.log('MISSING functions (' + missingFns.length + '): ' + (missingFns.join(', ') || '-'));
console.log('MISSING vars (' + missingVars.length + '): ' + (missingVars.join(', ') || '-'));
if (removedFns.length || removedVars.length) {
    console.log('\nINTENTIONALLY REMOVED (not counted as missing):');
    for (const n of [...removedFns, ...removedVars]) console.log(`    ${n} — ${INTENTIONAL_REMOVALS[n]}`);
}

const total = files.reduce((a, f) => a + fs.readFileSync(f, 'utf8').split('\n').length, 0);
const idx = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8').split('\n').length;
console.log(`\nindex.js: ${idx} lines, whole src/: ${total} lines (upstream: ${orig.split('\n').length})`);

process.exit(missingFns.length || missingVars.length ? 1 : 0);
