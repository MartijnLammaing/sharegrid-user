/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    // Only console.error is permitted in config.ts (before pino is initialised).
    // All other diagnostic logging must go through the pino logger.
    'no-console': ['error', { allow: ['error'] }],
  },
  overrides: [
    {
      // cli.ts renders output directly to the user's terminal.
      // process.stdout.write is the sanctioned mechanism — it does not add
      // implicit newlines between streamed response chunks, unlike console.log.
      // process.stderr.write is allowed for any urgent user-facing errors that
      // occur before the session is established.
      // Neither is application logging; pino handles that separately on stderr.
      files: ['src/cli.ts'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
};
