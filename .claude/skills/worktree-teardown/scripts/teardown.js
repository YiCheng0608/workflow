#!/usr/bin/env node
// teardown.js — 安全移除一個 task 的 worktree(worktree-setup 的逆操作)。
//
// 核心守則:用 **ground truth** 判斷「有沒有未提交的工作」,而不是靠 git 內建的 dirty 檢查。
// 原因:過程產物(triage / spec / closeout 等 .md 與 manifest.json,**約定一律放 orchestrator/ 底下**,
// 且已由 auto-commit 發進 journal/<scope>)永遠以 untracked 殘留,會讓 `git worktree remove`
// 一律拒絕——成功(已 commit、只剩過程噪音)與失敗(工作沒 commit)看起來一樣髒,git 分不出來。
// 所以本腳本自己算「未提交的工作」=`git status` 扣掉 orchestrator/(過程產物的約定目錄):
//   - 有未提交工作 → 拒絕移除(work 會遺失),除非 --force。
//   - 沒有 → 用 `--force` 跨過過程噪音安全移除(安全性已自行確認過)。
// 注意:orchestrator/ 以外的 .md(README、docs 等)**算未提交工作**,不算噪音——
// 它們不會進 journal,移除即遺失,所以一律觸發拒絕、由人決定。
//
// 移除 worktree **不刪分支**:feature 分支(含 commit)與孤兒 journal 分支預設都保留;
// 要刪 feature 分支用 --delete-branch(預設 `-d` 安全刪,未 merge 會拒絕)。
//
// 用法:
//   node teardown.js --branch feat/<scope> [--path <wt>] [--delete-branch]
//                    [--merged-into <branch>] [--delete-journal] [--force]
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(args, opts) { return execFileSync('git', args, { encoding: 'utf8', ...opts }).toString().trim(); }
function gitSafe(args, opts) { try { return { ok: true, out: git(args, opts) }; } catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString() }; } }
function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function fail(m) { process.stderr.write('✗ ' + m + '\n'); process.exit(1); }

// ── 解析參數 ──────────────────────────────────────────────
const a = process.argv.slice(2); const opt = {};
for (let i = 0; i < a.length; i++) {
  const k = a[i];
  if (k === '--branch') opt.branch = a[++i];
  else if (k === '--path') opt.path = a[++i];
  else if (k === '--merged-into') opt.mergedInto = a[++i];
  else if (k === '--delete-branch') opt.deleteBranch = true;
  else if (k === '--delete-journal') opt.deleteJournal = true;
  else if (k === '--force') opt.force = true;
  else fail(`非預期參數「${k}」`);
}
if (!opt.branch && !opt.path) fail('需要 --branch <feat/scope> 或 --path <worktree>');

// ── 定位 worktree ─────────────────────────────────────────
function worktrees() {
  const list = git(['worktree', 'list', '--porcelain']);
  return list.split('\n\n').map(blk => {
    let wt = null, br = null;
    for (const l of blk.split('\n')) {
      if (l.startsWith('worktree ')) wt = l.slice('worktree '.length);
      if (l.startsWith('branch ')) br = l.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    return wt ? { path: wt, branch: br } : null;
  }).filter(Boolean);
}
const wts = worktrees();
const target = opt.path
  ? wts.find(w => path.resolve(w.path) === path.resolve(opt.path))
  : wts.find(w => w.branch === opt.branch);
const branch = opt.branch || (target && target.branch);

if (!target) { // 已不在 → 冪等
  out({ removed: false, reason: 'no matching worktree (already removed?)', branch: branch || null });
  process.exit(0);
}

const scope = branch && branch.includes('/') ? branch.slice(branch.indexOf('/') + 1) : null;

// ── ground truth:未提交的工作 = porcelain 扣掉 orchestrator/(過程產物約定目錄)──
function pathOf(line) {
  let p = line.slice(2).trim();           // 去掉 XY 兩欄狀態碼
  const arrow = p.indexOf(' -> '); if (arrow >= 0) p = p.slice(arrow + 4); // rename 取目標
  return p.replace(/^"|"$/g, '');
}
const dirty = git(['status', '--porcelain'], { cwd: target.path }).split('\n').filter(l => l.trim());
const processNoise = [];
const uncommittedCode = dirty.filter(l => {
  const p = pathOf(l);
  if (p === 'orchestrator' || p.startsWith('orchestrator/')) { processNoise.push(p); return false; }
  return true;
});

if (uncommittedCode.length && !opt.force) {
  fail('worktree 有未提交的工作(移除會遺失),已拒絕。請先 commit,或確定要丟棄再加 --force:\n  '
    + uncommittedCode.map(pathOf).join('\n  '));
}

// ── 選用:是否已 merge 進指定分支 ──────────────────────────
// 用 merge-base --is-ancestor(exit 0 = branch 可從 target 達到 = 已 merge),
// 不靠解析 `git branch --merged`——那會被 worktree checkout 的 `+` 前綴等格式坑到。
let merged = null;
if (opt.mergedInto && branch) {
  merged = gitSafe(['merge-base', '--is-ancestor', branch, opt.mergedInto]).ok;
}

// ── 移除 worktree(--force 跨過 orchestrator/ 過程噪音;工作安全已確認)──
const rm = gitSafe(['worktree', 'remove', '--force', target.path]);
if (!rm.ok) fail(`git worktree remove 失敗:${rm.err}`);

// worktree-setup 會把 task worktree 放在 repo 同層的外層容器資料夾
// (例如 /path/repo.worktrees/<task>)。git worktree remove 只會移除 task
// 目錄，不會清掉空的外層容器；若已空，這裡一併安全移除。
const parentDir = path.dirname(target.path);
let parentDirRemoved = false;
let parentDirRemoveSkipReason = null;
try {
  if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
    fs.rmdirSync(parentDir);
    parentDirRemoved = true;
  } else {
    parentDirRemoveSkipReason = 'parent directory is not empty';
  }
} catch (e) {
  parentDirRemoveSkipReason = e.message;
}

// ── 選用:刪 feature 分支 ──────────────────────────────────
let branchDeleted = false, branchDeleteSkipReason = null;
if (opt.deleteBranch && branch) {
  if (opt.mergedInto && merged === false && !opt.force) {
    branchDeleteSkipReason = `分支尚未 merge 進 ${opt.mergedInto},保留(加 --force 可強刪)`;
  } else {
    const d = gitSafe(['branch', opt.force ? '-D' : '-d', branch]);
    if (d.ok) branchDeleted = true; else branchDeleteSkipReason = d.err.trim();
  }
}

// ── journal 分支:預設保留(它是持久審計紀錄)──────────────
const journalBranch = scope ? `journal/${scope}` : null;
let journalDeleted = false;
if (opt.deleteJournal && journalBranch) {
  journalDeleted = gitSafe(['branch', '-D', journalBranch]).ok;
}

out({
  removed: true, path: target.path, branch, scope,
  parentDir, parentDirRemoved, parentDirRemoveSkipReason,
  uncommittedCode: uncommittedCode.map(pathOf), processNoise, merged,
  branchDeleted, branchDeleteSkipReason,
  journalBranch, journalKept: !opt.deleteJournal, journalDeleted,
});
