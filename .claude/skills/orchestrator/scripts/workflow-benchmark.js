#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const cli = path.resolve(valueOf('--cli', path.join(__dirname, 'cli.js')));
const profileArg = valueOf('--profile', 'all');
const runs = Number(valueOf('--runs', '3'));
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs 必須是正整數');
const profiles = profileArg === 'all' ? ['compact', 'light'] : [profileArg];
if (profiles.some(p => !['compact', 'light'].includes(p))) throw new Error('--profile 可用 compact / light / all');

function manifest(profile) {
  const count = profile === 'compact' ? 1 : 5;
  const specs = {};
  const tests = {};
  const review_map = [];
  for (let i = 1; i <= count; i++) {
    const id = `spec-${i}`;
    specs[id] = { id, skill: 'worker', status: 'pending', depends_on: [], outputs: [], last_failure: null, fix_target: null, requires_test: true };
    tests[`test-${i}`] = { id: `test-${i}`, verifies: id, runner: 'benchmark', kind: 'unit', status: 'pending', last_fail: null };
    review_map.push({ task: id, risk: 'low', review_depth: 'defer-until-signal', split_reason: 'benchmark', upgrade_triggers: [], reason: 'machine verified fixture' });
  }
  return { specs, tests, planning: { review_map }, env: {}, orchestration: { turn: 0, maxTurns: 100, noProgressK: 3, failSignals: [], leases: [] } };
}
function invoke(cwd, ...cliArgs) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...cliArgs], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
function oneRun(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `workflow-benchmark-${profile}-`));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest(profile), null, 2));
  const started = process.hrtime.bigint();
  while (true) {
    const decision = invoke(dir, 'next-all', manifestPath);
    if (decision.type === 'done') break;
    if (decision.type !== 'batch') throw new Error(`${profile} benchmark 意外停在 ${decision.type}`);
    for (const action of decision.actions) {
      const resultPath = path.join(dir, 'result.json');
      if (action.type === 'produce') {
        const output = `out/${action.spec}.txt`;
        fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
        fs.writeFileSync(path.join(dir, output), `${action.spec}\n`);
        fs.writeFileSync(resultPath, JSON.stringify({ ok: true, outputs: [output], review: { depth: 'defer-until-signal' } }));
        invoke(dir, 'produce', manifestPath, action.spec, resultPath);
      } else {
        fs.writeFileSync(resultPath, JSON.stringify({ pass: true, evidence: { command: 'benchmark', exit_code: 0, passed: 1, failed: 0 } }));
        invoke(dir, 'test', manifestPath, action.test, resultPath);
      }
    }
  }
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const metrics = invoke(dir, 'metrics', manifestPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return { wall_ms: wallMs, ...metrics };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const results = {};
for (const profile of profiles) {
  const samples = Array.from({ length: runs }, () => oneRun(profile));
  results[profile] = {
    runs,
    dispatched: samples[0].dispatched,
    completed: samples[0].completed,
    retries: samples[0].retries,
    median_wall_ms: median(samples.map(s => s.wall_ms)),
    samples_wall_ms: samples.map(s => Number(s.wall_ms.toFixed(3))),
  };
}
if (results.compact && results.light) {
  results.comparison = {
    dispatch_reduction: 1 - results.compact.dispatched / results.light.dispatched,
    completion_reduction: 1 - results.compact.completed / results.light.completed,
  };
}
process.stdout.write(JSON.stringify({ cli, proxy: 'engine actions only; not token usage', profiles: results }, null, 2) + '\n');
