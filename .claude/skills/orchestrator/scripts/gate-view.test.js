// gate-view.test.js — gate-view.js 的 regression(無框架,與 cli.test.js 同風格)。
// 驗渲染輸出含 gate 決策所需的關鍵事實:波次、no-judge / defer 標記、預設 full、結構紅燈。
// 跑法:node gate-view.test.js → 全綠 exit 0,任一失敗 exit 1。
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'gate-view.js');
const EXAMPLE = path.join(__dirname, '..', 'references', 'manifest.example.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-gate-view-test-'));
let seq = 0;

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
function writeJson(obj) {
  const p = path.join(tmp, `${seq++}-m.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, err: String(e.stderr || ''), out: String(e.stdout || '') };
  }
}

console.log('gate-view.js regression:');

test('example manifest:波次、人類 gate、no-judge / defer 標記都要出現在頁面上', () => {
  const r = run(EXAMPLE);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('第 1 波'), '要有波次分層');
  assert.ok(r.out.includes('第 3 波'), 'spec-4 依賴 spec-2/3,應落在第 3 波');
  assert.ok(r.out.includes('人類 gate(review_gate'), 'intake 的 review_gate 要標出');
  assert.ok(r.out.includes('no-judge 節點:spec-5'), 'no-judge 要收進警示清單');
  assert.ok(r.out.includes('defer-until-signal 節點:spec-2、spec-3'), 'defer 要收進警示清單');
  assert.ok(r.out.includes('先跑 test-2、test-3'), 'test 的 depends_on 排序要呈現');
});

test('review map 未列的 spec → 頁面標「預設 full」(fail-closed 呈現)', () => {
  const mp = writeJson({
    specs: {
      'spec-1': { id: 'spec-1', skill: 'worker', status: 'pending', depends_on: [], outputs: [], last_failure: null, fix_target: null },
    },
    tests: {},
    planning: { verification_map: [{ task: 'spec-1', verdict: 'no-judge', how: '主觀審', reason: 'x' }] },
    orchestration: { turn: 0, maxTurns: 30, noProgressK: 3, failSignals: [] },
  });
  const r = run(mp);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('review map 未列 → 預設 full'));
  assert.ok(r.out.includes('review map 未列:spec-1'));
});

test('defer 缺 requires_test / test 護欄 → 列進「凍結前必修」紅燈', () => {
  const mp = writeJson({
    specs: {
      'spec-1': { id: 'spec-1', skill: 'worker', status: 'pending', depends_on: [], outputs: [], last_failure: null, fix_target: null },
    },
    tests: {},
    planning: { review_map: [{ task: 'spec-1', risk: 'low', review_depth: 'defer-until-signal', split_reason: 'x', upgrade_triggers: [], reason: 'x' }] },
    orchestration: { turn: 0, maxTurns: 30, noProgressK: 3, failSignals: [] },
  });
  const r = run(mp);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('凍結前必修'));
  assert.ok(r.out.includes('requires_test'));
});

test('依賴成環 → 報「無法分層」;懸空 depends_on → 紅燈', () => {
  const mp = writeJson({
    specs: {
      'spec-1': { id: 'spec-1', skill: 'w', status: 'pending', depends_on: ['spec-2'], outputs: [], last_failure: null, fix_target: null },
      'spec-2': { id: 'spec-2', skill: 'w', status: 'pending', depends_on: ['spec-1'], outputs: [], last_failure: null, fix_target: null },
      'spec-3': { id: 'spec-3', skill: 'w', status: 'pending', depends_on: ['spec-ghost'], outputs: [], last_failure: null, fix_target: null },
    },
    tests: {},
    orchestration: { turn: 0, maxTurns: 30, noProgressK: 3, failSignals: [] },
  });
  const r = run(mp);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('無法分層'));
  assert.ok(r.out.includes('spec-ghost'));
});

test('manifest 讀不到 → exit 1', () => {
  const r = run(path.join(tmp, 'no-such.json'));
  assert.equal(r.code, 1);
});

console.log(`\n${pass} passed`);
