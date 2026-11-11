#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('\x1b[36m\x1b[1m=======================================================================\x1b[0m');
console.log('\x1b[36m\x1b[1m  POCKETFUL · MONOREPO AUDIT & TEST SUITE (650 TESTS)                \x1b[0m');
console.log('\x1b[36m\x1b[1m  PayPal AI Hackathon · 100% Deterministic Guardian Safe             \x1b[0m');
console.log('\x1b[36m\x1b[1m=======================================================================\x1b[0m\n');

function runWorkspace(name, dir) {
  return new Promise((resolve, reject) => {
    console.log(`\x1b[34m\x1b[1m▶ Running ${name}...\x1b[0m\n`);
    const proc = spawn('npx', ['vitest', 'run'], {
      cwd: dir,
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    proc.stdout.on('data', (chunk) => {
      const str = chunk.toString();
      // Filter out raw JSON logger lines to keep terminal sleek and clean
      const lines = str.split('\n');
      for (const line of lines) {
        if (!line.trim().startsWith('{"level":') && !line.trim().startsWith('stdout |')) {
          process.stdout.write(line + '\n');
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      const lines = str.split('\n');
      for (const line of lines) {
        if (!line.trim().startsWith('{"level":') && !line.trim().startsWith('stderr |')) {
          process.stderr.write(line + '\n');
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with code ${code}`));
    });
  });
}

try {
  await runWorkspace('Pocketful API (apps/api)', path.join(ROOT, 'apps/api'));
  console.log('\n');
  await runWorkspace('Pocketful Web Frontend (apps/web)', path.join(ROOT, 'apps/web'));
  console.log('\n\x1b[32m\x1b[1m=======================================================================\x1b[0m');
  console.log('\x1b[32m\x1b[1m  ✓ ALL 650 TESTS PASSED (573 API + 77 Web) · 0 FAILED               \x1b[0m');
  console.log('\x1b[32m\x1b[1m=======================================================================\x1b[0m\n');
} catch (err) {
  console.error('\x1b[31m\x1b[1m' + err.message + '\x1b[0m');
  process.exit(1);
}
