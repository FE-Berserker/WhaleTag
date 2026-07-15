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
    'build-cache/',
    'samples/',
    'tools/',
    'Test/',
  ],
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-var-requires': 'off',
  },
};
