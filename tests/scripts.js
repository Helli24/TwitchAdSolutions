// Loads functions and constants straight from the shipped script files, so the tests exercise the
// real code instead of hand-copied snapshots that silently drift.
//
// Both vaft formats wrap everything in one IIFE: `(function() { ... })();`. Declarations directly in
// that IIFE body are collected by name with acorn and evaluated in a fresh vm context.
//
// - loadWorker(): mirrors the worker blob. declareOptions(self) is run first, then the requested
//   functions are defined in the same context, exactly as the injected blob does.
// - loadMain(): evaluates main-thread functions/constants in a context whose globals (document,
//   location, storage, helpers the function calls) are supplied by the test as mocks.
// - findPairDifferences(): compares the code tokens of both formats, so a change made to only one
//   of the two files fails the tests.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');

const FORMATS = [
    { name: 'vaft.user.js', file: 'vaft/vaft.user.js', skipFirstLine: false },
    { name: 'vaft-ublock-origin.js', file: 'vaft/vaft-ublock-origin.js', skipFirstLine: true }
];

// The two formats carry the same code. Known, intended differences (all inherited from upstream):
// the uBlock resource bails out on other hosts (a userscript has @match for that), comments differ,
// and two log strings are shorter in the uBlock file.
const UBLOCK_ONLY_LINE = '    if ( /(^|\\.)twitch\\.tv$/.test(document.location.hostname) === false ) { return; }\n';
const KNOWN_STRING_DIFFERENCES = [
    // [userscript, uBlock]
    ["'[AD DEBUG] FastAutoplayFirstTry disabled via localStorage — full Source-tier probe on every break (no autoplay fast-path)'",
        "'[AD DEBUG] FastAutoplayFirstTry disabled via localStorage — full Source-tier probe on every break'"],
    ["'[AD DEBUG] AdSpoofing enabled via localStorage opt-in — firing GQL ad-tracking beacons on ad detect'",
        "'[AD DEBUG] AdSpoofing enabled via localStorage opt-in — firing GQL ad-tracking beacons'"]
];

function readSource(format) {
    let text = fs.readFileSync(path.join(ROOT, format.file), 'utf8');
    if (format.skipFirstLine) {
        // uBlock resource header ("twitch-videoad.js text/javascript") is not JavaScript
        text = text.slice(text.indexOf('\n') + 1);
    }
    return text;
}

// Name → source text of every function and variable declaration directly in the IIFE body
function collectDeclarations(source, label) {
    const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script' });
    const iife = ast.body.find((node) => node.type === 'ExpressionStatement' &&
        node.expression.type === 'CallExpression' &&
        node.expression.callee.type === 'FunctionExpression');
    if (!iife) {
        throw new Error(label + ': no top-level IIFE found');
    }
    const declarations = new Map();
    for (const node of iife.expression.callee.body.body) {
        if (node.type === 'FunctionDeclaration') {
            declarations.set(node.id.name, source.slice(node.start, node.end));
        } else if (node.type === 'VariableDeclaration') {
            for (const declarator of node.declarations) {
                if (declarator.id.type === 'Identifier') {
                    // Re-emit as `var` so the name becomes a property of the vm context's global
                    const init = declarator.init ? source.slice(declarator.init.start, declarator.init.end) : 'undefined';
                    declarations.set(declarator.id.name, 'var ' + declarator.id.name + ' = ' + init + ';');
                }
            }
        }
    }
    return declarations;
}

function pick(declarations, names, label) {
    return names.map((name) => {
        if (!declarations.has(name)) {
            throw new Error(label + ': declaration "' + name + '" not found');
        }
        return declarations.get(name);
    }).join('\n');
}

function loadFormat(format) {
    const source = readSource(format);
    const declarations = collectDeclarations(source, format.name);
    return {
        name: format.name,
        // Worker scope: declareOptions(self) + the given worker-serialized functions
        loadWorker(functionNames) {
            const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, URL });
            vm.runInContext(pick(declarations, ['declareOptions', ...functionNames], format.name) + '\ndeclareOptions(globalThis);', context, { filename: format.file });
            return context;
        },
        // Main-thread scope: the given declarations evaluated with the test's mocks as globals
        loadMain(names, globals) {
            const context = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} }, URL }, globals));
            vm.runInContext(pick(declarations, names, format.name), context, { filename: format.file });
            return context;
        }
    };
}

// Code tokens of a script: comments are not tokens, and comment lines inside the worker blob template
// (they are part of a string there) are dropped, so only differences in code remain.
function codeTokens(format, removeLine) {
    let source = readSource(format);
    if (removeLine) {
        if (source.split(removeLine).length !== 2) {
            throw new Error(format.name + ': expected the host check line exactly once');
        }
        source = source.replace(removeLine, '\n');
    }
    const tokens = [];
    for (const token of acorn.tokenizer(source, { ecmaVersion: 2022, sourceType: 'script', locations: true })) {
        let text = source.slice(token.start, token.end);
        if (token.type.label === 'template') {
            text = text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
        }
        tokens.push({ text: text, line: token.loc.start.line + (format.skipFirstLine ? 1 : 0) });
    }
    return tokens;
}

// Code differences between vaft.user.js and vaft-ublock-origin.js beyond the known ones (max 5 reported)
function findPairDifferences() {
    const userscript = codeTokens(FORMATS[0], null);
    const ublock = codeTokens(FORMATS[1], UBLOCK_ONLY_LINE);
    const differences = [];
    const count = Math.min(userscript.length, ublock.length);
    for (let i = 0; i < count && differences.length < 5; i++) {
        const a = userscript[i];
        const b = ublock[i];
        if (a.text === b.text || KNOWN_STRING_DIFFERENCES.some((pair) => pair[0] === a.text && pair[1] === b.text)) {
            continue;
        }
        // Inside a multi-line token (the worker blob template) point at the first differing line
        const aLines = a.text.split('\n');
        const bLines = b.text.split('\n');
        let row = 0;
        while (row < aLines.length - 1 && row < bLines.length - 1 && aLines[row] === bLines[row]) {
            row++;
        }
        differences.push(FORMATS[0].name + ':' + a.line + (row ? '+' + row : '') + ' ' + JSON.stringify(aLines[row].trim().slice(0, 100)) +
            ' vs ' + FORMATS[1].name + ':' + b.line + (row ? '+' + row : '') + ' ' + JSON.stringify(bLines[row].trim().slice(0, 100)));
        if (userscript.length !== ublock.length) {
            break;// after an inserted/removed token everything is shifted; the first difference is the useful one
        }
    }
    if (differences.length === 0 && userscript.length !== ublock.length) {
        differences.push('token count differs: ' + userscript.length + ' vs ' + ublock.length + ' (code appended to one file only)');
    }
    return differences;
}

module.exports = {
    formats: FORMATS.map(loadFormat),
    findPairDifferences
};
