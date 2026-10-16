'use strict';

const { execSync } = require('node:child_process');
const { cpSync, rmSync, existsSync, chmodSync, statSync } = require('node:fs');
const { resolve, join } = require('node:path');
const os = require('node:os');

const root = resolve(__dirname, '..');
const distCli = join(root, 'dist', 'cli.cjs');
const outputBinary = join(root, 'torlnk');

console.log('[build-binary] Ensuring project is built...');
if (!existsSync(distCli)) {
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

const stagingDir = join(os.tmpdir(), `torlnk-pack-${Date.now()}`);
console.log(`[build-binary] Preparing staging directory at: ${stagingDir}`);

try {
  // Copy minimal runtime files needed to run torlnk
  for (const item of ['dist', 'package.json', 'package-lock.json', 'node_modules', 'scripts']) {
    const src = join(root, item);
    const dest = join(stagingDir, item);
    if (existsSync(src)) {
      cpSync(src, dest, { recursive: true, dereference: true });
    }
  }

  console.log('[build-binary] Packaging standalone binary with caxa...');
  const caxaCmd = `npx --yes caxa --input "${stagingDir}" --output "${outputBinary}" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/cli.cjs"`;
  execSync(caxaCmd, { cwd: root, stdio: 'inherit' });

  chmodSync(outputBinary, 0o755);

  const stats = statSync(outputBinary);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
  console.log(`[build-binary] Successfully created standalone executable: ${outputBinary} (${sizeMb} MB)`);

  console.log('[build-binary] Verifying binary execution...');
  const verOutput = execSync(`"${outputBinary}" --version`, { encoding: 'utf-8' }).trim();
  console.log(`[build-binary] Version check: ${verOutput}`);
} finally {
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
