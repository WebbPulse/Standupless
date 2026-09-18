/**
 * ESLint configuration for the frontend, extending the shared WebbPulse react
 * config.
 */

import { reactConfig } from '@webbpulse/eslint-config/react';
import reactDom from 'eslint-plugin-react-dom';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import reactX from 'eslint-plugin-react-x';

export default [
  ...reactConfig({
    project: ['./tsconfig.app.json'],
    tsconfigRootDir: import.meta.dirname,
    plugins: {
      'react-refresh': reactRefresh,
      'react-hooks': reactHooks,
      'react-x': reactX,
      'react-dom': reactDom,
    },
    rules: {
      ...reactX.configs['recommended-typescript'].rules,
      ...reactDom.configs.recommended.rules,
      'react-x/no-use-context': 'off',
      'react-x/no-context-provider': 'off',
      'react-x/unsupported-syntax': 'off',
    },
  }),
  {
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
    },
  },
];
