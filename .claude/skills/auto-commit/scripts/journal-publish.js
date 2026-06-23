#!/usr/bin/env node
// journal-publish.js — 把本次 flow 的過程產物 .md 發佈到一條「孤兒 journal 分支」。
//
// 為什麼要它:過程 md(triage / spec / scout / closeout、本站 result 與摘要)是審計
// 軌跡,要持久、可回看,但**不該進會 merge 回 dev 的 feature 分支**(否則每次 merge 都得
// 手動移除 md)。解法:把 md 提交到 `journal/<scope>`——一條與 feature 分支毫無交集、
// 永不 merge 的孤兒分支。每個 task 自己一條 `journal/<scope>`(per-scope ref),所以多個
// task 在同一 repo 平行時不會互撞、也不需 checkout(用底層 plumbing,不碰工作樹)。
//
// 用法:
//   node journal-publish.js --scope <scope> [--message <msg>] -- <md檔...>
//
// 輸出(stdout 一行 JSON;files 保留相對路徑,不同站同名檔不會互相覆蓋):
//   { "branch":"journal/dashboard", "commit":"<sha>",
//     "files":["dashboard/orchestrator/triage.md", ...], "parent":"<sha|null>" }
//
// 機制:hash-object 寫 blob → 暫時 index 累積(讀入既有 tip 以保留先前紀錄)→ write-tree
//        → commit-tree(有舊 tip 就接 parent)→ update-ref。全程不 checkout、不動工作樹。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function git(args, opts) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).toString().trim();
}
function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function fail(m) { process.stderr.write('✗ ' + m + '\n'); process.exit(1); }

// 保留相對路徑(以 cwd 為基準)當 journal tree 內的路徑,避免不同站的同名檔
// (summary.md / result.md)被 basename 壓平後互相覆蓋。路徑跳出 repo(.. / 絕對路徑
// relative 後仍以 .. 開頭)才退回 basename。git tree 一律用 posix 斜線。
function relPathFor(f) {
  let r = path.relative(process.cwd(), path.resolve(f));
  if (!r || r.startsWith('..')) r = path.basename(f);
  return r.split(path.sep).join('/');
}

// ── 解析參數(-- 之後全是檔案)─────────────────────────────
const argv = process.argv.slice(2);
const opt = { files: [] };
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '--scope') opt.scope = argv[++i];
  else if (k === '--message') opt.message = argv[++i];
  else if (k === '--') { opt.files = argv.slice(i + 1); break; }
  else fail(`非預期參數「${k}」(用 --scope/--message,檔案放 -- 之後)`);
}
if (!opt.scope) fail('--scope 必填');
if (!opt.files.length) fail('-- 之後沒有任何 md 檔');

const scope = opt.scope;
const branch = `journal/${scope}`;
const ref = `refs/heads/${branch}`;
const message = opt.message || `docs(${scope}): flow process record`;

for (const f of opt.files) if (!fs.existsSync(f)) fail(`檔案不存在:${f}`);

const tmpIndex = path.join(os.tmpdir(), `wf-journal-index-${process.pid}-${Math.abs(hash(scope))}`);
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
const gitEnv = Object.assign({}, process.env, { GIT_INDEX_FILE: tmpIndex });

try {
  // 既有 tip → 當 parent,並把它的 tree 讀進暫時 index(累積保留先前 records)
  let parent = null;
  try { parent = git(['rev-parse', '--verify', '--quiet', ref]); } catch (e) { parent = null; }
  if (parent) git(['read-tree', parent], { env: gitEnv });
  else { try { fs.unlinkSync(tmpIndex); } catch (e) {} } // 全新 → 空 index

  const added = [];
  for (const f of opt.files) {
    const sha = git(['hash-object', '-w', '--', f]);     // 寫 blob 進 object db
    const rel = `${scope}/${relPathFor(f)}`;             // scope 子資料夾下,保留相對路徑
    git(['update-index', '--add', '--cacheinfo', `100644,${sha},${rel}`], { env: gitEnv });
    added.push(rel);
  }

  const tree = git(['write-tree'], { env: gitEnv });
  const commitArgs = ['commit-tree', tree, '-m', message];
  if (parent) commitArgs.push('-p', parent);
  const commit = git(commitArgs, { env: gitEnv });
  git(['update-ref', ref, commit]);

  out({ branch, commit, files: added, parent: parent || null });
} catch (e) {
  fail(`journal 發佈失敗:${e.message}`);
} finally {
  try { fs.unlinkSync(tmpIndex); } catch (e) {}
}
