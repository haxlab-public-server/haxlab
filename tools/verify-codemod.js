/*
 * Cross-checks the codemod's reference resolution against a raw token count.
 * Any binding where the AST-resolved count is lower than the token count minus
 * its declaration is a potential missed rewrite — which would silently split a
 * variable into a state property plus an implicit global.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const FILE = path.join(__dirname, '..', 'src', 'index.js');
const src = fs.readFileSync(FILE, 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', ranges: true, locations: true });

let roomBody = null;
walk.simple(ast, {
    ArrowFunctionExpression(node) {
        if (!roomBody && node.body.type === 'BlockStatement' && node.body.body.length > 50) roomBody = node.body;
    },
});

const topVars = new Set();
for (const stmt of roomBody.body)
    if (stmt.type === 'VariableDeclaration')
        for (const d of stmt.declarations) if (d.id.type === 'Identifier') topVars.add(d.id.name);

const targets = new Set();
walk.simple(roomBody, {
    AssignmentExpression(n) { if (n.left.type === 'Identifier' && topVars.has(n.left.name)) targets.add(n.left.name); },
    UpdateExpression(n) { if (n.argument.type === 'Identifier' && topVars.has(n.argument.name)) targets.add(n.argument.name); },
});

// Every Identifier node bearing the name, regardless of scope reasoning.
const astOccurrences = new Map();
const bumpOcc = (n) => {
    if (targets.has(n.name)) astOccurrences.set(n.name, (astOccurrences.get(n.name) || 0) + 1);
};
// Assignment targets arrive as VariablePattern, so both visitors are needed.
walk.simple(ast, { Identifier: bumpOcc, VariablePattern: bumpOcc });

// Raw token count, ignoring occurrences that are object properties or in strings.
function tokenCount(name) {
    const re = new RegExp('(?<![\\w$.])' + name + '(?![\\w$])', 'g');
    return (src.match(re) || []).length;
}

console.log('binding'.padEnd(24) + 'tokens'.padStart(8) + 'astIds'.padStart(8) + '  status');
let suspicious = 0;
[...targets].sort().forEach((name) => {
    const t = tokenCount(name);
    const a = astOccurrences.get(name) || 0;
    const ok = a >= t;
    if (!ok) suspicious++;
    console.log(name.padEnd(24) + String(t).padStart(8) + String(a).padStart(8) + '  ' + (ok ? 'ok' : '<-- CHECK'));
});
console.log('\nsuspicious: ' + suspicious);
