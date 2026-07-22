import globals from 'globals';

const correctnessRules = {
  'no-constant-binary-expression': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-loss-of-precision': 'error',
  'no-obj-calls': 'error',
  'no-promise-executor-return': 'error',
  'no-self-assign': 'error',
  'no-setter-return': 'error',
  'no-unreachable': 'error',
  'no-unreachable-loop': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-undef': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

export default [
  {
    ignores: ['**/node_modules/**', 'frontend/dist/**', 'backend/data/**'],
  },
  {
    files: ['backend/src/**/*.js', 'backend/scripts/**/*.js', 'frontend/vite.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: correctnessRules,
  },
  {
    files: ['frontend/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    rules: correctnessRules,
  },
];