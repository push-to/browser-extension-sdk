import { defineConfig } from 'tsup';
import { config } from 'dotenv';

config();

const PUSHTO_CORE_URL = process.env.PUSHTO_CORE_URL;

if (!PUSHTO_CORE_URL) {
  throw new Error('PUSHTO_CORE_URL is not set');
}

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
    PUSHTO_CORE_URL,
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
