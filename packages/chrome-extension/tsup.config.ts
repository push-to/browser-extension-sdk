import { defineConfig } from 'tsup';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';

config();

const PUSHTO_CORE_URL = process.env.PUSHTO_CORE_URL;

if (!PUSHTO_CORE_URL) {
  throw new Error('PUSHTO_CORE_URL is not set');
}

// Reported to push-api as the endpoint's `sdk_version`. tsup runs with the
// package directory as its working directory.
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version: string;
};

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
    PUSHTO_SDK_VERSION: version,
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
