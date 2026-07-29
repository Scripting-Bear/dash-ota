// Flat ESLint config for the dash-ota packages (typescript-eslint, non-type-checked).
// Scope: the pure-Node packages (shared / backend / cli). The RN package has its own tooling.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/lib/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.docusaurus/**',
      'website/**',
      'graphify-out/**',
      'packages/rn/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
