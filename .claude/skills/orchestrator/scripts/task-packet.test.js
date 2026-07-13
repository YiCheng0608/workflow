'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const SCRIPT = path.join(__dirname, 'task-packet.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-packet-'));
const file = path.join(dir, 'packets.json');
fs.writeFileSync(file, JSON.stringify({ packets: { 'spec-2': {
  requirement_clauses: ['R1'], task: 'implement x', ownership: { allowed_outputs: ['src/x.js'] },
  completion: ['works'], verification: { verdict: 'machine' }, review: { depth: 'focused' },
} } }));
const packet = JSON.parse(execFileSync(process.execPath, [SCRIPT, file, 'spec-2'], { encoding: 'utf8' }));
assert.equal(packet.task, 'implement x');
assert.deepEqual(packet.requirement_clauses, ['R1']);
const missing = spawnSync(process.execPath, [SCRIPT, file, 'spec-9'], { encoding: 'utf8' });
assert.notEqual(missing.status, 0);
console.log('task-packet: 2 passed');
