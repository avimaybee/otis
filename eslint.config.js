import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'dist/**',
      'packages/*/dist/**',
      'packages/**/dist/**',
      'apps/*/dist/**',
      'apps/**/dist/**',
      '**/dist-client/**',
      '**/dist-worker/**',
      '**/storybook-static/**',
      'storybook-static/**',
      '**/008-browser-evidence/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/eval-output/**',
      'UI-refs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ...jsxA11y.flatConfigs.recommended,
  },
  {
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  }
);
