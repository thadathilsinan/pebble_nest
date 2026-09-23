// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Do not read process.env here. Inject the validated ENV token from src/config/ instead — values there are parsed, typed and defaulted.',
        },
      ],
    },
  },
  {
    // src/config/ is the one place allowed to touch the raw environment: the
    // schema declares it and the module parses it. Everywhere else injects ENV.
    files: ['src/config/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    // The layer boundary in `docs/adding-a-feature.md` §3.1, enforced rather
    // than reviewed. It was prose, and prose is the thing this file already
    // declined to rely on for `process.env` one block up — the same argument
    // applies to the same kind of rule, so it gets the same mechanism.
    //
    // Scoped to feature directories by excluding the infrastructure folders that
    // legitimately import the database: `src/database/` defines the pool and the
    // schema, and `src/health/` probes the pool directly, by decision.
    files: ['src/**/*.ts'],
    ignores: [
      'src/database/**/*.ts',
      'src/health/**/*.ts',
      'src/**/*.repository.ts',
      'src/**/*.spec.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'drizzle-orm',
              message:
                'SQL belongs in a *.repository.ts. A service or controller that builds a query is the thing that makes the soft-delete filter and the version predicate unenforceable — docs/adding-a-feature.md §3.4.',
            },
            {
              name: 'pg',
              message:
                'Inject the repository, not the pool. Raw pg access outside src/database/ bypasses the boundary that applies the two rules the database cannot enforce.',
            },
          ],
          patterns: [
            {
              group: ['drizzle-orm/*'],
              message:
                'SQL belongs in a *.repository.ts — docs/adding-a-feature.md §3.4.',
            },
          ],
        },
      ],
    },
  },
  {
    // The other direction: a repository may hold SQL and may not decide what the
    // caller sees. It returns outcomes as values, because the same method is
    // called from a second endpoint that wants a different status for the same
    // absence, and from a background job that wants none — §3.1, §3.4.
    files: ['src/**/*.repository.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/common',
              importNames: [
                'HttpException',
                'NotFoundException',
                'ConflictException',
                'BadRequestException',
                'ForbiddenException',
                'UnauthorizedException',
                'UnprocessableEntityException',
                'GoneException',
                'ServiceUnavailableException',
                'GatewayTimeoutException',
                'InternalServerErrorException',
              ],
              message:
                'A repository returns outcomes, never HTTP status. The service decides what an outcome means over HTTP — docs/adding-a-feature.md §3.1.',
            },
          ],
        },
      ],
    },
  },
  {
    // `drizzle.config.ts` is not application code. It is bundled and run by
    // `drizzle-kit`, never imported by the service, and excluded from the
    // build — there is no ENV token in existence to inject into it, because no
    // Nest container is running when it executes.
    files: ['drizzle.config.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
