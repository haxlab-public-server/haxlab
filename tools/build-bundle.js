/*
 * Manual/debug entry point for the same bundling step src/index.js runs at
 * every startup (see buildEntryBundle() there) — writes the result to disk
 * instead of injecting it into a page, so it can be inspected without
 * launching Puppeteer. Not part of the deploy path: the orchestrator always
 * builds its own copy fresh in memory, this is purely for local debugging.
 *
 * Usage: node tools/build-bundle.js [outFile]
 */
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const outFile = process.argv[2] || path.join(__dirname, '..', 'dist', 'room-bundle.js');

esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'browser', 'entry.js')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
}).then((result) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, result.outputFiles[0].text);
    console.log(`Bundled ${result.outputFiles[0].text.length} bytes -> ${path.relative(process.cwd(), outFile)}`);
}).catch((err) => {
    console.error('Bundle failed:', err);
    process.exit(1);
});
