#!/usr/bin/env node
/**
 * Ensure dependencies are installed before `npm run dev` / `npm start`.
 *
 * Why: a fresh clone or a ZIP download doesn't ship node_modules — running
 * the app right away fails with "vite: not found" / "Cannot find module
 * 'dotenv'". This script installs whatever is missing (root, server,
 * client) so first run just works. It exits instantly when everything is
 * already installed, so it adds no overhead on later runs.
 */
const { existsSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const targets = [
  [root, 'root'],
  [path.join(root, 'server'), 'server'],
  [path.join(root, 'client'), 'client'],
];

const missing = targets.filter(([dir]) => !existsSync(path.join(dir, 'node_modules')));

if (!missing.length) {
  console.log('✓ Dependencies already installed (root, server, client).');
  process.exit(0);
}

console.log(`\n📦 Installing dependencies for: ${missing.map(([, name]) => name).join(', ')}`);
console.log('   This can take a minute or two on first run. It happens only once.\n');

for (const [dir, name] of missing) {
  console.log(`→ npm install (${name})`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  if (r.error) {
    console.error(`\n✖ Failed to run npm install in ${name}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n✖ npm install failed in ${name} (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
}

console.log('\n✓ Dependencies ready. Starting the app…\n');
