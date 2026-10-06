import { defineConfig } from 'vitest/config';

const src = '{packages,services}/*/src/**';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: { provider: 'v8', include: [src], exclude: ['**/*.test.ts'] },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: [`${src}/*.test.ts`], exclude: ['**/*.int.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [`${src}/*.int.test.ts`],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
