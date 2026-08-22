/*
 * Finds unresolved identifiers in the extracted modules.
 *
 * When a function is moved into a factory, any binding it used but that was not
 * added to the factory's parameter list becomes a ReferenceError — but only when
 * that code path actually runs, possibly weeks later. This resolves every
 * identifier statically instead.
 *
 * Usage: node tools/check-module-deps.js
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const SRC = path.join(__dirname, '..', 'src');

const GLOBALS = new Set([
    'undefined', 'NaN', 'Infinity', 'globalThis', 'console', 'Math', 'JSON', 'Date', 'Object',
    'Array', 'String', 'Number', 'Boolean', 'Error', 'TypeError', 'RangeError', 'Set', 'Map',
    'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'RegExp', 'parseInt', 'parseFloat', 'isNaN',
    'isFinite', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'require',
    'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'fetch', 'FormData',
    'File', 'Blob', 'WebSocket', 'localStorage', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent',
    'arguments', 'Function', 'Intl', 'URL', 'URLSearchParams', 'AbortController', 'TextEncoder',
    'TextDecoder', 'queueMicrotask', 'atob', 'btoa',
    // Real browser globals — only ever referenced from src/browser/*, which
    // runs inside the actual room page (see src/browser/entry.js), not
    // under Node. HBInit is the page's own global (loaded before the
    // bundle is injected — see src/index.js); window/performance are
    // standard browser globals.
    'window', 'HBInit', 'performance',
]);

function collectPattern(p, out) {
    if (!p) return;
    if (p.type === 'Identifier') out.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((pr) => collectPattern(pr.value || pr.argument, out));
    else if (p.type === 'ArrayPattern') p.elements.forEach((e) => collectPattern(e, out));
    else if (p.type === 'AssignmentPattern') collectPattern(p.left, out);
    else if (p.type === 'RestElement') collectPattern(p.argument, out);
}

function walkFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walkFiles(p);
        return e.name.endsWith('.js') ? [p] : [];
    });
}

let problems = 0;
for (const file of walkFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', locations: true });

    // every binding declared anywhere in the file (coarse but sound for this check:
    // it can only hide a problem if a name is declared in some unrelated scope)
    const declared = new Set();
    walk.simple(ast, {
        VariableDeclarator(n) { collectPattern(n.id, declared); },
        FunctionDeclaration(n) { if (n.id) declared.add(n.id.name); n.params.forEach((p) => collectPattern(p, declared)); },
        FunctionExpression(n) { if (n.id) declared.add(n.id.name); n.params.forEach((p) => collectPattern(p, declared)); },
        ArrowFunctionExpression(n) { n.params.forEach((p) => collectPattern(p, declared)); },
        ClassDeclaration(n) { if (n.id) declared.add(n.id.name); },
        // a named class expression binds its own name inside its body
        ClassExpression(n) { if (n.id) declared.add(n.id.name); },
        CatchClause(n) { if (n.param) collectPattern(n.param, declared); },
        LabeledStatement(n) { declared.add(n.label.name); },
    });

    const unresolved = new Map();
    const record = (node, ancestors) => {
        const name = node.name;
        if (declared.has(name) || GLOBALS.has(name)) return;
        const parent = ancestors[ancestors.length - 2];
        if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
        if (parent && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return;
        if (parent && parent.type === 'BreakStatement') return;
        if (parent && parent.type === 'ContinueStatement') return;
        if (!unresolved.has(name)) unresolved.set(name, node.loc.start.line);
    };
    walk.ancestor(ast, { Identifier: record, VariablePattern: record });

    const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
    if (unresolved.size) {
        problems += unresolved.size;
        console.log(`${rel}:`);
        for (const [name, line] of unresolved) console.log(`    line ${line}: ${name}`);
    } else {
        console.log(`${rel}: ok`);
    }
}

console.log('\nunresolved identifiers: ' + problems);
process.exit(problems ? 1 : 0);
