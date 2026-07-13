// decide.test.js — 純 node 斷言式 regression(無框架),驗 v2 引擎改動。
// 跑法:node decide.test.js  →  全綠 exit 0,任一失敗 exit 1。
// 覆蓋 e2e / clarify 路由的最小 regression cases。
'use strict';
const assert = require('assert');
const { decide, decideAll, applyProduce, applyTestResult, applyResume, applyResumeEnv, forbiddenOutputs, disallowedOutputs } = require('./decide');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// 一份小 manifest:triage(root) → spec → component(spec-4),component 掛 unit + e2e。
function fixture() {
  return {
    specs: {
      'spec-1': { id: 'spec-1', skill: 'triage', status: 'verified', depends_on: [],         outputs: [], last_failure: null, fix_target: null },
      'spec-2': { id: 'spec-2', skill: 'ui-spec',      status: 'verified', depends_on: ['spec-1'], outputs: [], last_failure: null, fix_target: null },
      'spec-4': { id: 'spec-4', skill: 'skeleton',  status: 'produced', depends_on: ['spec-2'], outputs: [], last_failure: null, fix_target: null },
    },
    tests: {
      'test-unit': { id: 'test-unit', verifies: 'spec-4', runner: 'unit-tests', kind: 'unit', status: 'pass',    last_fail: null },
      'test-e2e':  { id: 'test-e2e',  verifies: 'spec-4', runner: 'ui-e2e',  kind: 'e2e', depends_on: ['test-unit'], status: 'pending', last_fail: null },
    },
  };
}
const ctx = (over = {}) => ({ turn: 0, maxTurns: 30, noProgressK: 3, failSignals: [], ...over });

console.log('decide.js v2 regression:');

// 1. 舊格式相容:{pass:false, verdict:"spec"} → target=verifies、failed、fix_target spec、cascade
test('case1 舊 verdict:spec 相容', () => {
  const m = fixture();
  applyTestResult(m, 'test-unit', { pass: false, verdict: 'spec', reason: 'r' });
  assert.equal(m.specs['spec-4'].status, 'failed');
  assert.equal(m.specs['spec-4'].fix_target, 'spec');
});

// 2. 上游一跳:e2e {blame:"spec-2", altitude:"spec"} → spec-2 failed+cascade,不經 component 接力
test('case2 blame 上游一跳 + cascade', () => {
  const m = fixture();
  applyTestResult(m, 'test-e2e', { pass: false, blame: 'spec-2', altitude: 'spec', reason: '畫面與需求不符,根因在規格' });
  assert.equal(m.specs['spec-2'].status, 'failed', 'spec-2 應被直接歸咎');
  assert.equal(m.specs['spec-2'].fix_target, 'spec');
  assert.equal(m.specs['spec-4'].status, 'pending', 'spec-4 應被 cascade 退回重驗');
  assert.equal(m.tests['test-e2e'].status, 'pending', 'cascade 應重置下游 test');
});

// 3. 需求歧義:{altitude:"requirement"} → target blocked,decide 回 clarify
test('case3 requirement → blocked → clarify', () => {
  const m = fixture();
  applyTestResult(m, 'test-e2e', { pass: false, altitude: 'requirement', reason: '需求對此狀態未定義' });
  assert.equal(m.specs['spec-4'].status, 'blocked');
  assert.equal(m.specs['spec-4'].block_kind, 'requirement');
  const a = decide(m, ctx());
  assert.equal(a.type, 'clarify');
  assert.equal(a.spec, 'spec-4');
  assert.ok(a.question.includes('需求'));
});

// 4. 環境錯誤:{altitude:"environment"} → manifest 層級 block(m.block),不歸咎任何 spec
test('case4 environment → manifest-level block,不歸咎任何 spec', () => {
  const m = fixture();
  applyTestResult(m, 'test-e2e', { pass: false, altitude: 'environment', reason: 'app 起不來' });
  assert.ok(m.block, '應設 manifest 層級 m.block');
  assert.equal(m.block.kind, 'environment');
  assert.equal(m.block.test, 'test-e2e');
  assert.equal(m.specs['spec-4'].status, 'produced', '被測 spec 不應被改動成 blocked/failed');
  assert.equal(m.specs['spec-2'].status, 'verified', '上游不應被動到');
  const a = decide(m, ctx());
  assert.equal(a.type, 'clarify');
  assert.equal(a.kind, 'environment');
  assert.equal(a.test, 'test-e2e', 'clarify 指向跑不起來的 test,而非某個 spec');
});

// 5. blocked 優先於 produce/test
test('case5 blocked 優先', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'blocked';
  m.specs['spec-4'].clarify = '請確認 X';
  m.specs['spec-4'].block_kind = 'requirement';
  const a = decide(m, ctx());
  assert.equal(a.type, 'clarify');
  assert.equal(a.spec, 'spec-4');
});

// 6. resume:清 blocked、status pending、答覆進 last_failure、記錄 clarifications
test('case6 resume 續跑', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'blocked';
  m.specs['spec-1'].clarify = '需求 X 還是 Y?';
  m.specs['spec-1'].block_kind = 'requirement';
  applyResume(m, 'spec-1', { answer: '要 Y', reopen: 'pending' });
  assert.equal(m.specs['spec-1'].status, 'pending');
  assert.equal(m.specs['spec-1'].clarify, null);
  assert.equal(m.specs['spec-1'].last_failure, '要 Y');
  assert.equal(m.specs['spec-1'].clarifications.length, 1);
  assert.equal(m.specs['spec-1'].clarifications[0].answer, '要 Y');
});

// 7. 震盪 → clarify(不是 halt):同 {target,altitude} 達 K 次
test('case7 震盪轉 clarify(非 halt)', () => {
  const m = fixture();
  m.specs['spec-2'].status = 'failed';
  m.specs['spec-2'].last_failure = '反覆改不好';
  const a = decide(m, ctx({ failSignals: ['spec-2:spec', 'spec-2:spec', 'spec-2:spec'] }));
  assert.equal(a.type, 'clarify', '震盪應轉 clarify 而非 halt');
  assert.equal(a.kind, 'oscillation');
  assert.equal(a.spec, 'spec-2');
});

// 8. root 重做一次:未達 K 不觸發 → 允許重做;達 K 才 clarify
test('case8 未達 K 允許重做', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'failed';      // root 被回頭、altitude spec
  const a = decide(m, ctx({ failSignals: ['spec-1:spec', 'spec-1:spec'] }));  // 2 < K(3)
  assert.equal(a.type, 'produce', '未達震盪門檻應允許重做');
  assert.equal(a.spec, 'spec-1');
});

// 9. maxTurns 仍 halt(放棄),與震盪 clarify 區分
test('case9 maxTurns → halt', () => {
  const m = fixture();
  const a = decide(m, ctx({ turn: 30, maxTurns: 30 }));
  assert.equal(a.type, 'halt');
});

// 10. test depends_on 排序:unit 未過時 e2e 不被選;unit 過後才選 e2e
test('case10 e2e 排在 unit 之後', () => {
  const m = fixture();
  m.tests['test-unit'].status = 'pending';   // unit 尚未過
  let a = decide(m, ctx());
  assert.equal(a.type, 'test');
  assert.equal(a.test, 'test-unit', 'unit 未過時應先跑 unit,不跑 e2e');
  // unit 過了
  applyTestResult(m, 'test-unit', { pass: true });
  a = decide(m, ctx());
  assert.equal(a.test, 'test-e2e', 'unit 過後才輪到 e2e');
});

// 11. 全 test 過 → spec verified → done
test('case11 全過 → verified → done', () => {
  const m = fixture();
  applyTestResult(m, 'test-unit', { pass: true });
  applyTestResult(m, 'test-e2e', { pass: true });
  assert.equal(m.specs['spec-4'].status, 'verified');
  assert.equal(decide(m, ctx()).type, 'done');
});

// 12. decideAll 也遵守 blocked 優先與 testDepsMet
test('case12 decideAll blocked 優先', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'blocked';
  m.specs['spec-4'].clarify = 'X?';
  const a = decideAll(m, ctx());
  assert.equal(a.type, 'clarify');
  assert.deepEqual(a.actions, []);
});

// 13. environment resume:清 m.block、test 退回 pending 重跑,spec 不動,decide 重新選到該 e2e
test('case13 environment resume 只重跑 test、不重做 spec', () => {
  const m = fixture();
  applyTestResult(m, 'test-e2e', { pass: false, altitude: 'environment', reason: 'app 起不來' });
  applyResumeEnv(m, { answer: '已修好啟動指令' });
  assert.equal(m.block, null, 'm.block 應被清除');
  assert.equal(m.tests['test-e2e'].status, 'pending', 'test 退回 pending 重跑');
  assert.equal(m.specs['spec-4'].status, 'produced', 'spec 不應被重做');
  assert.equal(m.tests['test-e2e'].clarifications.length, 1, '答覆應記在 test.clarifications');
  const a = decide(m, ctx());
  assert.equal(a.type, 'test');
  assert.equal(a.test, 'test-e2e', 'decide 應重新選到 e2e(produced + pendingTest)');
});

// 14. decideAll 也尊重 manifest 層級 block(environment)
test('case14 decideAll 尊重 m.block', () => {
  const m = fixture();
  m.block = { kind: 'environment', test: 'test-e2e', question: 'app 起不來' };
  const a = decideAll(m, ctx());
  assert.equal(a.type, 'clarify');
  assert.equal(a.kind, 'environment');
  assert.deepEqual(a.actions, []);
});

// 15. 產出守門:落地 spec 宣告 forbid_outputs,produce 命中 → 改判 code 失敗回頭重做,不記成功
test('case15 forbid_outputs 命中 → code 失敗回頭', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'pending';
  m.specs['spec-4'].forbid_outputs = ['*.test.*', '*.spec.*', '*__tests__*'];
  applyProduce(m, 'spec-4', { ok: true, outputs: ['src/Foo.jsx', 'src/Foo.test.jsx'] });
  assert.equal(m.specs['spec-4'].status, 'failed', '命中禁止樣式應改判 failed');
  assert.equal(m.specs['spec-4'].fix_target, 'code');
  assert.ok(m.specs['spec-4'].last_failure.includes('Foo.test.jsx'), 'last_failure 應指出越界檔');
  // failed → decide 規則 1 會回頭重做(依賴已 verified)
  assert.equal(decide(m, ctx()).type, 'produce');
});

// 16. 產出守門:未命中(只產合法檔)→ 照常成功;沒宣告 forbid_outputs 的 spec 不受影響
test('case16 forbid_outputs 未命中 / 未宣告 → 照常成功', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'pending';
  m.specs['spec-4'].forbid_outputs = ['*.test.*', '*.spec.*'];
  applyProduce(m, 'spec-4', { ok: true, outputs: ['src/Foo.jsx', 'src/useFoo.js'] });
  assert.equal(m.specs['spec-4'].status, 'produced', '合法產出應照常 produced');
  // 未宣告 forbid_outputs 的 spec:就算產測試檔也不擋(守門是宣告式,非全域)
  const m2 = fixture();
  m2.specs['spec-4'].status = 'pending';
  applyProduce(m2, 'spec-4', { ok: true, outputs: ['src/Foo.test.jsx'] });
  assert.equal(m2.specs['spec-4'].status, 'produced', '未宣告 forbid_outputs 不應被擋');
});

// 17. forbiddenOutputs helper:* 跨路徑、其餘字面比對
test('case17 forbiddenOutputs 樣式比對', () => {
  const spec = { forbid_outputs: ['*.test.*', '*__tests__*'] };
  assert.deepEqual(forbiddenOutputs(spec, ['a/b/Foo.test.tsx']), ['a/b/Foo.test.tsx']);
  assert.deepEqual(forbiddenOutputs(spec, ['src/__tests__/Foo.js']), ['src/__tests__/Foo.js']);
  assert.deepEqual(forbiddenOutputs(spec, ['src/Foo.jsx']), [], '合法檔不命中');
  assert.deepEqual(forbiddenOutputs({}, ['Foo.test.js']), [], '未宣告樣式 → 空');
});

// 18. 產出守門:宣告 allowed_outputs,produce 回報白名單外檔案 → 改判 code 失敗
test('case18 allowed_outputs 命中白名單外檔案 → code 失敗回頭', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'pending';
  m.specs['spec-4'].allowed_outputs = ['src/layout/Sidebar.tsx', 'orchestrator/*'];
  applyProduce(m, 'spec-4', { ok: true, outputs: ['src/layout/Sidebar.tsx', 'src/layout/Header.tsx'] });
  assert.equal(m.specs['spec-4'].status, 'failed', '白名單外檔案應改判 failed');
  assert.equal(m.specs['spec-4'].fix_target, 'code');
  assert.ok(m.specs['spec-4'].last_failure.includes('Header.tsx'), 'last_failure 應指出越界檔');
  assert.equal(decide(m, ctx()).type, 'produce');
});

// 19. disallowedOutputs helper:只回傳白名單外檔案;未宣告則不擋
test('case19 disallowedOutputs 樣式比對', () => {
  const spec = { allowed_outputs: ['src/layout/*', 'orchestrator/*'] };
  assert.deepEqual(disallowedOutputs(spec, ['src/layout/Sidebar.tsx', 'orchestrator/impl.md']), []);
  assert.deepEqual(disallowedOutputs(spec, ['src/layout/Sidebar.tsx', 'src/routes.tsx']), ['src/routes.tsx']);
  assert.deepEqual(disallowedOutputs({}, ['src/routes.tsx']), [], '未宣告白名單 → 空');
});

// 20. review gate:produce 成功但 spec 宣告 review_gate → blocked(kind:'review'),decide 轉 clarify 全域停
test('case20 review_gate 產出成功 → blocked(review) → clarify', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'pending';
  m.specs['spec-1'].review_gate = true;
  m.specs['spec-2'].status = 'pending';
  m.specs['spec-4'].status = 'pending';
  applyProduce(m, 'spec-1', { ok: true, outputs: ['orchestrator/triage.md'] });
  assert.equal(m.specs['spec-1'].status, 'blocked', '產出成功應停在 blocked,不進 verified');
  assert.equal(m.specs['spec-1'].block_kind, 'review');
  assert.deepEqual(m.specs['spec-1'].outputs, ['orchestrator/triage.md'], 'outputs 照記,供使用者查看');
  const a = decide(m, ctx());
  assert.equal(a.type, 'clarify');
  assert.equal(a.kind, 'review');
  assert.equal(a.spec, 'spec-1');
  assert.ok(a.question.includes('triage.md'), 'clarify 應帶產出檔路徑');
  const all = decideAll(m, ctx());
  assert.equal(all.type, 'clarify', 'decideAll 同樣全域停');
  assert.deepEqual(all.actions, []);
});

// 19. review gate 同意:resume {approve:true} → 不重做、不 cascade,接回 produced/verified
test('case19 review approve → verified(無 test)/ produced(有 test),續跑下游', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'pending';
  m.specs['spec-1'].review_gate = true;
  m.specs['spec-2'].status = 'pending';
  m.specs['spec-4'].status = 'pending';
  applyProduce(m, 'spec-1', { ok: true, outputs: ['orchestrator/triage.md'] });
  applyResume(m, 'spec-1', { approve: true });
  assert.equal(m.specs['spec-1'].status, 'verified', '無 test 的 gated spec 同意後直接 verified');
  assert.equal(m.specs['spec-1'].clarify, null);
  assert.equal(m.specs['spec-1'].clarifications[0].kind, 'review');
  const a = decide(m, ctx());
  assert.equal(a.type, 'produce');
  assert.equal(a.spec, 'spec-2', '同意後 decide 續跑下游');
  // 有 test 的 gated spec:同意後進 produced 等驗證
  const m2 = fixture();
  m2.specs['spec-4'].status = 'pending';
  m2.specs['spec-4'].review_gate = true;
  m2.tests['test-unit'].status = 'pending';
  applyProduce(m2, 'spec-4', { ok: true, outputs: ['src/Foo.jsx'] });
  applyResume(m2, 'spec-4', { approve: true });
  assert.equal(m2.specs['spec-4'].status, 'produced', '有 test 的 gated spec 同意後進 produced 等驗證');
  assert.equal(decide(m2, ctx()).type, 'test');
});

// 20. review gate 要求修改:resume 帶意見 → 一般 reopen 重做,重做成功後再次 gate
test('case20 review 修改意見 → 重做 → 再次 gate', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'pending';
  m.specs['spec-1'].review_gate = true;
  m.specs['spec-2'].status = 'pending';
  m.specs['spec-4'].status = 'pending';
  applyProduce(m, 'spec-1', { ok: true, outputs: ['orchestrator/triage.md'] });
  applyResume(m, 'spec-1', { answer: '範圍漏了行動裝置版,請補進「做什麼」' });
  assert.equal(m.specs['spec-1'].status, 'pending', '帶修改意見應 reopen 重做');
  assert.equal(m.specs['spec-1'].last_failure, '範圍漏了行動裝置版,請補進「做什麼」', '意見成為重做輸入');
  const a = decide(m, ctx());
  assert.equal(a.type, 'produce');
  assert.equal(a.spec, 'spec-1');
  applyProduce(m, 'spec-1', { ok: true, outputs: ['orchestrator/triage.md'] });
  assert.equal(m.specs['spec-1'].status, 'blocked', '重做成功後應再次 gate');
  assert.equal(m.specs['spec-1'].block_kind, 'review');
});

// 21. 未宣告 review_gate 的 spec 行為不變(produce 成功直接 produced/verified)
test('case21 未宣告 review_gate → 行為不變', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'pending';
  m.specs['spec-2'].status = 'pending';
  m.specs['spec-4'].status = 'pending';
  applyProduce(m, 'spec-1', { ok: true, outputs: ['orchestrator/triage.md'] });
  assert.equal(m.specs['spec-1'].status, 'verified');
});

// 22. produce 往前 blame 可明示 fix_target:'code'(上游產物格式壞掉等 code 層問題);未明示預設 spec
test('case22 produce blame 上游 + fix_target 可明示 code、預設 spec', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'pending';
  applyProduce(m, 'spec-4', { ok: false, blame: 'spec-2', reason: 'spec-2 的輸出檔格式壞掉讀不了', fix_target: 'code' });
  assert.equal(m.specs['spec-2'].status, 'failed', '上游應被歸咎');
  assert.equal(m.specs['spec-2'].fix_target, 'code', '明示 code 應採用,不再強制 spec');
  assert.equal(m.specs['spec-4'].status, 'pending', '自己退回 pending 等上游修好');
  const m2 = fixture();
  m2.specs['spec-4'].status = 'pending';
  applyProduce(m2, 'spec-4', { ok: false, blame: 'spec-2', reason: '需求範圍漏了 X' });
  assert.equal(m2.specs['spec-2'].fix_target, 'spec', '未明示仍預設 spec(語意錯居多)');
});

// 23. 鎖住「同步退化相容」:decideAll 的第一個 action 必須與 decide 的單一 action 完全一致。
//     SKILL.md / decide.js 都聲稱「batch.actions[0] === next 的回傳」,但那靠兩邊同序 + 同優先序維持,
//     是隱性耦合。把它變成測試不變式:任一邊改了排序而沒同步改另一邊 → 這裡立刻紅。
test('case23 decideAll[0] ≡ decide(鎖排序耦合)', () => {
  const states = [];
  // (a) 有 failed spec 待重做(規則 1 優先)
  { const m = fixture(); m.specs['spec-2'].status = 'failed'; states.push(['failed', m]); }
  // (b) 有 produced spec 待驗(預設 fixture:spec-4 produced + test-e2e pending)
  states.push(['toTest', fixture()]);
  // (c) 只有 ready 的 pending spec(無 failed、無待驗 test)
  { const m = fixture(); m.specs['spec-4'].status = 'pending'; states.push(['ready', m]); }
  for (const [label, m] of states) {
    const single = decide(m, ctx());
    const batch = decideAll(m, ctx());
    assert.equal(batch.type, 'batch', `${label}: 應為 batch`);
    assert.deepEqual(batch.actions[0], single, `${label}: decideAll[0] 必與 decide 一致`);
  }
});

test('case24 next-all limit 截斷批次但保留 total_ready', () => {
  const m = fixture();
  m.specs['spec-a'] = { id: 'spec-a', skill: 'w', status: 'pending', depends_on: [], outputs: [], last_failure: null, fix_target: null };
  m.specs['spec-b'] = { id: 'spec-b', skill: 'w', status: 'pending', depends_on: [], outputs: [], last_failure: null, fix_target: null };
  const batch = decideAll(m, ctx(), { limit: 1 });
  assert.equal(batch.actions.length, 1);
  assert.ok(batch.total_ready >= 3);
});

test('case25 同 spec tests 只有 parallel_safe 且 resource 不衝突才平行', () => {
  const m = fixture();
  m.tests['test-unit'].status = 'pending';
  m.tests['test-e2e'].depends_on = [];
  m.tests['test-unit'].parallel_safe = true;
  m.tests['test-unit'].resource_keys = ['cpu'];
  m.tests['test-e2e'].parallel_safe = true;
  m.tests['test-e2e'].resource_keys = ['browser'];
  let batch = decideAll(m, ctx());
  assert.equal(batch.actions.filter(a => a.type === 'test').length, 2);
  m.tests['test-e2e'].resource_keys = ['cpu'];
  batch = decideAll(m, ctx());
  assert.equal(batch.actions.filter(a => a.type === 'test').length, 1, 'resource 衝突應序列化');
});

test('case26 produce 成功持久化 deleted，重做會覆寫舊值', () => {
  const m = fixture();
  applyProduce(m, 'spec-4', { ok: true, outputs: ['src/Foo.jsx'], deleted: ['src/app.js'] });
  assert.deepEqual(m.specs['spec-4'].deleted, ['src/app.js']);
  m.specs['spec-4'].status = 'failed';
  applyProduce(m, 'spec-4', { ok: true, outputs: ['src/Foo.jsx'] });
  assert.deepEqual(m.specs['spec-4'].deleted, []);
});

test('case27 review_gate 重做合併 changed outputs 與 retained outputs', () => {
  const m = fixture();
  m.specs['spec-1'].review_gate = true;
  m.specs['spec-1'].status = 'pending';
  m.specs['spec-1'].outputs = ['orchestrator/intake-verification.md'];
  applyProduce(m, 'spec-1', {
    ok: true,
    outputs: ['orchestrator/intake-tasks.md'],
    retained_outputs: ['orchestrator/intake-verification.md'],
  });
  assert.deepEqual(m.specs['spec-1'].outputs, [
    'orchestrator/intake-tasks.md',
    'orchestrator/intake-verification.md',
  ]);
});

test('case28 非 review_gate spec 忽略 retained_outputs,不合併進 outputs', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'pending';
  m.specs['spec-1'].outputs = ['orchestrator/intake-verification.md'];
  applyProduce(m, 'spec-1', {
    ok: true,
    outputs: ['orchestrator/intake-tasks.md'],
    retained_outputs: ['orchestrator/intake-verification.md'],
  });
  assert.deepEqual(m.specs['spec-1'].outputs, ['orchestrator/intake-tasks.md']);
});

console.log(`\n${pass} passed`);
