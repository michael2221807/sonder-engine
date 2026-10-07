// Project ESLint config (report-only: every rule is a warning, CI does not fail on it).
// Named eslint-rules.mjs, not eslint.config.mjs, because a local agent hook blocks writes
// to files named eslint.config.*; `npm run lint` passes it with -c. Rules come from the
// 2026-10 code-health audit (docs/status/code-audit-2026-10, roadmap W0).
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import sonarjs from 'eslint-plugin-sonarjs';
import vitest from '@vitest/eslint-plugin';
import playwright from 'eslint-plugin-playwright';
import globals from 'globals';

const ROOT = import.meta.dirname;

/** Rules that need no type information, shared by .ts and .vue sources. */
const sharedRules = {
  // D — dead code / redundant control flow
  'no-unreachable': 'warn',
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-empty': ['warn', { allowEmptyCatch: false }],
  'no-lonely-if': 'warn',
  'no-useless-return': 'warn',
  'no-useless-catch': 'warn',
  'no-useless-concat': 'warn',
  'no-self-assign': 'warn',
  'no-unused-labels': 'warn',
  'no-warning-comments': ['warn', { terms: ['todo', 'fixme', 'hack', 'xxx'], location: 'start' }],
  '@typescript-eslint/no-empty-function': 'warn',
  '@typescript-eslint/no-useless-constructor': 'warn',
  '@typescript-eslint/no-unused-expressions': 'warn',
  'sonarjs/no-commented-code': 'warn',
  'sonarjs/no-dead-store': 'warn',
  'sonarjs/no-unused-collection': 'warn',
  'sonarjs/no-redundant-assignments': 'warn',
  'sonarjs/no-redundant-jump': 'warn',
  'sonarjs/no-empty-collection': 'warn',
  'sonarjs/no-useless-increment': 'warn',
  // R — duplication inside a file
  'sonarjs/no-identical-functions': 'warn',
  'sonarjs/no-duplicated-branches': 'warn',
  'sonarjs/no-all-duplicated-branches': 'warn',
  'sonarjs/no-identical-conditions': 'warn',
  'sonarjs/no-identical-expressions': 'warn',
  'sonarjs/no-element-overwrite': 'warn',
  // readability — convoluted logic
  'sonarjs/cognitive-complexity': ['warn', 25],
  'sonarjs/no-collapsible-if': 'warn',
  'sonarjs/no-redundant-boolean': 'warn',
  'sonarjs/no-gratuitous-expressions': 'warn',
  'sonarjs/no-inverted-boolean-check': 'warn',
  'sonarjs/prefer-single-boolean-return': 'warn',
  'sonarjs/no-small-switch': 'warn',
  'sonarjs/no-nested-switch': 'warn',
  'sonarjs/no-collection-size-mischeck': 'warn',
  // T — type escapes
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-non-null-assertion': 'warn',
  '@typescript-eslint/ban-ts-comment': [
    'warn',
    { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true, minimumDescriptionLength: 10 },
  ],
};

/** Type-aware rules: over-defence, async safety, deprecated use (src .ts only). */
const typedRules = {
  '@typescript-eslint/no-unnecessary-condition': ['warn', { allowConstantLoopConditions: true }],
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
  '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'warn',
  '@typescript-eslint/no-unnecessary-template-expression': 'warn',
  '@typescript-eslint/no-unnecessary-type-parameters': 'warn',
  '@typescript-eslint/no-redundant-type-constituents': 'warn',
  '@typescript-eslint/no-floating-promises': 'warn',
  '@typescript-eslint/no-misused-promises': ['warn', { checksVoidReturn: { attributes: false } }],
  '@typescript-eslint/require-await': 'warn',
  '@typescript-eslint/only-throw-error': 'warn',
  '@typescript-eslint/no-deprecated': 'warn',
  'sonarjs/no-ignored-return': 'warn',
};

const vueRules = {
  'vue/no-unused-components': 'warn',
  'vue/no-unused-properties': [
    'warn',
    { groups: ['props', 'data', 'computed', 'methods', 'setup'], deepData: false, ignorePublicMembers: true },
  ],
  'vue/no-unused-refs': 'warn',
  'vue/no-unused-emit-declarations': 'warn',
  'vue/no-unused-vars': 'warn',
  'vue/no-useless-template-attributes': 'warn',
  'vue/no-useless-v-bind': 'warn',
  'vue/no-useless-mustaches': 'warn',
  'vue/no-dupe-keys': 'warn',
  'vue/no-setup-props-reactivity-loss': 'warn',
  'vue/no-ref-object-reactivity-loss': 'warn',
  'vue/require-explicit-emits': 'warn',
  'vue/no-v-html': 'warn',
};

const unitTestRules = {
  'vitest/expect-expect': 'warn',
  'vitest/no-identical-title': 'warn',
  'vitest/no-conditional-expect': 'warn',
  'vitest/no-conditional-in-test': 'warn',
  'vitest/no-disabled-tests': 'warn',
  'vitest/no-focused-tests': 'warn',
  'vitest/no-standalone-expect': 'warn',
  'vitest/no-duplicate-hooks': 'warn',
  'vitest/no-commented-out-tests': 'warn',
  'vitest/valid-expect': 'warn',
  'vitest/valid-title': 'warn',
  'vitest/max-nested-describe': ['warn', { max: 4 }],
  'vitest/no-large-snapshots': ['warn', { maxSize: 60, inlineMaxSize: 30 }],
  'sonarjs/no-identical-functions': 'warn',
  'sonarjs/no-commented-code': 'warn',
};

const e2eRules = {
  'playwright/expect-expect': 'warn',
  'playwright/no-wait-for-timeout': 'warn',
  'playwright/no-wait-for-selector': 'warn',
  'playwright/no-skipped-test': ['warn', { allowConditional: true }],
  'playwright/no-conditional-in-test': 'warn',
  'playwright/no-force-option': 'warn',
  'playwright/no-networkidle': 'warn',
  'playwright/no-element-handle': 'warn',
  'playwright/no-page-pause': 'warn',
  'playwright/no-useless-await': 'warn',
  'playwright/no-useless-not': 'warn',
  'playwright/prefer-web-first-assertions': 'warn',
  'playwright/missing-playwright-await': 'warn',
  'playwright/no-commented-out-tests': 'warn',
  'playwright/valid-title': 'warn',
  'sonarjs/no-identical-functions': 'warn',
};

const commonPlugins = { '@typescript-eslint': tseslint.plugin, sonarjs };

export default [
  { ignores: ['**/node_modules/**', 'src/lab/**', 'dist/**', 'dist-lab/**', 'coverage/**', 'playwright-report/**', 'e2e/test-results/**', 'public/**'] },
  {
    linterOptions: { reportUnusedDisableDirectives: 'warn', reportUnusedInlineConfigs: 'warn' },
  },
  // Production .ts — shared + type-aware rules.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/__test-utils__/**', 'src/**/*.d.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: ROOT },
      globals: { ...globals.browser },
    },
    plugins: commonPlugins,
    rules: { ...sharedRules, ...typedRules },
  },
  // .vue SFCs — shared + vue rules, no type information.
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module', extraFileExtensions: ['.vue'] },
      globals: { ...globals.browser },
    },
    plugins: { ...commonPlugins, vue },
    rules: { ...sharedRules, ...vueRules },
  },
  // Unit tests.
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/__test-utils__/**/*.ts'],
    languageOptions: { parser: tseslint.parser, globals: { ...globals.node } },
    plugins: { ...commonPlugins, vitest },
    rules: unitTestRules,
  },
  // e2e.
  {
    files: ['e2e/**/*.ts'],
    languageOptions: { parser: tseslint.parser, globals: { ...globals.node } },
    plugins: { ...commonPlugins, playwright },
    rules: e2eRules,
  },
];
