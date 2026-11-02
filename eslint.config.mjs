import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.tsbuildinfo', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    files: [
      'packages/cli/**/*.ts',
      'tooling/**/*.ts',
      'examples/**/*.ts',
      '**/test/**/*.ts',
      'vitest.config.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', 'packages/cli/bin/**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
