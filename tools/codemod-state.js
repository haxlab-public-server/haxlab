/*
 * Moves every top-level binding that is reassigned somewhere in src/index.js onto
 * a single shared `state` object, so that extracted modules can read and write it
 * by reference instead of capturing a stale snapshot.
 *
 * Initialisers stay exactly where they were (`var x = init` becomes `state.x = init`)
 * so evaluation order is untouched; reads before initialisation still yield
 * undefined, same as with var hoisting.
 *
 * Usage: node tools/codemod-state.js          (dry run, prints a report)
 *        node tools/codemod-state.js --apply  (rewrites the file, keeps a .bak)
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const FILE = path.join(__dirname, '..', 'src', 'index.js');
const APPLY = process.argv.includes('--apply');
const src = fs.readFileSync(FILE, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', ranges: true, locations: true });

let roomBody = null;
walk.simple(ast, {
    ArrowFunctionExpression(node) {
        if (!roomBody && node.body.type === 'BlockStatement' && node.body.body.length > 50) roomBody = node.body;
    },
});
if (!roomBody) throw new Error('could not locate room scope');

// --- which top-level vars are reassigned anywhere? ---
const topVars = new Set();
const topFns = new Set();
for (const stmt of roomBody.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) topFns.add(stmt.id.name);
    if (stmt.type === 'VariableDeclaration')
        for (const d of stmt.declarations) if (d.id.type === 'Identifier') topVars.add(d.id.name);
}
const targets = new Set();
walk.simple(roomBody, {
    AssignmentExpression(n) {
        if (n.left.type === 'Identifier' && topVars.has(n.left.name)) targets.add(n.left.name);
    },
    UpdateExpression(n) {
        if (n.argument.type === 'Identifier' && topVars.has(n.argument.name)) targets.add(n.argument.name);
    },
});

// --- scope resolution: skip identifiers shadowed by a local binding ---
const localCache = new Map();
function collectPattern(p, out) {
    if (!p) return;
    if (p.type === 'Identifier') out.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((pr) => collectPattern(pr.value || pr.argument, out));
    else if (p.type === 'ArrayPattern') p.elements.forEach((e) => collectPattern(e, out));
    else if (p.type === 'AssignmentPattern') collectPattern(p.left, out);
    else if (p.type === 'RestElement') collectPattern(p.argument, out);
}
function localsOf(fnNode) {
    if (localCache.has(fnNode)) return localCache.get(fnNode);
    const names = new Set();
    (fnNode.params || []).forEach((p) => collectPattern(p, names));
    const body = fnNode.body;
    if (body && body.type === 'BlockStatement') {
        walk.simple(body, {
            VariableDeclarator(n) { collectPattern(n.id, names); },
            FunctionDeclaration(n) { if (n.id) names.add(n.id.name); },
            CatchClause(n) { if (n.param) collectPattern(n.param, names); },
        });
    }
    localCache.set(fnNode, names);
    return names;
}
const isFn = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

const edits = [];
const counts = new Map();
const bump = (n) => counts.set(n, (counts.get(n) || 0) + 1);

// 1) rewrite top-level declarations into assignments on `state`
const declaredHere = new Set();
for (const stmt of roomBody.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    const relevant = stmt.declarations.filter((d) => d.id.type === 'Identifier' && targets.has(d.id.name));
    if (relevant.length === 0) continue;
    if (relevant.length !== stmt.declarations.length)
        throw new Error('mixed declaration at line ' + stmt.loc.start.line + ' — needs manual handling');
    if (stmt.declarations.length !== 1)
        throw new Error('multi-declarator statement at line ' + stmt.loc.start.line + ' — needs manual handling');
    const d = stmt.declarations[0];
    declaredHere.add(d.id.name);
    if (d.init) {
        // Rewrite only the `var name` part. The initialiser may itself reference
        // other targets (e.g. triggerDistance = playerRadius + ballRadius), and
        // those are rewritten by the reference pass — replacing the whole
        // statement here would overlap with them.
        edits.push({ start: stmt.range[0], end: d.id.range[1], text: `state.${d.id.name}` });
    } else {
        edits.push({ start: stmt.range[0], end: stmt.range[1], text: `state.${d.id.name} = undefined;` });
    }
}

// 2) rewrite every reference.
// NOTE: acorn-walk visits assignment targets as VariablePattern, not Identifier,
// so both visitors are required — handling only Identifier silently skips every
// `x = ...` left-hand side.
function handleRef(node, _st, ancestors) {
    {
        if (!targets.has(node.name)) return;
        const parent = ancestors[ancestors.length - 2];
        if (!parent) return;
        // declarations are handled above
        if (parent.type === 'VariableDeclarator' && parent.id === node) return;
        // obj.prop / { key: ... } — not a reference to our binding
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
        if (parent.type === 'Property' && parent.key === node && !parent.shorthand) return;
        if (isFn(parent) && parent.params.includes(node)) return;
        if (parent.type === 'FunctionDeclaration' && parent.id === node) return;
        // shadowed by a local binding in any enclosing function?
        for (let i = ancestors.length - 2; i >= 0; i--) {
            const a = ancestors[i];
            if (a === roomBody) break;
            if (isFn(a) && localsOf(a).has(node.name)) return;
        }
        bump(node.name);
        if (parent.type === 'Property' && parent.shorthand) {
            edits.push({ start: node.range[0], end: node.range[1], text: `${node.name}: state.${node.name}` });
        } else {
            edits.push({ start: node.range[0], end: node.range[1], text: `state.${node.name}` });
        }
    }
}
walk.ancestor(roomBody, { Identifier: handleRef, VariablePattern: handleRef });

// 3) declare the state object at the very top of the room scope
const anchor = roomBody.range[0] + 1;
edits.push({
    start: anchor,
    end: anchor,
    text: '\n\n/* SHARED MUTABLE STATE */\n// Every binding here is reassigned at runtime; extracted modules must reach it\n// through this object rather than capturing the value at wiring time.\nconst state = {};\n',
});

const missing = [...targets].filter((n) => !declaredHere.has(n));
console.log('targets: ' + targets.size);
console.log('declarations rewritten: ' + declaredHere.size);
if (missing.length) console.log('WARNING — no top-level declaration found for: ' + missing.join(', '));
console.log('references rewritten: ' + [...counts.values()].reduce((a, b) => a + b, 0));
console.log('\nper-binding reference counts:');
[...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log('   ' + String(c).padStart(4) + '  ' + n));

if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write.');
    process.exit(0);
}

edits.sort((a, b) => b.start - a.start || b.end - a.end);
let out = src;
let prevStart = Infinity;
for (const e of edits) {
    if (e.end > prevStart) {
        const around = src.slice(Math.max(0, e.start - 60), e.end + 60);
        console.log('OVERLAP at ' + e.start + '-' + e.end + ' (prev start ' + prevStart + ')');
        console.log('  text: ' + JSON.stringify(e.text));
        console.log('  src:  ' + JSON.stringify(around));
        throw new Error('overlapping edits — aborting');
    }
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    prevStart = e.start;
}
fs.writeFileSync(FILE + '.bak', src, 'utf8');
fs.writeFileSync(FILE, out, 'utf8');
console.log('\nwritten. backup at src/index.js.bak');
