// Release step for @push-to/chrome-extension (see .releaserc.json).
//
//   node tools/prepare-release.mjs <version>   write the version, build, check
//   node tools/prepare-release.mjs --check     check an existing build
//
// The bundle carries the package version as `sdk_version` (tsup.config.ts
// reads package.json when it builds). semantic-release only knows the next
// version in its `prepare` step, so the bundle has to be built there, after
// the version is written: a build made earlier in the workflow reports the
// previous release (1.0.0 was published reporting 0.0.17 that way). The check
// fails the release rather than publish a bundle with another version.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(
  new URL('../packages/chrome-extension/', import.meta.url),
);
const packageJson = `${packageDir}package.json`;
const argument = process.argv[2];

if (!argument) {
  console.error('usage: prepare-release.mjs <version> | --check');
  process.exit(1);
}

if (argument !== '--check') {
  const pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
  pkg.version = argument;
  writeFileSync(packageJson, JSON.stringify(pkg, null, 2) + '\n');
  // Needs PUSHTO_CORE_URL, like every build.
  execSync('bun run build', { cwd: packageDir, stdio: 'inherit' });
}

const { version } = JSON.parse(readFileSync(packageJson, 'utf8'));
for (const file of ['dist/index.js', 'dist/index.cjs']) {
  const built = /SDK_VERSION = "([^"]*)"/.exec(
    readFileSync(packageDir + file, 'utf8'),
  )?.[1];
  if (built !== version) {
    console.error(
      `${file} reports sdk_version ${built ?? '(none found)'}, but package.json is ${version}`,
    );
    process.exit(1);
  }
}
console.log(`dist reports sdk_version ${version}`);
