#!/usr/bin/env node
/**
 * Ensure dependencies are installed before `npm run dev` / `npm start`.
 *
 * Why: a fresh clone or a ZIP download doesn't ship node_modules — running
 * the app right away fails with "vite: not found" / "Cannot find module
 * 'dotenv'". This script installs whatever is missing (root, server,
 * client) so first run just works. It exits instantly when everything is
 * already installed, so it adds no overhead on later runs.
 *
 * Robustness: a present `node_modules` directory is NOT enough — a Ctrl+C'd
 * install can leave it half-written. We also verify that each package's
 * required modules actually exist, and reinstall any that don't.
 */
const { existsSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

// Minimal module list per package. If any of these is missing from
// node_modules, that package gets reinstalled.
const REQUIRED = {
  root: ['concurrently'],
  server: ['dotenv', 'express', 'cors', 'webtorrent', 'multer'],
  client: ['vite', 'react', 'react-dom', 'react-router-dom', 'lucide-react'],
};

function needsInstall(dir, name) {
  if (!existsSync(path.join(dir, 'node_modules'))) return true;
  for (const m of REQUIRED[name]) {
    if (!existsSync(path.join(dir, 'node_modules', m, 'package.json'))) return true;
  }
  return false;
}

const targets = [
  ['root', root],
  ['server', path.join(root, 'server')],
  ['client', path.join(root, 'client')],
].filter(([name, dir]) => needsInstall(dir, name));

if (!targets.length) {
  console.log('✓ Dependencies already installed (root, server, client).');
  process.exit(0);
}

console.log(`\n📦 Installing missing dependencies: ${targets.map(([n]) => n).join(', ')}`);
console.log('   This happens once (a minute or two). The ⠹ spinner you see is npm');
console.log('   working — it is NOT stuck. Press Ctrl+C only if you want to stop.\n');

let failed = false;
for (const [name, dir] of targets) {
  console.log(`→ npm install (${name})…`);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`✖ npm install failed in ${name}. Run it manually:`);
    console.error(`     cd ${dir} && npm install`);
    failed = true;
  } else {
    console.log(`  ✓ ${name} ready`);
  }
}
if (failed) process.exit(1);
console.log('\n✓ Dependencies ready. Starting the app…\n');
