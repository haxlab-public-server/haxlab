/*
 * Runs every safety check for the modularisation work, in order of cost.
 * Usage: npm run check
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const node = process.execPath;

function walkFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walkFiles(p);
        return e.name.endsWith('.js') ? [p] : [];
    });
}

const steps = [];
let failed = 0;

function step(name, fn) {
    process.stdout.write('› ' + name + ' ... ');
    try {
        const out = fn();
        console.log('ok');
        steps.push({ name, ok: true, out });
    } catch (err) {
        console.log('FAILED');
        const out = (err.stdout || '') + (err.stderr || '') || String(err.message);
        console.log(String(out).trim().split('\n').map((l) => '    ' + l).join('\n'));
        steps.push({ name, ok: false });
        failed++;
    }
}

step('syntax (all files under src/)', () => {
    for (const f of walkFiles(path.join(ROOT, 'src'))) execFileSync(node, ['--check', f], { encoding: 'utf8' });
});
step('module dependency resolution', () =>
    execFileSync(node, [path.join(__dirname, 'check-module-deps.js')], { encoding: 'utf8' })
);
step('runtime smoke tests', () =>
    execFileSync(node, [path.join(__dirname, 'smoke-test.js')], { encoding: 'utf8' })
);
step('full initialisation (browser globals stubbed)', () =>
    execFileSync(node, [path.join(__dirname, 'load-check.js')], { encoding: 'utf8' })
);
step('full initialisation — BFF room (browser globals stubbed)', () =>
    execFileSync(node, [path.join(__dirname, 'load-check-bff.js')], { encoding: 'utf8' })
);
step('parity with upstream monolith', () => {
    try {
        return execFileSync(node, [path.join(__dirname, 'audit-parity.js')], { encoding: 'utf8' });
    } catch (err) {
        if (err.status === 2) {
            console.log('skipped (upstream reference not present)');
            return '';
        }
        throw err;
    }
});

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
