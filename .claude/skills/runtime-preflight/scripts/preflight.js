#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message, evidence = {}) {
  const error = new Error(message);
  error.evidence = evidence;
  throw error;
}
function run(command, args, cwd, env = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}
function detect(root) {
  const adapters = [];
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) adapters.push({ id: 'node-pnpm', command: 'pnpm', args: ['install', '--frozen-lockfile'], projection: 'node_modules', files: ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.npmrc'] });
  else if (fs.existsSync(path.join(root, 'package-lock.json'))) adapters.push({ id: 'node-npm', command: 'npm', args: ['ci'], projection: 'node_modules', files: ['package-lock.json', 'package.json', '.npmrc'] });
  else if (fs.existsSync(path.join(root, 'yarn.lock'))) adapters.push({ id: 'node-yarn', command: 'yarn', args: ['install', '--immutable'], projection: 'node_modules', files: ['yarn.lock', 'package.json', '.yarnrc.yml'] });

  if (fs.existsSync(path.join(root, 'uv.lock'))) adapters.push({ id: 'python-uv', command: 'uv', args: ['sync', '--frozen'], projection: '.venv', files: ['uv.lock', 'pyproject.toml'] });
  else if (fs.existsSync(path.join(root, 'poetry.lock'))) adapters.push({ id: 'python-poetry', command: 'poetry', args: ['install', '--no-interaction'], env: { POETRY_VIRTUALENVS_IN_PROJECT: 'true' }, projection: '.venv', files: ['poetry.lock', 'pyproject.toml'] });
  else {
    const requirements = fs.readdirSync(root).sort().find(name => /^requirements.*\.txt$/.test(name));
    if (requirements) {
      const python = process.platform === 'win32' ? 'python' : 'python3';
      const pip = process.platform === 'win32' ? path.join('.venv', 'Scripts', 'pip.exe') : path.join('.venv', 'bin', 'pip');
      adapters.push({ id: 'python-pip', command: python, args: ['-m', 'venv', '.venv'], followup: { command: pip, args: ['install', '-r', requirements] }, projection: '.venv', files: [requirements, 'pyproject.toml'] });
    }
  }

  if (fs.existsSync(path.join(root, 'composer.lock'))) adapters.push({ id: 'php-composer', command: 'composer', args: ['install', '--no-interaction', '--prefer-dist'], projection: 'vendor', files: ['composer.lock', 'composer.json'] });
  if (fs.existsSync(path.join(root, 'go.mod'))) adapters.push({ id: 'go-mod', command: 'go', args: ['mod', 'download'], projection: null, files: ['go.mod', 'go.sum'] });
  if (fs.existsSync(path.join(root, 'Cargo.lock'))) adapters.push({ id: 'rust-cargo', command: 'cargo', args: ['fetch', '--locked'], projection: null, files: ['Cargo.lock', 'Cargo.toml'] });
  if (fs.existsSync(path.join(root, 'Gemfile.lock'))) adapters.push({ id: 'ruby-bundler', command: 'bundle', args: ['install', '--path', 'vendor/bundle'], projection: 'vendor/bundle', files: ['Gemfile.lock', 'Gemfile'] });
  return adapters;
}
function versionOf(adapter, root) {
  const result = run(adapter.command, ['--version'], root, adapter.env);
  if (result.status !== 0) fail(`找不到或無法執行 ${adapter.command}`, { adapter: adapter.id, stderr: String(result.stderr || '').trim() });
  return String(result.stdout || result.stderr || '').trim();
}
function fingerprint(adapter, root, version) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ adapter: adapter.id, version, platform: process.platform, arch: process.arch, node: process.version }));
  for (const name of adapter.files) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    hash.update(`\0${name}\0`);
    hash.update(fs.readFileSync(file));
  }
  return `sha256:${hash.digest('hex')}`;
}
function projectionReady(adapter, root) {
  return !adapter.projection || fs.existsSync(path.join(root, adapter.projection));
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function acquireLock(lockDir, timeoutMs, pollMs) {
  const ownerPath = path.join(lockDir, 'owner.json');
  const owner = { pid: process.pid, hostname: os.hostname(), created_at: new Date().toISOString() };
  const deadline = Date.now() + timeoutMs;
  let waitedMs = 0;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, JSON.stringify(owner, null, 2) + '\n');
      return { owner, waitedMs };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(ownerPath, 'utf8')); } catch (_) {}
      if (existing && existing.hostname === os.hostname() && !pidAlive(existing.pid)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch (_) {}
      if (!existing && ageMs > 300000) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        fail('等待另一個 runtime-preflight 逾時', { lock: lockDir, owner: existing, waited_ms: waitedMs });
      }
      sleep(pollMs);
      waitedMs += pollMs;
    }
  }
}

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const optionNumber = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 0) fail(`${name} 必須是非負整數`);
  return value;
};
const root = fs.realpathSync(rootArg >= 0 ? args[rootArg + 1] : process.cwd());
const lockTimeoutMs = optionNumber('--lock-timeout-ms', 60000);
const lockPollMs = Math.max(10, optionNumber('--lock-poll-ms', 200));
const stateDir = path.join(root, 'orchestrator', 'runtime-preflight');
const lockDir = path.join(stateDir, '.lock');
fs.mkdirSync(stateDir, { recursive: true });

let lockOwner = null;
let lockWaitedMs = 0;
try {
  const acquired = acquireLock(lockDir, lockTimeoutMs, lockPollMs);
  lockOwner = acquired.owner;
  lockWaitedMs = acquired.waitedMs;
  const adapters = detect(root);
  const results = [];
  for (const adapter of adapters) {
    const version = versionOf(adapter, root);
    const current = fingerprint(adapter, root, version);
    const statePath = path.join(stateDir, `${adapter.id}.json`);
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
    if (previous && previous.fingerprint === current && previous.complete === true && projectionReady(adapter, root)) {
      results.push({ adapter: adapter.id, cache_hit: true, fingerprint: current, projection: adapter.projection });
      continue;
    }
    const startedAt = Date.now();
    let result = run(adapter.command, adapter.args, root, adapter.env);
    if (result.status === 0 && adapter.followup) result = run(adapter.followup.command, adapter.followup.args, root, adapter.env);
    const evidence = {
      adapter: adapter.id,
      cache_hit: false,
      fingerprint: current,
      projection: adapter.projection,
      command: [adapter.command, ...adapter.args].join(' '),
      exit_code: result.status,
      duration_ms: Date.now() - startedAt,
    };
    if (result.status !== 0) fail(`runtime-preflight adapter ${adapter.id} 失敗`, { evidence: { ...evidence, stderr_excerpt: String(result.stderr || '').trim().slice(-2000) } });
    if (!projectionReady(adapter, root)) fail(`adapter ${adapter.id} 完成但投影 ${adapter.projection} 不存在`, { evidence });
    fs.writeFileSync(statePath, JSON.stringify({ ...evidence, version, complete: true, completed_at: new Date().toISOString() }, null, 2) + '\n');
    results.push(evidence);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    cache_hit: results.every(r => r.cache_hit),
    lock_wait_ms: lockWaitedMs,
    adapters: results,
    ...(adapters.length ? {} : { reason: '未偵測到支援的 runtime manifest' }),
  }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, ...(error.evidence || {}) }) + '\n');
  process.exitCode = 1;
} finally {
  if (lockOwner) fs.rmSync(lockDir, { recursive: true, force: true });
}
