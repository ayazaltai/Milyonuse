import node from '@milyonuse/config/eslint/node';

export default [
  ...node,
  {
    files: ['src/**/*.ts'],
    rules: {
      /**
       * Off here, and only here.
       *
       * Nest resolves constructor dependencies from the `design:paramtypes`
       * metadata TypeScript emits. `import type` is fully erased, so the
       * metadata degrades from [HealthService] to [Function] and the container
       * fails at runtime with "can't resolve dependencies" — while typecheck,
       * lint and build all stay green. The autofix for this rule introduces
       * exactly that bug, so the rule does not run over DI code.
       *
       * Verified against TypeScript 7.0.2 with emitDecoratorMetadata.
       */
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
