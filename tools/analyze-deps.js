/*
 * Static dependency analysis for the src/index.js refactor.
 *
 * For a group of top-level functions it reports which outer bindings they read,
 * which they REASSIGN (those must live in a shared state object to survive being
 * moved into a module) and which they only mutate in place (safe to pass by
 * reference). Run: node tools/analyze-deps.js [groupName]
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const FILE = path.join(__dirname, '..', 'src', 'index.js');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);
const ast = acorn.parse(src, { ecmaVersion: 'latest', locations: true });

// Everything lives inside HaxballJS(...).then((HBInit) => { ... }) — find that body.
let roomBody = null;
walk.simple(ast, {
    ArrowFunctionExpression(node) {
        if (!roomBody && node.body.type === 'BlockStatement' && node.body.body.length > 50) {
            roomBody = node.body;
        }
    },
});
if (!roomBody) throw new Error('could not locate room scope');

// Section comments drive the grouping, mirroring the file's own layout.
const sectionOf = new Map();
{
    let current = '(top)';
    const secRe = /^\s*\/\*\s*(.+?)\s*\*\/\s*$/;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(secRe);
        if (m) current = m[1];
        sectionOf.set(i + 1, current);
    }
}

const topDecls = new Map(); // name -> 'var' | 'function'
for (const stmt of roomBody.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) topDecls.set(stmt.id.name, 'function');
    if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations) {
            if (d.id.type === 'Identifier') topDecls.set(d.id.name, 'var');
            if (d.id.type === 'ObjectPattern')
                for (const p of d.id.properties)
                    if (p.value && p.value.type === 'Identifier') topDecls.set(p.value.name, 'var');
        }
    }
}

const fns = roomBody.body
    .filter((s) => s.type === 'FunctionDeclaration' && s.id)
    .map((s) => ({ name: s.id.name, node: s, section: sectionOf.get(s.loc.start.line) }));

// event handlers are wired as `room.onXxx = function (...) { ... };`, not as
// named FunctionDeclarations — recognise that shape too.
for (const s of roomBody.body) {
    if (s.type !== 'ExpressionStatement') continue;
    const e = s.expression;
    if (
        e.type === 'AssignmentExpression' &&
        e.left.type === 'MemberExpression' &&
        e.left.object.type === 'Identifier' &&
        e.left.object.name === 'room' &&
        e.left.property.type === 'Identifier' &&
        /^on[A-Z]/.test(e.left.property.name) &&
        (e.right.type === 'FunctionExpression' || e.right.type === 'ArrowFunctionExpression')
    ) {
        fns.push({ name: e.left.property.name, node: e.right, section: sectionOf.get(s.loc.start.line) });
    }
}

function localNames(fnNode) {
    const names = new Set();
    for (const p of fnNode.params) collectPattern(p, names);
    walk.simple(fnNode.body, {
        VariableDeclarator(n) { collectPattern(n.id, names); },
        FunctionDeclaration(n) { if (n.id) names.add(n.id.name); n.params.forEach((p) => collectPattern(p, names)); },
        FunctionExpression(n) { n.params.forEach((p) => collectPattern(p, names)); },
        ArrowFunctionExpression(n) { n.params.forEach((p) => collectPattern(p, names)); },
        CatchClause(n) { if (n.param) collectPattern(n.param, names); },
    });
    return names;
}
function collectPattern(p, out) {
    if (!p) return;
    if (p.type === 'Identifier') out.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((pr) => collectPattern(pr.value || pr.argument, out));
    else if (p.type === 'ArrayPattern') p.elements.forEach((e) => collectPattern(e, out));
    else if (p.type === 'AssignmentPattern') collectPattern(p.left, out);
    else if (p.type === 'RestElement') collectPattern(p.argument, out);
}

function analyze(fnNode) {
    const local = localNames(fnNode);
    const read = new Set();
    const reassigned = new Set();
    const memberMutated = new Set();
    const called = new Set();
    const isOuter = (n) => topDecls.has(n) && !local.has(n);

    walk.ancestor(fnNode.body, {
        Identifier(node, state, ancestors) {
            const name = node.name;
            if (!isOuter(name)) return;
            const parent = ancestors[ancestors.length - 2];
            if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
            if (parent && parent.type === 'Property' && parent.key === node && !parent.computed) return;
            read.add(name);
        },
        AssignmentExpression(node) {
            if (node.left.type === 'Identifier' && isOuter(node.left.name)) reassigned.add(node.left.name);
            let base = node.left;
            while (base && base.type === 'MemberExpression') base = base.object;
            if (base && base.type === 'Identifier' && isOuter(base.name) && node.left.type === 'MemberExpression')
                memberMutated.add(base.name);
        },
        UpdateExpression(node) {
            if (node.argument.type === 'Identifier' && isOuter(node.argument.name)) reassigned.add(node.argument.name);
            let base = node.argument;
            while (base && base.type === 'MemberExpression') base = base.object;
            if (base && base.type === 'Identifier' && isOuter(base.name) && node.argument.type === 'MemberExpression')
                memberMutated.add(base.name);
        },
        CallExpression(node) {
            const c = node.callee;
            if (c.type === 'Identifier' && isOuter(c.name)) called.add(c.name);
            if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && isOuter(c.object.name) &&
                c.property.type === 'Identifier' && /^(push|pop|shift|unshift|splice|sort|fill|add|delete|clear|set)$/.test(c.property.name))
                memberMutated.add(c.object.name);
        },
    });

    for (const n of called) read.delete(n);
    return { read, reassigned, memberMutated, called };
}

// Which top-level bindings are reassigned ANYWHERE in the room scope? Those are
// exactly the ones a extracted module may not capture by value.
if (process.argv[2] === '--global') {
    const reassignedAnywhere = new Set();
    walk.simple(roomBody, {
        AssignmentExpression(node) {
            if (node.left.type === 'Identifier' && topDecls.has(node.left.name))
                reassignedAnywhere.add(node.left.name);
        },
        UpdateExpression(node) {
            if (node.argument.type === 'Identifier' && topDecls.has(node.argument.name))
                reassignedAnywhere.add(node.argument.name);
        },
    });
    const stable = [...topDecls.keys()].filter((n) => !reassignedAnywhere.has(n) && topDecls.get(n) === 'var');
    console.log('REASSIGNED SOMEWHERE — must be shared by reference [' + reassignedAnywhere.size + ']:');
    console.log('   ' + [...reassignedAnywhere].sort().join(', '));
    console.log('\nNEVER REASSIGNED vars — safe to pass by value/reference [' + stable.length + ']:');
    console.log('   ' + stable.sort().join(', '));
    process.exit(0);
}

const targetGroup = process.argv[2];
const groups = new Map();
for (const f of fns) {
    if (targetGroup && f.section !== targetGroup) continue;
    if (!groups.has(f.section)) groups.set(f.section, []);
    groups.get(f.section).push(f);
}

const union = (sets) => sets.reduce((a, s) => { s.forEach((v) => a.add(v)); return a; }, new Set());

for (const [section, members] of groups) {
    const results = members.map((m) => ({ name: m.name, ...analyze(m.node) }));
    const reassigned = union(results.map((r) => r.reassigned));
    const memberMutated = union(results.map((r) => r.memberMutated));
    const called = union(results.map((r) => r.called));
    const read = union(results.map((r) => r.read));
    for (const n of reassigned) read.delete(n);
    for (const n of memberMutated) read.delete(n);

    console.log('\n=== ' + section + ' (' + members.length + ' functions) ===');
    console.log('REASSIGNED (must live in shared state) [' + reassigned.size + ']:');
    console.log('   ' + ([...reassigned].sort().join(', ') || '-'));
    console.log('MUTATED IN PLACE (safe by reference) [' + memberMutated.size + ']:');
    console.log('   ' + ([...memberMutated].sort().join(', ') || '-'));
    console.log('READ ONLY [' + read.size + ']:');
    console.log('   ' + ([...read].sort().join(', ') || '-'));
    console.log('CALLS other top-level functions [' + called.size + ']:');
    console.log('   ' + ([...called].sort().join(', ') || '-'));
}
