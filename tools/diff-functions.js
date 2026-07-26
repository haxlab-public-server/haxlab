/*
 * Body-level diff against the upstream monolith — not just name existence.
 *
 * audit-parity.js only confirms every upstream function/variable NAME still
 * exists somewhere in src/. That is necessary but not sufficient: a function
 * could exist under the right name with altered logic. This extracts each
 * function's full source text on both sides, normalises away the KNOWN
 * mechanical rewrites (state.x, lazy accessors), and diffs what's left.
 *
 * Usage: node tools/diff-functions.js [path-to-upstream]
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const ORIG = process.argv[2] || path.join(ROOT, '..', 'haxball_bot_headless', 'HaxBot_public.js');

if (!fs.existsSync(ORIG)) {
    console.log('upstream reference not found: ' + ORIG);
    process.exit(2);
}

function walkFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walkFiles(p);
        return e.name.endsWith('.js') ? [p] : [];
    });
}

// Collect every FunctionDeclaration/ClassDeclaration/ClassExpression body in a
// source string, at any depth (factories nest what used to be top-level code
// one or two levels deeper) — first definition wins if a name repeats.
function collectDefs(text) {
    const ast = acorn.parse(text, { ecmaVersion: 'latest', ranges: true, locations: true });
    const defs = new Map();
    walk.simple(ast, {
        FunctionDeclaration(n) {
            if (n.id && !defs.has(n.id.name)) defs.set(n.id.name, text.slice(n.range[0], n.range[1]));
        },
        ClassDeclaration(n) {
            if (n.id && !defs.has(n.id.name)) defs.set(n.id.name, text.slice(n.range[0], n.range[1]));
        },
        ClassExpression(n) {
            if (n.id && !defs.has(n.id.name)) defs.set(n.id.name, text.slice(n.range[0], n.range[1]));
        },
    });
    return defs;
}

// Known mechanical rewrites introduced by this refactor. Anything left over
// after undoing these is a REAL divergence from upstream.
const LAZY_CALLS = {
    'getPlayersAll()': 'playersAll',
    'getTeamRed()': 'teamRed',
    'getTeamBlue()': 'teamBlue',
    'getTeamSpec()': 'teamSpec',
    'getCommands()': 'commands',
};

function normalize(text) {
    let t = text;
    for (const [call, name] of Object.entries(LAZY_CALLS)) t = t.split(call).join(name);
    // var -> let/const is a deliberate, verified-safe modernisation
    // (tools/modernize-vars.js); collapse all three to one token so it
    // doesn't register as a divergence from upstream.
    t = t.replace(/\b(?:var|let|const)\b/g, 'var');
    t = t.replace(/\bstate\./g, '');
    // collapse whitespace so indentation-only differences (moving code into a
    // factory adds 4 spaces per line) don't register as diffs
    t = t.replace(/\s+/g, ' ').trim();
    return t;
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return { pos: i, a: a.slice(Math.max(0, i - 20), i + 40), b: b.slice(Math.max(0, i - 20), i + 40) };
}

// Genuine, deliberate feature removals — not something this check should flag
// as a lost-code accident. Keep in sync with tools/audit-parity.js's list.
const INTENTIONALLY_REMOVED = new Set(['masterCommand']);

const origText = fs.readFileSync(ORIG, 'utf8');
const origDefs = collectDefs(origText);

const oursText = walkFiles(SRC).map((f) => fs.readFileSync(f, 'utf8')).join('\n;\n');
const oursDefs = collectDefs(oursText);

let identical = 0;
let differing = 0;
let missing = 0;
const diffs = [];

for (const [name, origBody] of origDefs) {
    if (INTENTIONALLY_REMOVED.has(name)) continue;
    const oursBody = oursDefs.get(name);
    if (oursBody === undefined) {
        missing++;
        diffs.push({ name, kind: 'MISSING' });
        continue;
    }
    const nOrig = normalize(origBody);
    const nOurs = normalize(oursBody);
    if (nOrig === nOurs) {
        identical++;
    } else {
        differing++;
        diffs.push({ name, kind: 'DIFFERS', ...firstDiff(nOrig, nOurs) });
    }
}

console.log(`upstream definitions: ${origDefs.size}`);
console.log(`identical (modulo state./lazy-accessor rewrites + whitespace): ${identical}`);
console.log(`differing: ${differing}`);
console.log(`missing: ${missing}`);

if (diffs.length) {
    console.log('\n--- details ---');
    for (const d of diffs) {
        if (d.kind === 'MISSING') {
            console.log(`\n${d.name}: MISSING from src/`);
        } else {
            console.log(`\n${d.name}: DIFFERS at normalized offset ${d.pos}`);
            console.log('  upstream: ...' + d.a + '...');
            console.log('  ours:     ...' + d.b + '...');
        }
    }
}

process.exit(missing || differing ? 1 : 0);
