#!/usr/bin/env node
// worktree.js — 確定性建立「一個 task 一個隔離工作區」的 git worktree + 分支。
//
// 與 flow 無關、與 orchestrator 無關:只吃 type + scope,算出分支名 <type>/<scope>,
// 以指定 base(預設當前分支)為起點 `git worktree add` 出一個獨立目錄,讓多個 task
// 能在同一個 repo 同時跑而互不污染。全程 local,不碰 remote。
//
// 用法:
//   node worktree.js --type feat --scope dashboard [--base <branch>] [--root <dir>]
//
// 輸出(stdout 一行 JSON):
//   { "branch":"feat/dashboard", "path":"/abs/path", "base":"main",
//     "scope":"dashboard", "reused":false, "collision":false }
//
// 規則:
//   - 分支名 = <type>/<scope>(scope 已 sanitize 成合法 ref 片段)。
//   - collision:<type>/<scope> 已存在 → 加尾碼 -2/-3…;最終 scope 一併回傳,
//     讓下游(commit scope、journal/<scope>)用同一個值,保持一致。
//   - 冪等:若已有 worktree 掛在目標分支上 → 直接重用、回傳該路徑(reused:true)。
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

function git(args, opts) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).toString().trim();
}
function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function fail(m) { process.stderr.write('✗ ' + m + '\n'); process.exit(1); }

// ── 解析參數 ──────────────────────────────────────────────
const a = process.argv.slice(2);
const opt = {};
for (let i = 0; i < a.length; i++) {
  const k = a[i];
  if (!k.startsWith('--')) fail(`非預期參數「${k}」(用 --type/--scope/--base/--root)`);
  opt[k.slice(2)] = a[++i];
}
const type = opt.type;
if (!type) fail('--type 必填(feat / fix / refactor …)');
if (!opt.scope) fail('--scope 必填');

// ── sanitize scope 成合法、可讀的 ref 片段 ──────────────────
// 只清掉非法字元、不改大小寫:ticketId(PROJ-123)要保留大寫,kebab title 的小寫
// 由呼叫者(進入指令)在生成時就決定。腳本不替使用者改 casing。
function sanitize(s) {
  return String(s).trim()
    .replace(/[\s_]+/g, '-')            // 空白 / 底線 → -
    .replace(/[^A-Za-z0-9.\-/]/g, '')   // 只留 A-Z a-z 0-9 . - /(保留大小寫)
    .replace(/\/+/g, '-')               // scope 內不留巢狀 /
    .replace(/-+/g, '-')                // 連續 - 收斂
    .replace(/^[-.]+|[-.]+$/g, '');     // 去頭尾 - .
}
const scope0 = sanitize(opt.scope);
if (!scope0) fail('scope sanitize 後為空,請給有效 scope');

// ── repo 資訊 ─────────────────────────────────────────────
let repoRoot;
try { repoRoot = git(['rev-parse', '--show-toplevel']); }
catch (e) { fail('不在 git repo 裡'); }
const repoName = path.basename(repoRoot);
const repoParent = path.dirname(repoRoot);

const base = opt.base || git(['rev-parse', '--abbrev-ref', 'HEAD']);
// 提早驗證 base 存在,給清楚錯誤(否則錯誤要等到 git worktree add 才浮現)
if (opt.base) {
  try { git(['rev-parse', '--verify', '--quiet', opt.base + '^{commit}']); }
  catch (e) { fail(`--base「${opt.base}」不是存在的分支 / ref`); }
}
const root = opt.root || path.join(repoParent, repoName + '.worktrees');

// ── helpers ───────────────────────────────────────────────
function branchExists(b) {
  try { git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + b]); return true; }
  catch (e) { return false; }
}
function worktreeFor(branch) {
  const list = git(['worktree', 'list', '--porcelain']);
  for (const blk of list.split('\n\n')) {
    let wt = null, br = null;
    for (const l of blk.split('\n')) {
      if (l.startsWith('worktree ')) wt = l.slice('worktree '.length);
      if (l.startsWith('branch ')) br = l.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    if (br === branch) return wt;
  }
  return null;
}

// ── 算最終分支(處理冪等重用 + collision 尾碼)────────────────
let scope = scope0;
let branch = `${type}/${scope}`;

// 冪等:目標分支已有 worktree → 重用
const existing = worktreeFor(branch);
if (existing) {
  out({ branch, path: existing, base, scope, reused: true, collision: false });
  process.exit(0);
}
// collision:分支已存在(但沒掛 worktree)→ 加尾碼;尾碼分支若已掛 worktree 也重用
let n = 1;
while (branchExists(branch)) {
  n += 1;
  scope = `${scope0}-${n}`;
  branch = `${type}/${scope}`;
  const wt = worktreeFor(branch);
  if (wt) { out({ branch, path: wt, base, scope, reused: true, collision: true }); process.exit(0); }
}

// ── 建立 worktree + 新分支 ─────────────────────────────────
const wtPath = path.join(root, `${type}-${scope}`);
try {
  git(['worktree', 'add', '-b', branch, wtPath, base]);
} catch (e) {
  fail(`git worktree add 失敗:${e.message}`);
}
out({ branch, path: wtPath, base, scope, reused: false, collision: n > 1 });
