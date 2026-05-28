const tseslint = require('@typescript-eslint/eslint-plugin');

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs['flat/recommended-type-checked'],
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Only console.error is permitted in config.ts (before pino is initialised).
      // All other diagnostic logging must go through the pino logger.
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    files: ['src/cli.ts'],
    rules: {
      // cli.ts renders output directly to the user's terminal via
      // process.stdout.write — the sanctioned mechanism for CLI output.
      'no-console': 'off',
    },
  },
];
