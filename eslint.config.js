import js from '@eslint/js';
import parser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        // Cloudflare Workers globals
        DurableObjectNamespace: 'readonly',
        DurableObjectStub: 'readonly',
        DurableObjectState: 'readonly',
        ExecutionContext: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        FetchEvent: 'readonly',
        MessageBatch: 'readonly',
        Queue: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
        atob: 'readonly',
        RequestInit: 'readonly',
        process: 'readonly',
        // Node/ES globals
        URL: 'readonly',
        URLSearchParams: 'readonly',
        console: 'readonly',
        // Service (from @cloudflare/workers-types)
        Service: 'readonly',
      },
      parser: parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
    },
    ignores: ['**/node_modules/*', '**/dist/*', '**/.wrangler/*'],
  },
];
