#!/usr/bin/env node
// gate-view.js — 人類 gate 的呈現工具(唯讀,不改 manifest、不做 routing)。
// 把 manifest 渲染成一頁 Markdown:執行波次(任務圖)、每節點的裁判類型與審查深度、
// no-judge / defer 標記與升級訊號、警示清單。gate 要人確認的不是「引擎會不會跑」,
// 是「哪些節點沒有客觀裁判、哪些先延後 reviewer、哪些訊號會自動升級」——這支把散在
// manifest 各處的這些事實收成一頁,放大 gate 的頻寬。結構合法性仍以 cli.js validate 為準。
//
// 用法:node gate-view.js <manifest>   → Markdown 印到 stdout(manifest 讀不到才 exit 1)
'use strict';
const fs = require('fs');

function fail(msg) { process.stderr.write('✗ ' + msg + '\n'); process.exit(1); }

const manifestPath = process.argv[2];
if (!manifestPath) fail('用法: node gate-view.js <manifest>');
let m;
try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
catch (e) { fail(`讀不到或解析不了 manifest: ${manifestPath}\n${e.message}`); }

const specs = m.specs || {};
const tests = m.tests || {};
const planning = m.planning || {};
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const vmap = new Map((Array.isArray(planning.verification_map) ? planning.verification_map : []).filter(e => isObj(e) && e.task).map(e => [e.task, e]));
const rmap = new Map((Array.isArray(planning.review_map) ? planning.review_map : []).filter(e => isObj(e) && e.task).map(e => [e.task, e]));
const testsOf = id => Object.values(tests).filter(t => t.verifies === id);

const warns = [];   // gate 要人明確接受的事(不是錯,是決策)
const errs = [];    // 凍結前就該修的結構問題(cli.js validate 會擋,這裡先亮紅燈)

// ── 波次分層(Kahn):同一波 = depends_on 互相獨立、引擎可平行派工。分不完 = 成環。──
const remaining = new Set(Object.keys(specs));
const waves = [];
while (remaining.size) {
  const wave = [...remaining].filter(id => (specs[id].depends_on || []).every(d => !specs[d] || !remaining.has(d)));
  if (!wave.length) break;
  waves.push(wave);
  for (const id of wave) remaining.delete(id);
}
if (remaining.size) errs.push(`無法分層(依賴成環):${[...remaining].join('、')} — 先跑 cli.js validate 修結構`);

// ── 結構紅燈(與 validate 同源的廉價複查,gate 頁自帶,不用切出去跑指令才看到)──
for (const [id, s] of Object.entries(specs)) {
  for (const d of (s.depends_on || [])) if (!specs[d]) errs.push(`spec「${id}」depends_on 指向不存在的 spec「${d}」`);
  if (s.requires_test === true && !testsOf(id).length) errs.push(`spec「${id}」宣告 requires_test,但沒有任何 test verifies 它`);
}
for (const [id, t] of Object.entries(tests)) {
  if (!specs[t.verifies]) errs.push(`test「${id}」verifies 指向不存在的 spec「${t.verifies}」`);
}

// ── 每節點的裁判 / 審查描述 ────────────────────────────────────────────
function judgeLine(id) {
  const s = specs[id];
  if (s.review_gate === true) return '人類 gate(review_gate:產出後停下等使用者查看)';
  const v = vmap.get(id);
  if (!v) return '未列驗證地圖 ⚠';
  if (v.verdict === 'no-judge') return `**no-judge** ⚠ 無機器裁判 — ${v.how || '(未說明)'}`;
  return `${v.verdict} — ${v.how || '(未說明)'}`;
}
function reviewLine(id) {
  const s = specs[id];
  if (s.review_gate === true) return 'full(gate spec 固定對抗式 full)';
  const r = rmap.get(id);
  if (!r) return 'full(review map 未列 → 預設 full)';
  const parts = [];
  if (r.risk) parts.push(`risk:${r.risk}`);
  if (Array.isArray(r.upgrade_triggers) && r.upgrade_triggers.length) parts.push(`升級訊號:${r.upgrade_triggers.join(' / ')}`);
  const tail = parts.length ? `(${parts.join(';')})` : '';
  return r.review_depth === 'defer-until-signal'
    ? `**defer-until-signal** ⚠ produce 前不派 reviewer,靠 machine test 護欄${tail}`
    : `${r.review_depth}${tail}`;
}
function specLines(id) {
  const s = specs[id];
  const head = [`**${id}**(${s.skill}${s.tier ? `,tier:${s.tier}` : ''})`];
  if ((s.depends_on || []).length) head.push(`← ${s.depends_on.join('、')}`);
  if (s.status && s.status !== 'pending') head.push(`[status:${s.status}]`);
  const out = [`- ${head.join(' ')}`];
  out.push(`  - 裁判:${judgeLine(id)}`);
  out.push(`  - 審查:${reviewLine(id)}`);
  const ts = testsOf(id);
  if (ts.length) out.push(`  - test:${ts.map(t => `${t.id}(${t.kind},runner:${t.runner}${(t.depends_on || []).length ? `,先跑 ${t.depends_on.join('、')}` : ''})`).join('、')}`);
  const own = [];
  if (Array.isArray(s.allowed_outputs) && s.allowed_outputs.length) own.push(`allowed:${s.allowed_outputs.join(', ')}`);
  if (Array.isArray(s.forbid_outputs) && s.forbid_outputs.length) own.push(`forbid:${s.forbid_outputs.join(', ')}`);
  if (own.length) out.push(`  - ownership:${own.join(';')}`);
  return out;
}

// ── 警示彙整:no-judge / defer 是 gate 的核心決策點,獨立成清單再放大一次 ──────
const unmapped = Object.keys(specs).filter(id => specs[id].review_gate !== true && !vmap.has(id));
if (unmapped.length) warns.push(`驗證地圖未列:${unmapped.join('、')} —— 裁判方式不明`);
const noJudge = [...vmap.values()].filter(v => v.verdict === 'no-judge').map(v => v.task).filter(id => specs[id]);
if (noJudge.length) warns.push(`no-judge 節點:${noJudge.join('、')} —— 同意即接受這些節點沒有機器裁判,只剩 reviewer 主觀審`);
const defers = [...rmap.values()].filter(r => r.review_depth === 'defer-until-signal').map(r => r.task).filter(id => specs[id]);
for (const id of defers) {
  const s = specs[id];
  if (s.requires_test === true && testsOf(id).length) continue;
  errs.push(`spec「${id}」標 defer-until-signal 但缺 requires_test / test 護欄(沒有機器護欄不得略過 reviewer)`);
}
if (defers.length) warns.push(`defer-until-signal 節點:${defers.join('、')} —— 同意即接受這些節點 produce 前不派 reviewer,出事靠 test 訊號升級`);
const unlisted = Object.keys(specs).filter(id => specs[id].review_gate !== true && !rmap.has(id));
if (unlisted.length) warns.push(`review map 未列:${unlisted.join('、')} —— 一律預設 full reviewer(fail-closed,非漏審)`);

// ── 渲染 ────────────────────────────────────────────────────────────
const L = [];
L.push('# 人類 gate 檢視');
L.push('');
if (m.task) L.push(`> ${m.task}`);
L.push(`> 來源:${manifestPath};spec ${Object.keys(specs).length}、test ${Object.keys(tests).length}、maxTurns ${(m.orchestration || {}).maxTurns ?? '(未設)'}。本頁為唯讀渲染;凍結前請跑 cli.js validate。`);
L.push('');
L.push('## 任務圖(依 depends_on 分層;同一波可平行)');
L.push('');
waves.forEach((wave, i) => {
  L.push(`### 第 ${i + 1} 波(${wave.length} 個節點)`);
  for (const id of wave) L.push(...specLines(id));
  L.push('');
});
if (remaining.size) {
  for (const id of remaining) L.push(...specLines(id));
  L.push('');
}
if (errs.length) {
  L.push('## ✗ 凍結前必修(validate 也會擋)');
  L.push('');
  for (const e of errs) L.push(`- ✗ ${e}`);
  L.push('');
}
L.push('## ⚠ gate 要人明確接受的事');
L.push('');
if (warns.length) for (const w of warns) L.push(`- ⚠ ${w}`);
else L.push('- (無:所有節點都有機器裁判與 produce 前 reviewer)');
L.push('');
const envKeys = Object.keys(m.env || {});
if (envKeys.length || (m.env_patchable || []).length) {
  L.push('## env');
  L.push('');
  if (envKeys.length) L.push(`- 欄位:${envKeys.join('、')}`);
  if ((m.env_patchable || []).length) L.push(`- worker 可回寫(env_patchable):${m.env_patchable.join('、')}`);
  L.push('');
}
process.stdout.write(L.join('\n'));
