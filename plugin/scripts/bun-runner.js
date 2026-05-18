#!/usr/bin/env node
// Compatibility shim: Claude Code harness calls bun-runner.js for hook dispatch.
// Beta/7.0 uses dedicated hook scripts. Map harness hook events → beta scripts.
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2); // [worker-service.cjs, subcommand, ...]
const subcommand = args[1];
const event = args[3]; // hook <platform> <event>

const hookMap = {
  'context':      'context-hook.js',
  'session-init': 'context-hook.js',
  'observation':  'save-hook.js',
  'summarize':    'summary-hook.js',
  'user-message': 'new-hook.js',
};

if (subcommand === 'hook' && event && hookMap[event]) {
  const script = join(__dir, hookMap[event]);
  const result = spawnSync(process.execPath, [script], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env
  });
  process.exit(result.status ?? 0);
} else {
  // start/stop/restart/status/daemon — forward to worker-service.cjs
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: process.env
  });
  process.exit(result.status ?? 0);
}
