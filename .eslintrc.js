module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    // Rules of Hooks is a correctness rule, not a style one: a hook after an
    // early return crashes React at runtime ("Rendered more hooks than during
    // the previous render"). It was previously only *registered* as a plugin,
    // so the rules never ran.
    'plugin:react-hooks/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  settings: {
    react: { version: 'detect' },
  },
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    'node_modules/',
    'release/',
    '.erb/dll/',
    '*.config.ts',
    // Build artifacts (webpack bundles, hashed assets) — gitignored but eslint
    // doesn't read .gitignore, so list them explicitly. Without this, `eslint .`
    // scans the 40 MB+ `dist/` bundle and emits thousands of bogus errors
    // (no-constant-condition / no-this-alias / no-redeclare on minified code).
    'dist/',
    // Vendored / non-source dirs (UI design export, samples, runtime tools).
    'WhaleTag_Page/',
    'UI_Design/',
    'LightWork/',
    'artifacts/',
    'build-cache/',
    'samples/',
    'tools/',
    'Test/',
  ],
  overrides: [
    {
      // CLI build / verification scripts print progress and PASS/FAIL
      // summaries to stdout by design; the app-level no-console policy covers
      // src/ only.
      files: ['scripts/**/*.js', 'scripts/**/*.cjs', 'scripts/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    // Warnings and errors are diagnostics users may need to see; `log` / `info`
    // / `debug` are the ones that leaked into production. Informational lines
    // go through `src/main/log.ts` so this rule catches future strays.
    'no-console': ['error', { allow: ['warn', 'error'] }],
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-var-requires': 'off',
  },
};
