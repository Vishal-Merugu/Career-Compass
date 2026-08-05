import prettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    // `dist/` is build output and `dist-extension/` is a build scratch dir —
    // both are gitignored, and linting them fails on module-syntax parse errors.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'dist-extension/**',
      'extension/services/socket.io.min.js',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
      },
    },
    plugins: {
      prettier: prettier,
    },
    rules: {
      ...eslintConfigPrettier.rules,
      'prettier/prettier': 'error',
    },
  },
];
