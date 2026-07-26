/*
 * Converts `var` to `const`/`let` wherever it is provably safe, across every
 * file under src/. `var` is function-scoped; `let`/`const` are block-scoped, so
 * a blind text replacement can break two real patterns in this codebase:
 *
 *   1. A `var` declared inside an `if`/`for`/`try` block and read again after
 *      that block ends (relying on hoisting to function scope).
 *   2. The SAME name re-declared as `var` in several disjoint sibling blocks
 *      (e.g. `for (var i = ...)` inside both branches of an if/else) — this is
 *      legal and harmless under `var`, and each occurrence is independently
 *      safe to convert, but only if references are correctly attributed to
 *      the occurrence that actually governs them at runtime.
 *
 * For every reference to a `var`-declared name, this resolves which of that
 * name's (possibly several) declarations in the same function governs it —
 * the same way the language would, by finding the innermost enclosing
 * declaration block. A reference with NO governing declaration in scope is a
 * real leak, and blocks conversion for every declaration of that name in that
 * function (safe default: skip rather than guess).
 *
 * A `for (var i = ...)` loop counter is additionally skipped if read inside a
 * closure created in the loop body — `let` gives each iteration a fresh
 * binding there, which would silently change behaviour, not just style.
 *
 * Usage: node tools/modernize-vars.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const SRC = path.join(__dirname, '..', 'src');
const APPLY = process.argv.includes('--apply');

function walkFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walkFiles(p);
        return e.name.endsWith('.js') ? [p] : [];
    });
}

const isFn = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
const isBlocky = (n) => n && (n.type === 'BlockStatement' || n.type === 'Program');

function collectPattern(p, out) {
    if (!p) return;
    if (p.type === 'Identifier') out.push(p);
    else if (p.type === 'ObjectPattern') p.properties.forEach((pr) => collectPattern(pr.value || pr.argument, out));
    else if (p.type === 'ArrayPattern') p.elements.forEach((e) => collectPattern(e, out));
    else if (p.type === 'AssignmentPattern') collectPattern(p.left, out);
    else if (p.type === 'RestElement') collectPattern(p.argument, out);
}

// Every `var`, `let` and `const` declared directly within `fnNode`'s own scope
// (i.e. not inside a nested function, which would have its own hoisted/scoped
// binding). Grouped by name, since the same name may be legally re-declared
// several times as `var`, and may ALSO have unrelated `let`/`const` bindings of
// the same name in disjoint sibling blocks (already correctly block-scoped —
// those must be recognised so their references aren't mistaken for orphaned
// references to the `var` this tool is trying to convert).
function ownDecls(fnRootForWalk, fnBoundaryNode) {
    const byName = new Map();
    walk.ancestor(fnRootForWalk, {
        VariableDeclaration(node, _state, ancestors) {
            for (let i = ancestors.length - 2; i >= 0; i--) {
                if (ancestors[i] === fnBoundaryNode) break;
                if (isFn(ancestors[i])) return; // owned by a nested function instead
            }
            let declBlock = null;
            for (let i = ancestors.length - 1; i >= 0; i--) {
                if (isBlocky(ancestors[i])) { declBlock = ancestors[i]; break; }
            }
            const parent = ancestors[ancestors.length - 2];
            const forStmt = parent && parent.type === 'ForStatement' && parent.init === node ? parent : null;
            for (const decl of node.declarations) {
                const names = [];
                collectPattern(decl.id, names);
                for (const n of names) {
                    if (!byName.has(n.name)) byName.set(n.name, []);
                    byName.get(n.name).push({ declBlock, forStmt, declNode: node, nameRange: n.range, isVar: node.kind === 'var' });
                }
            }
        },
    });
    return byName;
}

let totalConverted = 0;
let totalSkipped = 0;
const fileReports = [];
const fileEdits = new Map();

for (const file of walkFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    let ast;
    try {
        ast = acorn.parse(src, { ecmaVersion: 'latest', ranges: true, locations: true });
    } catch (e) {
        console.log(`SKIP ${file}: parse error: ${e.message}`);
        continue;
    }

    const scopes = [{ node: 'PROGRAM' }];
    walk.simple(ast, {
        FunctionDeclaration(n) { scopes.push({ node: n }); },
        FunctionExpression(n) { scopes.push({ node: n }); },
        ArrowFunctionExpression(n) { if (n.body.type === 'BlockStatement') scopes.push({ node: n }); },
    });

    const report = { file, converted: [], skipped: [] };
    const declEdits = []; // { declNode, kind }

    for (const scope of scopes) {
        const boundary = scope.node === 'PROGRAM' ? null : scope.node;
        const walkRoot = scope.node === 'PROGRAM' ? ast : scope.node.body;
        const allDeclsMap = ownDecls(walkRoot, boundary);

        // `var` may legally reuse a parameter's name (it just reassigns the
        // same binding); `let`/`const` cannot — redeclaring a parameter name
        // is a SyntaxError. Collect this scope's parameter names up front.
        const paramNames = new Set();
        if (boundary) {
            const names = [];
            for (const p of boundary.params) collectPattern(p, names);
            for (const n of names) paramNames.add(n.name);
        }

        for (const [name, allCandidates] of allDeclsMap) {
            const decls = allCandidates.filter((d) => d.isVar);
            if (decls.length === 0) continue;

            if (paramNames.has(name)) {
                for (const d of decls) {
                    report.skipped.push({ name, line: d.declNode.loc.start.line, reason: 'name collides with a function parameter — let/const cannot redeclare it' });
                    totalSkipped++;
                }
                continue;
            }

            // collect every reference to `name` within this scope, excluding
            // ones shadowed by a nested function's own declaration of it.
            const refs = [];
            walk.ancestor(walkRoot, {
                Identifier(node, _state, ancestors) {
                    if (node.name !== name) return;
                    if (allCandidates.some((d) => node.range[0] === d.nameRange[0] && node.range[1] === d.nameRange[1])) return;
                    const parent = ancestors[ancestors.length - 2];
                    if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
                    if (parent && parent.type === 'Property' && parent.key === node && !parent.shorthand) return;
                    for (let i = ancestors.length - 2; i >= 0; i--) {
                        const a = ancestors[i];
                        if (a === boundary || a === walkRoot) break;
                        if (isFn(a) && ownDecls(a, a).has(name)) return; // shadowed
                    }
                    refs.push({ node, ancestors: ancestors.slice() });
                },
                VariablePattern(node, _state, ancestors) {
                    if (node.name !== name) return;
                    if (allCandidates.some((d) => node.range[0] === d.nameRange[0] && node.range[1] === d.nameRange[1])) return;
                    for (let i = ancestors.length - 2; i >= 0; i--) {
                        const a = ancestors[i];
                        if (a === boundary || a === walkRoot) break;
                        if (isFn(a) && ownDecls(a, a).has(name)) return;
                    }
                    refs.push({ node, ancestors: ancestors.slice() });
                },
            });

            // Resolve which declaration governs each reference: the innermost
            // enclosing declBlock/forStmt among ALL of this name's declarations
            // (var, let and const together). A reference governed by a
            // let/const declaration belongs to that unrelated, already-scoped
            // binding — not to the var — so it's simply ignored here, not
            // treated as a leak.
            const refsByDecl = new Map(decls.map((d) => [d, []]));
            let ungoverned = false;
            for (const ref of refs) {
                let best = null;
                let bestDepth = -1;
                for (const d of allCandidates) {
                    const marker = d.forStmt || d.declBlock;
                    const depth = ref.ancestors.lastIndexOf(marker);
                    if (depth > bestDepth) { bestDepth = depth; best = d; }
                }
                if (best === null || bestDepth === -1) { ungoverned = true; break; }
                if (!best.isVar) continue; // governed by an unrelated let/const of the same name
                refsByDecl.get(best).push(ref);
            }

            for (const d of decls) {
                if (ungoverned) {
                    report.skipped.push({ name, line: d.declNode.loc.start.line, reason: 'a reference could not be attributed to any declaration (real leak, or dynamic scoping this tool can\'t prove safe)' });
                    totalSkipped++;
                    continue;
                }
                const myRefs = refsByDecl.get(d);
                const capturedInClosure = d.forStmt && myRefs.some((r) => {
                    const idx = r.ancestors.lastIndexOf(d.forStmt);
                    for (let i = idx + 1; i < r.ancestors.length; i++) if (isFn(r.ancestors[i])) return true;
                    return false;
                });
                if (capturedInClosure) {
                    report.skipped.push({ name, line: d.declNode.loc.start.line, reason: 'loop counter captured in a closure' });
                    totalSkipped++;
                    continue;
                }
                const reassigned = myRefs.some((r) => {
                    const parent = r.ancestors[r.ancestors.length - 2];
                    if (!parent) return false;
                    if (parent.type === 'AssignmentExpression' && parent.left === r.node) return true;
                    if (parent.type === 'UpdateExpression' && parent.argument === r.node) return true;
                    return false;
                });
                const kind = reassigned || d.forStmt ? 'let' : 'const';
                report.converted.push({ name, line: d.declNode.loc.start.line, kind });
                totalConverted++;
                declEdits.push({ declNode: d.declNode, kind });
            }
        }
    }

    const byDeclNode = new Map();
    for (const e of declEdits) {
        if (!byDeclNode.has(e.declNode)) byDeclNode.set(e.declNode, []);
        byDeclNode.get(e.declNode).push(e.kind);
    }
    const finalEdits = [];
    for (const [declNode, kinds] of byDeclNode) {
        if (kinds.length !== declNode.declarations.length) continue; // not every declarator agreed
        const kind = kinds.every((k) => k === kinds[0]) ? kinds[0] : 'let';
        finalEdits.push({ start: declNode.range[0], end: declNode.range[0] + 3, text: kind });
    }

    if (report.converted.length === 0 && report.skipped.length === 0) continue;
    fileReports.push(report);
    if (finalEdits.length) fileEdits.set(file, { src, edits: finalEdits });
}

for (const r of fileReports) {
    const rel = path.relative(path.join(__dirname, '..'), r.file).replace(/\\/g, '/');
    console.log(`\n${rel}  (${r.converted.length} convertible, ${r.skipped.length} skipped)`);
    for (const s of r.skipped) console.log(`    KEEP var  ${s.name} :${s.line}  — ${s.reason}`);
}

console.log(`\nTOTAL: ${totalConverted} convertible, ${totalSkipped} left as var for manual review.`);

if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write changes.');
    process.exit(0);
}

let filesWritten = 0;
for (const [file, { src, edits }] of fileEdits) {
    edits.sort((a, b) => b.start - a.start);
    let out = src;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    fs.writeFileSync(file, out, 'utf8');
    filesWritten++;
}
console.log(`\nwritten: ${filesWritten} files.`);
