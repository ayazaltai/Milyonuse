import node from '@milyonuse/config/eslint/node';

export default [
  ...node,
  {
    // A CLI: stdout is its user interface, not a stray debug statement.
    files: ['src/migrate.ts'],
    rules: { 'no-console': 'off' },
  },
];
