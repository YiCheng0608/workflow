'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'preflight.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-preflight-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi
mkdir -p node_modules
count=0
test -f install-count && count=$(cat install-count)
echo $((count + 1)) > install-count
`);
fs.chmodSync(path.join(bin, 'npm'), 0o755);

const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
function run(target = root) {
  const stdout = execFileSync(process.execPath, [SCRIPT, '--root', target], { encoding: 'utf8', env });
  return JSON.parse(stdout);
}

const first = run();
assert.equal(first.cache_hit, false);
assert.equal(fs.readFileSync(path.join(root, 'install-count'), 'utf8').trim(), '1');
const second = run();
assert.equal(second.cache_hit, true);
assert.equal(fs.readFileSync(path.join(root, 'install-count'), 'utf8').trim(), '1');
fs.appendFileSync(path.join(root, 'package-lock.json'), ' ');
const third = run();
assert.equal(third.cache_hit, false);
assert.equal(fs.readFileSync(path.join(root, 'install-count'), 'utf8').trim(), '2');

const failing = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-preflight-fail-'));
const failingBin = path.join(failing, 'bin');
fs.mkdirSync(failingBin);
fs.writeFileSync(path.join(failing, 'package-lock.json'), '{}\n');
fs.writeFileSync(path.join(failing, 'package.json'), '{}\n');
fs.writeFileSync(path.join(failingBin, 'npm'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10; exit 0; fi\nexit 7\n');
fs.chmodSync(path.join(failingBin, 'npm'), 0o755);
const failed = spawnSync(process.execPath, [SCRIPT, '--root', failing], {
  encoding: 'utf8', env: { ...process.env, PATH: `${failingBin}${path.delimiter}${process.env.PATH}` },
});
assert.notEqual(failed.status, 0);
assert.equal(fs.existsSync(path.join(failing, 'orchestrator/runtime-preflight/.lock')), false, '一般失敗也必須解鎖');

const lockDir = path.join(root, 'orchestrator/runtime-preflight/.lock');
fs.mkdirSync(lockDir);
fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483647, hostname: os.hostname(), created_at: new Date(0).toISOString() }));
assert.equal(run().ok, true, 'dead PID lock 應自動回收');

fs.mkdirSync(lockDir);
fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), created_at: new Date().toISOString() }));
const active = spawnSync(process.execPath, [SCRIPT, '--root', root, '--lock-timeout-ms', '50', '--lock-poll-ms', '10'], { encoding: 'utf8', env });
assert.notEqual(active.status, 0, 'active PID lock 等待逾時前不可被搶走');
assert.ok(JSON.parse(active.stdout).error.includes('逾時'));
assert.equal(fs.existsSync(lockDir), true, '拒絕搶鎖時不可刪除別人的 lock');
fs.rmSync(lockDir, { recursive: true, force: true });

const concurrent = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-preflight-concurrent-'));
const concurrentBin = path.join(concurrent, 'bin');
fs.mkdirSync(concurrentBin);
fs.writeFileSync(path.join(concurrent, 'package-lock.json'), '{}\n');
fs.writeFileSync(path.join(concurrent, 'package.json'), '{}\n');
fs.writeFileSync(path.join(concurrentBin, 'npm'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10; exit 0; fi\nsleep 1\nmkdir -p node_modules\n');
fs.chmodSync(path.join(concurrentBin, 'npm'), 0o755);
const concurrentEnv = { ...process.env, PATH: `${concurrentBin}${path.delimiter}${process.env.PATH}` };
const firstChild = require('child_process').spawn(process.execPath, [SCRIPT, '--root', concurrent], { encoding: 'utf8', env: concurrentEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const lockPath = path.join(concurrent, 'orchestrator/runtime-preflight/.lock');
for (let i = 0; i < 100 && !fs.existsSync(lockPath); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
const secondChild = spawnSync(process.execPath, [SCRIPT, '--root', concurrent, '--lock-timeout-ms', '3000', '--lock-poll-ms', '25'], { encoding: 'utf8', env: concurrentEnv });
assert.equal(secondChild.status, 0, secondChild.stderr || secondChild.stdout);
const concurrentResult = JSON.parse(secondChild.stdout);
assert.equal(concurrentResult.cache_hit, true, '等待前站完成後應直接 cache hit');
assert.ok(concurrentResult.lock_wait_ms > 0);
firstChild.kill();
console.log('runtime-preflight: 7 passed');
