#!/usr/bin/env node
'use strict';
const fs = require('fs');
const [file, specId] = process.argv.slice(2);
if (!file || !specId) {
  process.stderr.write('用法: node task-packet.js <task-packets.json> <specId>\n');
  process.exit(1);
}
let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (error) { process.stderr.write(`讀不到或解析不了 task packets: ${error.message}\n`); process.exit(1); }
const packet = data && data.packets && data.packets[specId];
if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
  process.stderr.write(`task packets 沒有 spec「${specId}」\n`);
  process.exit(1);
}
for (const key of ['task', 'completion', 'verification', 'review']) {
  if (packet[key] === undefined) { process.stderr.write(`spec「${specId}」packet 缺少 ${key}\n`); process.exit(1); }
}
process.stdout.write(JSON.stringify({ spec: specId, ...packet }) + '\n');
