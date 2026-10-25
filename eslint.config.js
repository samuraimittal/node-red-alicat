'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const n = require('eslint-plugin-n');

module.exports = [
    { ignores: ['coverage/**', 'node_modules/**', '.dev/**', 'soak-results/**'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
            eqeqeq: ['error', 'always'],
            'prefer-const': 'error',
            'no-var': 'error',
            strict: ['error', 'global'],
            'no-shadow': 'error',
            'consistent-return': 'error',
            curly: ['error', 'multi-line'],
            'no-param-reassign': 'error',
            'prefer-promise-reject-errors': 'error',
            'default-case': 'error',
            'array-callback-return': 'error',
            'no-throw-literal': 'error',
            'dot-notation': 'error',
            'object-shorthand': 'error',
            'prefer-template': 'error',
            'no-else-return': 'error',
            'no-useless-assignment': 'error',
            radix: 'error',
            'guard-for-in': 'error',
            'prefer-object-has-own': 'error'
        }
    },
    {
        files: ['lib/**/*.js', 'nodes/**/*.js'],
        rules: { 'no-console': 'error' }
    },
    {
        files: ['lib/**/*.js', 'nodes/**/*.js', 'tools/**/*.js'],
        rules: {
            complexity: ['error', 15],
            'max-depth': ['error', 4],
            'max-params': ['error', 5]
        }
    },
    {
        files: ['lib/**/*.js'],
        rules: { 'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }] }
    },
    {
        // Shipped code runs on every Node.js that package.json `engines` allows (18+), and
        // may require nothing but Node's own modules (published files: no devDependencies).
        files: ['lib/**/*.js', 'nodes/**/*.js', 'tools/**/*.js'],
        plugins: { n },
        rules: {
            'n/no-unsupported-features/es-syntax': 'error',
            'n/no-unsupported-features/es-builtins': 'error',
            // util.parseArgs (tools/cli.js) exists from 18.3; Node-RED 4, and so this package, needs 18.5.
            'n/no-unsupported-features/node-builtins': ['error', { ignores: ['util.parseArgs'] }],
            'n/no-deprecated-api': 'error',
            'n/no-missing-require': 'error',
            'n/no-extraneous-require': 'error'
        }
    },
    {
        files: ['test/**/*.js'],
        languageOptions: { globals: { ...globals.node, ...globals.mocha } }
    },
    {
        // Editor scripts: loaded by the browser as plain scripts.
        files: ['resources/**/*.js'],
        languageOptions: {
            ecmaVersion: 2017,
            sourceType: 'script',
            globals: { ...globals.browser, RED: 'readonly', $: 'readonly' }
        },
        rules: { strict: ['error', 'function'] }
    }
];
