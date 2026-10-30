import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript source, so they are bundled; npm dependencies stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  target: 'node24',
  clean: true,
  noExternal: [/^@onebox\//],
  external: [/^(?!@onebox\/)[a-z@][^:]*$/],
});
