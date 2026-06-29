// sim.js — 驅動器:用一個「劇本」跑 decide() 迴圈,把回頭機制印給你看。
// 這裡 produce / test 是「模擬 agent()」:真實情境每個都是 spawn 一個 subagent 跑 skill。
// 重點不是真的跑測試,而是讓你看清楚「大腦怎麼決策、test 掛了怎麼回頭」。
'use strict';
const { decide, applyProduce, applyTestResult, specForFailedTest, testsOf } = require('./decide');

// ── manifest:唯一事實來源(含 test↔spec 對照)──
const manifest = {
  specs: {
    'spec-1': { id: 'spec-1', skill: 'triage',  status: 'pending', depends_on: [],                     outputs: [], last_failure: null },
    'spec-2': { id: 'spec-2', skill: 'ui-spec',       status: 'pending', depends_on: ['spec-1'],             outputs: [], last_failure: null },
    'spec-3': { id: 'spec-3', skill: 'codebase-map',       status: 'pending', depends_on: ['spec-2'],             outputs: [], last_failure: null },
    'spec-4': { id: 'spec-4', skill: 'api-contract',         status: 'pending', depends_on: ['spec-3'],             outputs: [], last_failure: null },
    'spec-5': { id: 'spec-5', skill: 'implementation',  status: 'pending', depends_on: ['spec-3', 'spec-4'],   outputs: [], last_failure: null, requires_test: true },
    'spec-6': { id: 'spec-6', skill: 'delivery-note',      status: 'pending', depends_on: ['spec-5'],             outputs: [], last_failure: null },
  },
  // test↔spec 的對照表(方案 B):每個 test 標明它驗哪個 spec
  tests: {
    'test-unit': { id: 'test-unit', verifies: 'spec-5', runner: 'unit-tests', kind: 'unit', status: 'pending', last_fail: null },
    'test-e2e':  { id: 'test-e2e',  verifies: 'spec-5', runner: 'ui-e2e',  kind: 'e2e',  depends_on: ['test-unit'], status: 'pending', last_fail: null },
  },
};

// ── 劇本:模擬測試結果。unit 第一次掛(且判定是落地實作錯),修好後第二次過 ──
const attempts = {};
function oracle(testId) {
  attempts[testId] = (attempts[testId] || 0) + 1;
  if (testId === 'test-unit' && attempts[testId] === 1) {
    return {
      pass: false,
      altitude: 'code',
      reason: '送出 handler 沒有照 api-contract 組 payload → 回頭重做 implementation',
    };
  }
  return { pass: true };
}

// 註:produce 的狀態轉移已搬到 decide.js 的 applyProduce(),sim 與 cli 共用同一份。

function table() {
  return Object.values(manifest.specs)
    .map(s => `${s.id}:${s.status}`).join('  ') + '   ｜tests｜  ' +
    Object.entries(manifest.tests).map(([k, t]) => `${k}:${t.status}`).join('  ');
}

// ── 迴圈:大腦每回合讀 manifest 挑一步,直到 done 或被硬出口擋下 ──
const ctx = { turn: 0, maxTurns: 25, noProgressK: 3, failSignals: [] };
console.log('初始狀態:', table(), '\n');

while (true) {
  const action = decide(manifest, ctx);
  const tag = `回合 ${String(ctx.turn).padStart(2)}`;

  if (action.type === 'done') { console.log(`${tag} ✅ done — 全部 verified,交付完整成品`); break; }
  if (action.type === 'halt') { console.log(`${tag} ⛔ halt — ${action.reason}`); break; }

  if (action.type === 'produce') {
    console.log(`${tag} → produce ${action.spec}   (模擬 agent() 跑 ${manifest.specs[action.spec].skill})  ${action.reason ? '∵ ' + action.reason : ''}`);
    applyProduce(manifest, action.spec, { ok: true });
  }

  if (action.type === 'test') {
    const res = oracle(action.test);
    if (res.pass) {
      console.log(`${tag} → test ${action.test}  (驗 ${action.spec})  ✓ pass`);
    } else {
      const back = specForFailedTest(manifest, action.test);   // 機械式對應
      console.log(`${tag} → test ${action.test}  ✗ FAIL`);
      const target = res.blame || back;
      const altitude = res.altitude || res.verdict || 'code';
      console.log(`        ↳ 查對照表:${action.test} 驗的是 ${back};判定 [${altitude}錯] → 回頭重做 ${target}`);
      console.log(`        ↳ 原因:${res.reason}`);
      ctx.failSignals.push(`${target}:${altitude}`);
    }
    applyTestResult(manifest, action.test, res);
  }

  console.log(`        狀態:${table()}`);
  ctx.turn++;
}
