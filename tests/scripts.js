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
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');

const FORMATS = [
    { name: 'vaft.user.js', file: 'vaft/vaft.user.js', skipFirstLine: false },
    { name: 'vaft-ublock-origin.js', file: 'vaft/vaft-ublock-origin.js', skipFirstLine: true }
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
            const context = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
            vm.runInContext(pick(declarations, ['declareOptions', ...functionNames], format.name) + '\ndeclareOptions(globalThis);', context, { filename: format.file });
            return context;
        },
        // Main-thread scope: the given declarations evaluated with the test's mocks as globals
        loadMain(names, globals) {
            const context = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} } }, globals));
            vm.runInContext(pick(declarations, names, format.name), context, { filename: format.file });
            return context;
        }
    };
}

module.exports = {
    formats: FORMATS.map(loadFormat)
};
