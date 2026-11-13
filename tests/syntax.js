// Syntax check for every shipped script (same check CI and the release workflow run).
// uBlock Origin resources start with a "<name> text/javascript" header line that is not JavaScript.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const USERSCRIPTS = [
    'vaft/vaft.user.js',
    'vaft/twitch-brave-fix.user.js',
    'video-swap-new/video-swap-new.user.js',
    'strip/strip.user.js'
];
const UBLOCK_RESOURCES = [
    'vaft/vaft-ublock-origin.js',
    'vaft/twitch-brave-fix-ublock-origin.js',
    'video-swap-new/video-swap-new-ublock-origin.js'
];

let failed = 0;
function check(file, isUblockResource) {
    let source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (isUblockResource) {
        const header = source.slice(0, source.indexOf('\n'));
        if (!/^\S+\.js text\/javascript$/.test(header.trim())) {
            failed++;
            console.log('FAIL ' + file + ': first line is not a uBlock resource header ("<name>.js text/javascript")');
            return;
        }
        // Keep the line count so error positions match the file
        source = '//' + source;
    }
    try {
        acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
        console.log('ok   ' + file);
    } catch (err) {
        failed++;
        console.log('FAIL ' + file + ': ' + err.message);
    }
}
USERSCRIPTS.forEach((file) => check(file, false));
UBLOCK_RESOURCES.forEach((file) => check(file, true));
process.exit(failed > 0 ? 1 : 0);
