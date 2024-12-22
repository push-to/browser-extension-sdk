import { defineConfig } from 'tsup';
import { config } from 'dotenv';

config();

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: {
    resolve: true,
    compilerOptions: {
      composite: false,
      incremental: false,
    },
  },
  clean: true,
  env: {
    PUSHTO_CORE_URL: process.env.PUSHTO_CORE_URL!,
    PUSHTO_AUTH_TOKEN: process.env.PUSHTO_AUTH_TOKEN!,
  },
  sourcemap: true,
  target: 'es2020',
  outDir: 'dist',
  treeshake: true,
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.js' : '.cjs',
    };
  },
});
