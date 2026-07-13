#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const skillRoot = path.join(root, '.claude', 'skills');

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function assertSymlink(relativePath, target) {
  const file = path.join(root, relativePath);
  if (!fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file) !== target) {
    throw new Error(`${relativePath} 必須是指向 ${target} 的 symlink`);
  }
}

const scripts = filesUnder(skillRoot)
  .filter(file => file.endsWith('.js'))
  .sort();
const tests = scripts.filter(file => file.endsWith('.test.js'));

assertSymlink('AGENTS.md', 'CLAUDE.md');
assertSymlink(path.join('.agents', 'skills'), path.join('..', '.claude', 'skills'));
runCommand('bash', ['-n', 'install.sh']);
for (const file of scripts) run(['--check', file]);
for (const file of tests) run([file]);

process.stdout.write(`check: symlinks, install.sh, ${scripts.length} JavaScript files, ${tests.length} test files passed\n`);
