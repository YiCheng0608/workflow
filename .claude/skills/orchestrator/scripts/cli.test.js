// cli.test.js — cli.js 層的 regression(無框架),補 decide.test.js 沒蓋到的 adapter 邏輯:
// failSignals 組裝(target-first)、guardRejected 偵測、env_patch 合併、result.json schema 驗證、
// validate(懸空參照 / spec 環 / test 環)。跑法:node cli.test.js → 全綠 exit 0,任一失敗 exit 1。
// 實際 spawn cli.js 對 tmp 目錄下的 manifest 操作,驗的是「agent 真正會走的那條路」。
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cli-test-'));
let seq = 0;

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

function writeJson(name, obj) {
  const p = path.join(tmp, `${seq++}-${name}`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
// 跑 cli:成功回 { code:0, out:<stdout JSON> },失敗回 { code:非0, err:<stderr> }
// cwd 預設在 tmp(非 git repo → 未申報修改硬驗自動跳過);未申報修改的測試用 runIn 指定 git repo。
// cli 會對 outputs 做磁碟存在性驗證,宣稱的檔要相對於執行目錄真的存在。
function runIn(cwd, ...args) {
  try {
    // stderr 用 pipe 捕捉(預設 inherit 會把預期中的「✗ 不合法」噪音漏到測試輸出)
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.status, err: String(e.stderr || ''), stdout: String(e.stdout || '') };
  }
}
const run = (...args) => runIn(tmp, ...args);
// outputs 存在性守門:測試裡宣稱的產出檔要先真的寫到 tmp 磁碟
function touch(rel) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '// stub\n');
  return rel;
}
['src/Foo.jsx', 'src/Foo.test.jsx', 'src/layout/Sidebar.tsx', 'src/layout/Header.tsx', 'orchestrator/triage.md', 'orchestrator/review.md'].forEach(touch);
// unit test 報 pass 時的合法實跑證據(引擎要求 command / exit_code:0 / 計數)
const EV_PASS = { command: 'vitest run', exit_code: 0, passed: 5, failed: 0 };
// produce 成功記回的合法 review 欄位(full 需附落盤的 reviewer 結論檔)
const REVIEW = { depth: 'full', record: 'orchestrator/review.md' };

// 與 decide.test.js 同形的小 manifest,外加 cli 需要的 orchestration 區塊。
function fixture(over = {}) {
  return Object.assign({
    specs: {
      'spec-1': { id: 'spec-1', skill: 'triage', status: 'verified', depends_on: [],         outputs: [], last_failure: null, fix_target: null },
      'spec-2': { id: 'spec-2', skill: 'ui-spec',      status: 'verified', depends_on: ['spec-1'], outputs: [], last_failure: null, fix_target: null },
      'spec-4': { id: 'spec-4', skill: 'skeleton',  status: 'pending',  depends_on: ['spec-2'], outputs: [], last_failure: null, fix_target: null },
    },
    tests: {
      'test-unit': { id: 'test-unit', verifies: 'spec-4', runner: 'unit-tests', kind: 'unit', status: 'pending', last_fail: null },
    },
    env: {},
    // leases 預發派本 fixture 會用到的 action(等同已跑過 next-all);lease 機制本身另有專測。
    orchestration: { turn: 0, maxTurns: 30, noProgressK: 3, failSignals: [],
                     leases: ['produce:spec-1', 'produce:spec-2', 'produce:spec-4', 'test:test-unit'] },
  }, over);
}

console.log('cli.js regression:');

// ── produce:記回與訊號 ──────────────────────────────────────────

test('produce 成功:outputs 記回、turn+1、failSignals 清空', () => {
  const m = fixture();
  m.orchestration.failSignals = ['spec-4:code'];   // 殘留的震盪窗口
  const mp = writeJson('m.json', m);
  const rp = writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW });
  const r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'produced');
  const after = readJson(mp);
  assert.deepEqual(after.specs['spec-4'].outputs, ['src/Foo.jsx']);
  assert.equal(after.orchestration.turn, 1);
  assert.deepEqual(after.orchestration.failSignals, [], '成功 = 有進度,窗口應清空');
});

test('produce 成功:只清「自己」的 failSignal,別 target 的震盪訊號保留(per-target,平行安全)', () => {
  const m = fixture();
  // 兩個 target 各自累積中:spec-4 是這次要產的,spec-2 是別處正在震盪的
  m.orchestration.failSignals = ['spec-2:spec', 'spec-4:code', 'spec-2:spec'];
  const mp = writeJson('m.json', m);
  const r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW }));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readJson(mp).orchestration.failSignals, ['spec-2:spec', 'spec-2:spec'],
    'spec-4 的進度只清 spec-4 的訊號;spec-2 的震盪證據不可被洗掉');
});

test('produce 失敗(自己):failSignal = <spec>:<fix_target>(target-first)', () => {
  const mp = writeJson('m.json', fixture());
  const rp = writeJson('r.json', { ok: false, reason: '骨架產不出來', fix_target: 'code' });
  const r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.failed, true);
  const after = readJson(mp);
  assert.equal(after.specs['spec-4'].status, 'failed');
  assert.deepEqual(after.orchestration.failSignals, ['spec-4:code']);
});

test('produce 失敗(blame 上游):failSignal 以上游為 target、上游 failed、自己退 pending', () => {
  const mp = writeJson('m.json', fixture());
  const rp = writeJson('r.json', { ok: false, blame: 'spec-2', reason: '規格漏了 X' });
  const r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.blame, 'spec-2');
  const after = readJson(mp);
  assert.equal(after.specs['spec-2'].status, 'failed');
  assert.equal(after.specs['spec-4'].status, 'pending');
  assert.deepEqual(after.orchestration.failSignals, ['spec-2:blame'], '訊號 target-first,terminationGuard 才取得到正確 target');
});

test('produce 守門(forbid_outputs):rejected 揭露 + failSignal 照記', () => {
  const m = fixture();
  m.specs['spec-4'].forbid_outputs = ['*.test.*'];
  const mp = writeJson('m.json', m);
  const rp = writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx', 'src/Foo.test.jsx'], review: REVIEW });
  const r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.rejected, 'output_guard');
  assert.ok(r.out.reason.includes('Foo.test.jsx'));
  const after = readJson(mp);
  assert.equal(after.specs['spec-4'].status, 'failed');
  assert.deepEqual(after.orchestration.failSignals, ['spec-4:code'], '越界也是失敗,要進震盪窗口');
});

test('produce 守門(allowed_outputs):白名單外產出 rejected + failSignal 照記', () => {
  const m = fixture();
  m.specs['spec-4'].allowed_outputs = ['src/layout/Sidebar.tsx', 'orchestrator/*'];
  const mp = writeJson('m.json', m);
  const rp = writeJson('r.json', { ok: true, outputs: ['src/layout/Sidebar.tsx', 'src/layout/Header.tsx'], review: REVIEW });
  const r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.rejected, 'output_guard');
  assert.ok(r.out.reason.includes('Header.tsx'));
  const after = readJson(mp);
  assert.equal(after.specs['spec-4'].status, 'failed');
  assert.deepEqual(after.orchestration.failSignals, ['spec-4:code'], '白名單越界也是失敗,要進震盪窗口');
});

// ── produce:schema 驗證(擋下時 manifest 不動、回合不增)──────────

test('produce 驗證:fix_target 打錯字 → exit 1、manifest 不動', () => {
  const mp = writeJson('m.json', fixture());
  const rp = writeJson('r.json', { ok: false, reason: 'x', fix_target: 'speling' });
  const r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 1, '應 exit 1');
  assert.ok(r.err.includes('fix_target'));
  const after = readJson(mp);
  assert.equal(after.specs['spec-4'].status, 'pending', 'manifest 不應被污染');
  assert.equal(after.orchestration.turn, 0, '回合不應增加');
});

test('produce 驗證:blame 指向不存在的 spec / 指向自己 → exit 1', () => {
  const mp = writeJson('m.json', fixture());
  let r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: false, blame: 'spec-99', reason: 'x' }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('spec-99'));
  r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: false, blame: 'spec-4', reason: 'x' }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('不可指向自己'));
});

test('produce 驗證:outputs 不是 string 陣列 → exit 1', () => {
  const mp = writeJson('m.json', fixture());
  const r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: 'src/Foo.jsx' }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('outputs'));
});

// ── test:記回、訊號與 env_patch ─────────────────────────────────

test('test 通過:turn+1、failSignals 清空', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  m.orchestration.failSignals = ['spec-4:code'];
  const mp = writeJson('m.json', m);
  const r = run('test', mp, 'test-unit', writeJson('r.json', { pass: true, evidence: EV_PASS }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.pass, true);
  const after = readJson(mp);
  assert.equal(after.specs['spec-4'].status, 'verified');
  assert.deepEqual(after.orchestration.failSignals, []);
});

test('test 失敗(code):go_back_to + failSignal = <target>:<altitude>', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  const r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, altitude: 'code', reason: '接線錯' }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.go_back_to, 'spec-4');
  assert.deepEqual(readJson(mp).orchestration.failSignals, ['spec-4:code']);
});

test('test 失敗(requirement)帶 evidence.failed=0 → 不誤判「計數矛盾」(requirement 無斷言可計)', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  // requirement 失敗:需求欠明確,沒有真跑斷言 → failed=0 是合理的,不該被當「計數與結果矛盾」擋下
  const r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, altitude: 'requirement', reason: '需求未定義此狀態', evidence: { failed: 0 } }));
  assert.equal(r.code, 0, r.err);
  assert.equal(readJson(mp).specs['spec-4'].status, 'blocked', 'requirement → spec 標 blocked');
});

test('test 失敗(environment):m.block、failSignal 以 test 為 target', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  const r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, altitude: 'environment', reason: 'runner 起不來' }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.blocked, true);
  const after = readJson(mp);
  assert.equal(after.block.test, 'test-unit');
  assert.deepEqual(after.orchestration.failSignals, ['test-unit:environment']);
});

test('test 的 env_patch:pass / fail 都合併進 manifest.env', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  m.env = { e2eReady: true };
  const mp = writeJson('m.json', m);
  const rp = writeJson('r.json', { pass: true, evidence: EV_PASS, env_patch: { appLaunch: { command: 'npm run dev', url: 'http://localhost:5173' } } });
  const r = run('test', mp, 'test-unit', rp);
  assert.equal(r.code, 0, r.err);
  const after = readJson(mp);
  assert.equal(after.env.e2eReady, true, '原欄位保留');
  assert.equal(after.env.appLaunch.url, 'http://localhost:5173', 'patch 合併');
});

// ── test:schema 驗證(altitude 是路由輸入,擋下靜默降級)─────────

test('test 驗證:altitude 打錯字 → exit 1、manifest 不動(不再靜默當 code)', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  const r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, altitude: 'enviroment', reason: 'app 起不來' }));
  assert.equal(r.code, 1, '應 exit 1,而非靜默降級成 code');
  assert.ok(r.err.includes('enviroment'));
  const after = readJson(mp);
  assert.equal(after.specs['spec-4'].status, 'produced', 'spec 不應被動到');
  assert.equal(after.orchestration.turn, 0);
});

test('test 驗證:失敗卻沒帶 altitude / verdict → exit 1', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  const r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, reason: '掛了' }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('altitude'));
});

test('test 驗證:pass 非 boolean / blame 不存在 → exit 1;舊 verdict 仍可用', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  let r = run('test', mp, 'test-unit', writeJson('r.json', { pass: 'yes' }));
  assert.equal(r.code, 1);
  r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, altitude: 'spec', blame: 'spec-99', reason: 'x' }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('spec-99'));
  r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, verdict: 'spec', reason: '舊格式' }));
  assert.equal(r.code, 0, '舊 verdict 向後相容,不應被擋');
});

// ── resume:兩條路徑的對象解析 ──────────────────────────────────

test('resume:environment block 走 test 路徑;blocked spec 走 spec 路徑', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  m.block = { kind: 'environment', test: 'test-unit', question: 'runner 起不來' };
  m.tests['test-unit'].status = 'fail';
  const mp = writeJson('m.json', m);
  let r = run('resume', mp, 'test-unit', writeJson('a.json', { answer: '已修好' }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.test, 'test-unit');
  let after = readJson(mp);
  assert.equal(after.block, null);
  assert.equal(after.tests['test-unit'].status, 'pending');
  assert.equal(after.specs['spec-4'].status, 'produced', 'spec 不重做');

  const m2 = fixture();
  m2.specs['spec-1'].status = 'blocked';
  m2.specs['spec-1'].clarify = 'X 還是 Y?';
  m2.specs['spec-1'].block_kind = 'requirement';
  const mp2 = writeJson('m.json', m2);
  r = run('resume', mp2, 'spec-1', writeJson('a.json', { answer: '要 Y' }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.spec, 'spec-1');
  assert.equal(readJson(mp2).specs['spec-1'].status, 'pending');
});

// ── review gate:produce 的揭露與 resume 的兩條路 ────────────────

test('review gate:produce 成功 → review_gate 揭露 + clarify 帶產出檔;resume approve → 續跑', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'pending';
  m.specs['spec-1'].review_gate = true;
  m.specs['spec-2'].status = 'pending';
  m.specs['spec-4'].status = 'pending';
  const mp = writeJson('m.json', m);
  let r = run('produce', mp, 'spec-1', writeJson('r.json', { ok: true, outputs: ['orchestrator/triage.md'], review: REVIEW }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.review_gate, true, '要對 orchestrator 揭露「這不是失敗,是查看點」');
  assert.ok(r.out.clarify.includes('triage.md'), 'clarify 要帶產出檔路徑');
  assert.equal(r.out.failed, undefined, '不可被誤標為失敗');
  let after = readJson(mp);
  assert.equal(after.specs['spec-1'].status, 'blocked');
  assert.deepEqual(after.orchestration.failSignals, [], 'gate 不是失敗,不進震盪窗口');

  r = run('resume', mp, 'spec-1', writeJson('a.json', { approve: true }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'verified', '無 test 的 gated spec 同意後直接 verified');
  after = readJson(mp);
  assert.equal(after.specs['spec-1'].block_kind, null);
});

// ── resume:answer.json 驗證(擋下時 manifest 不動、回合不增)────────
// 與 produce/test 的 result.json 驗證對稱:applyResume 只認 approve === true(嚴格 boolean),
// 不驗的話 "true"(字串)/ 空物件會把使用者「已同意」的產出靜默 reopen 盲目重做。

test('resume 驗證:review gate 下 approve 非 boolean true / 空物件 → exit 1、仍 blocked', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'blocked';
  m.specs['spec-1'].block_kind = 'review';
  m.specs['spec-1'].clarify = '請查看 triage.md';
  const mp = writeJson('m.json', m);
  let r = run('resume', mp, 'spec-1', writeJson('a.json', { approve: 'true' }));
  assert.equal(r.code, 1, '字串 "true" 應被擋,而非靜默 reopen');
  assert.ok(r.err.includes('approve'));
  r = run('resume', mp, 'spec-1', writeJson('a.json', {}));
  assert.equal(r.code, 1, '空物件應被擋(既非同意也非修改意見)');
  const after = readJson(mp);
  assert.equal(after.specs['spec-1'].status, 'blocked', 'manifest 不應被污染');
  assert.equal(after.orchestration.turn, 0, '回合不應增加');
});

test('resume 驗證:非 review 帶 approve / 缺 answer → exit 1;review 帶修改意見 → reopen', () => {
  const m = fixture();
  m.specs['spec-1'].status = 'blocked';
  m.specs['spec-1'].block_kind = 'requirement';
  m.specs['spec-1'].clarify = 'X 還是 Y?';
  const mp = writeJson('m.json', m);
  let r = run('resume', mp, 'spec-1', writeJson('a.json', { approve: true }));
  assert.equal(r.code, 1, 'approve 只在 review gate 合法');
  r = run('resume', mp, 'spec-1', writeJson('a.json', { answer: '' }));
  assert.equal(r.code, 1, '空 answer 應被擋');

  const m2 = fixture();
  m2.specs['spec-1'].status = 'blocked';
  m2.specs['spec-1'].block_kind = 'review';
  m2.specs['spec-1'].clarify = '請查看 triage.md';
  const mp2 = writeJson('m.json', m2);
  r = run('resume', mp2, 'spec-1', writeJson('a.json', { answer: '範圍漏了行動裝置版' }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'pending', 'review 帶修改意見 → 一般 reopen 重做');
  assert.equal(readJson(mp2).specs['spec-1'].last_failure, '範圍漏了行動裝置版', '意見成為重做輸入');
});

// ── 誠實性守門:outputs 存在性 / 實跑 evidence / requires_test / env_patch 白名單 ──

test('produce 驗證:outputs 宣稱的檔不存在於磁碟 → exit 1、manifest 不動', () => {
  const mp = writeJson('m.json', fixture());
  const r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Ghost.jsx'] }));
  assert.equal(r.code, 1, '宣稱寫了沒寫的檔應被擋下');
  assert.ok(r.err.includes('Ghost.jsx'));
  const after = readJson(mp);
  assert.equal(after.specs['spec-4'].status, 'pending', 'manifest 不應被污染');
  assert.equal(after.orchestration.turn, 0);
});

test('requires_test:validate 擋在凍結前,produce 記回擋第二道', () => {
  const m = fixture();
  m.specs['spec-2'].requires_test = true;          // spec-2 沒有任何 test verifies 它
  const mp = writeJson('m.json', m);
  let r = run('validate', mp);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.stdout).errors.some(e => e.includes('requires_test')));
  // 第二道:就算 validate 被跳過,produce 記回成功也會被擋(否則無 test → 直接 verified)
  const m2 = fixture();
  m2.specs['spec-2'].status = 'pending';
  m2.specs['spec-2'].requires_test = true;
  m2.specs['spec-4'].status = 'pending';
  const mp2 = writeJson('m.json', m2);
  r = run('produce', mp2, 'spec-2', writeJson('r.json', { ok: true, outputs: ['orchestrator/triage.md'], review: REVIEW }));
  assert.equal(r.code, 1, 'requires_test 卻無 test 的 produce 應被擋');
  assert.equal(readJson(mp2).specs['spec-2'].status, 'pending');
  // 掛上 test 後同樣的記回就能過
  m2.tests['test-spec2'] = { id: 'test-spec2', verifies: 'spec-2', runner: 'unit-tests', kind: 'unit', status: 'pending', last_fail: null };
  const mp3 = writeJson('m.json', m2);
  r = run('produce', mp3, 'spec-2', writeJson('r.json', { ok: true, outputs: ['orchestrator/triage.md'], review: REVIEW }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'produced');
});

test('review_map defer:validate 要求 requires_test:true 且有 test verifies', () => {
  const m = fixture({
    planning: { review_map: [
      { task: 'spec-2', risk: 'low', review_depth: 'defer-until-signal', split_reason: '低風險', upgrade_triggers: ['test fail'], reason: '有機器驗證' },
    ] },
  });
  let mp = writeJson('m.json', m);
  let r = run('validate', mp);
  assert.equal(r.code, 1, 'defer 卻沒有 requires_test/test 應被 validate 擋下');
  assert.ok(JSON.parse(r.stdout).errors.some(e => e.includes('defer-until-signal') && e.includes('spec-2')));

  m.specs['spec-2'].requires_test = true;
  m.tests['test-spec2'] = { id: 'test-spec2', verifies: 'spec-2', runner: 'unit-tests', kind: 'unit', status: 'pending', last_fail: null };
  mp = writeJson('m.json', m);
  r = run('validate', mp);
  assert.equal(r.code, 0, r.stdout || r.err);
});

test('review_map validate:非 array 或非 object 項目 → ok:false、exit 1', () => {
  let mp = writeJson('m.json', fixture({ planning: { review_map: { task: 'spec-2' } } }));
  let r = run('validate', mp);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.stdout).errors.some(e => e.includes('planning.review_map 必須是 array')));

  mp = writeJson('m.json', fixture({ planning: { review_map: ['bad-entry'] } }));
  r = run('validate', mp);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.stdout).errors.some(e => e.includes('planning.review_map 含非 object')));
});

test('review_map validate:task 必須存在、review_depth 必須合法', () => {
  const mp = writeJson('m.json', fixture({ planning: { review_map: [
    { task: 'spec-missing', risk: 'low', review_depth: 'full', split_reason: 'x', upgrade_triggers: [], reason: 'x' },
    { task: 'spec-4', risk: 'low', review_depth: 'light', split_reason: 'x', upgrade_triggers: [], reason: 'x' },
  ] } }));
  const r = run('validate', mp);
  assert.equal(r.code, 1);
  const errors = JSON.parse(r.stdout).errors;
  assert.ok(errors.some(e => e.includes('review_map 指向不存在的 spec「spec-missing」')));
  assert.ok(errors.some(e => e.includes('review_depth') && e.includes('light')));
});

test('tier validate:只接受 high / medium / low', () => {
  const m = fixture();
  m.specs['spec-4'].tier = 'ultra';
  const mp = writeJson('m.json', m);
  const r = run('validate', mp);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.stdout).errors.some(e => e.includes('tier') && e.includes('ultra')));
  m.specs['spec-4'].tier = 'medium';
  const mp2 = writeJson('m2.json', m);
  assert.equal(run('validate', mp2).code, 0);
});

test('test 驗證:pass 無 evidence / unit 缺實跑計數 → exit 1(沒實跑不得報 pass)', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  let r = run('test', mp, 'test-unit', writeJson('r.json', { pass: true }));
  assert.equal(r.code, 1, '沒有證據的 pass 應被拒收');
  assert.ok(r.err.includes('evidence'));
  r = run('test', mp, 'test-unit', writeJson('r.json', { pass: true, evidence: { note: 'looks good' } }));
  assert.equal(r.code, 1, 'unit 的 pass 缺 command / exit_code / 計數應被拒收');
  assert.equal(readJson(mp).specs['spec-4'].status, 'produced', 'manifest 不應被動到');
});

test('test 驗證:evidence 計數矛盾 / todo-only → exit 1', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  let r = run('test', mp, 'test-unit', writeJson('r.json', { pass: true, evidence: { command: 'vitest run', exit_code: 0, passed: 3, failed: 1 } }));
  assert.equal(r.code, 1, 'pass:true 與 failed=1 矛盾');
  r = run('test', mp, 'test-unit', writeJson('r.json', { pass: true, evidence: { command: 'vitest run', exit_code: 0, passed: 0, failed: 0, todo: 6 } }));
  assert.equal(r.code, 1, 'todo-only(passed=0)不算通過');
  assert.ok(r.err.includes('todo-only') || r.err.includes('passed=0'));
});

test('test 驗證:environment 帶 blame → exit 1(語意矛盾)', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  const mp = writeJson('m.json', m);
  const r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, altitude: 'environment', blame: 'spec-2', reason: 'runner 起不來' }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('environment'));
});

test('env_patch 白名單:patch 身份欄位 → exit 1;白名單內欄位照常合併', () => {
  const m = fixture();
  m.specs['spec-4'].status = 'produced';
  m.env = { commitType: 'feat', e2eReady: true };
  m.env_patchable = ['appLaunch', 'e2eReady'];
  const mp = writeJson('m.json', m);
  let r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, altitude: 'environment', reason: 'app 起不來', env_patch: { commitType: 'fix' } }));
  assert.equal(r.code, 1, '白名單外的欄位應被拒收');
  assert.ok(r.err.includes('commitType'));
  assert.equal(readJson(mp).env.commitType, 'feat', 'env 不應被改寫');
  r = run('test', mp, 'test-unit', writeJson('r.json', { pass: false, altitude: 'environment', reason: 'route 不足', env_patch: { e2eReady: false } }));
  assert.equal(r.code, 0, r.err);
  assert.equal(readJson(mp).env.e2eReady, false, '白名單內欄位照常 patch');
});

// ── 協議強制:action lease(記回只接受 next / next-all 發派過的 action)────────

test('lease:未經發派的 produce → exit 1、manifest 不動;next 發派後同一記回放行', () => {
  const m = fixture();
  m.orchestration.leases = [];
  const mp = writeJson('m.json', m);
  const rp = writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW });
  let r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 1, '未發派的 action 應被擋');
  assert.ok(r.err.includes('leases'));
  assert.equal(readJson(mp).orchestration.turn, 0, '回合不應增加');
  r = run('next', mp);   // spec-4 pending 且依賴齊 → 發派 produce:spec-4
  assert.equal(r.code, 0, r.err);
  assert.ok(readJson(mp).orchestration.leases.includes('produce:spec-4'), 'next 應把發派寫進 leases');
  r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 0, r.err);
});

test('lease:記回即消耗,同一 produce 不能記兩次;下一輪授權由記回後的狀態重算', () => {
  const mp = writeJson('m.json', fixture());
  const rp = writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW });
  let r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 0, r.err);
  const after = readJson(mp);
  assert.ok(!after.orchestration.leases.includes('produce:spec-4'), '成功記回應消耗授權');
  assert.ok(after.orchestration.leases.includes('test:test-unit'), '記回後應重算出下一輪授權');
  r = run('produce', mp, 'spec-4', rp);
  assert.equal(r.code, 1, '沒有新發派不得重記');
});

test('lease:produce 失敗 → 重做授權立即重發(不必先繞一趟 next)', () => {
  const mp = writeJson('m.json', fixture());
  const r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: false, reason: 'x', fix_target: 'code' }));
  assert.equal(r.code, 0, r.err);
  assert.ok(readJson(mp).orchestration.leases.includes('produce:spec-4'), 'failed → decideAll 重發重做授權');
});

test('lease:發派整批重發,上一輪殘留的過時授權作廢', () => {
  const m = fixture();
  // 殘留授權:spec-1 / spec-2 已 verified、test-unit 的 spec 還沒 produced,此刻都不該被授權
  m.orchestration.leases = ['produce:spec-1', 'produce:spec-2', 'test:test-unit'];
  const mp = writeJson('m.json', m);
  let r = run('next', mp);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readJson(mp).orchestration.leases, ['produce:spec-4'], '發派後 leases = 此刻 decideAll 授權的集合');
  r = run('produce', mp, 'spec-1', writeJson('r.json', { ok: true, outputs: ['orchestrator/triage.md'], review: REVIEW }));
  assert.equal(r.code, 1, '殘留的過時授權不得再用來記回');
  assert.ok(r.err.includes('leases'));
});

test('lease:平行批次裡某項觸發停點,其他 in-flight 結果仍可記回', () => {
  const m = {
    specs: {
      'spec-a': { id: 'spec-a', skill: 'w', status: 'produced', depends_on: [], outputs: [], last_failure: null, fix_target: null },
      'spec-b': { id: 'spec-b', skill: 'w', status: 'produced', depends_on: [], outputs: [], last_failure: null, fix_target: null },
    },
    tests: {
      'test-a': { id: 'test-a', verifies: 'spec-a', runner: 'unit', kind: 'unit', status: 'pending', last_fail: null },
      'test-b': { id: 'test-b', verifies: 'spec-b', runner: 'unit', kind: 'unit', status: 'pending', last_fail: null },
    },
    env: {},
    orchestration: { turn: 0, maxTurns: 30, noProgressK: 3, failSignals: [], leases: [] },
  };
  const mp = writeJson('m.json', m);
  let r = run('next-all', mp);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readJson(mp).orchestration.leases.sort(), ['test:test-a', 'test:test-b']);
  r = run('test', mp, 'test-a', writeJson('r.json', { pass: false, altitude: 'environment', reason: 'runner 起不來' }));
  assert.equal(r.code, 0, r.err);
  // 停點(clarify)不是發派:不重發、不清授權——test-b 的 in-flight 授權必須活過這次 next-all
  r = run('next-all', mp);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.type, 'clarify');
  assert.ok(readJson(mp).orchestration.leases.includes('test:test-b'), '停點不得作廢 in-flight 授權');
  r = run('test', mp, 'test-b', writeJson('r.json', { pass: true, evidence: EV_PASS }));
  assert.equal(r.code, 0, '停點不作廢其他 in-flight 授權:' + (r.err || ''));
  assert.equal(readJson(mp).specs['spec-b'].status, 'verified');
});

// ── review 欄位硬驗:審查深度合規 + reviewer 結論落盤 ───────────────────────

test('review:成功記回缺 review 欄位 → exit 1、manifest 不動', () => {
  const mp = writeJson('m.json', fixture());
  const r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'] }));
  assert.equal(r.code, 1, '沒交代審查的成功記回應被擋');
  assert.ok(r.err.includes('review'));
  assert.equal(readJson(mp).specs['spec-4'].status, 'pending', 'manifest 不應被污染');
});

test('review:未列 review map 預設 full(focused 不足);record 檔不存在 → exit 1', () => {
  const mp = writeJson('m.json', fixture());
  let r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: { depth: 'focused', record: 'orchestrator/review.md' } }));
  assert.equal(r.code, 1, 'fail-closed:未列 review map 的 spec 預設 full');
  assert.ok(r.err.includes('full'));
  r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: { depth: 'full', record: 'orchestrator/ghost-review.md' } }));
  assert.equal(r.code, 1, 'reviewer 結論必須真的落盤');
  assert.ok(r.err.includes('ghost-review.md'));
});

test('review:map 標 defer 且有機器護欄 → defer 合法、last_review 落盤;重做一律升級 full', () => {
  const deferMap = { planning: { review_map: [
    { task: 'spec-4', risk: 'low', review_depth: 'defer-until-signal', split_reason: 'x', upgrade_triggers: ['test fail'], reason: 'x' },
  ] } };
  const m = fixture(deferMap);
  m.specs['spec-4'].requires_test = true;
  const mp = writeJson('m.json', m);
  let r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: { depth: 'defer-until-signal' } }));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readJson(mp).specs['spec-4'].last_review, { depth: 'defer-until-signal', record: null });

  const m2 = fixture(deferMap);
  m2.specs['spec-4'].requires_test = true;
  m2.specs['spec-4'].status = 'failed';
  m2.specs['spec-4'].last_failure = 'test fail 後重做';
  const mp2 = writeJson('m.json', m2);
  r = run('produce', mp2, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: { depth: 'defer-until-signal' } }));
  assert.equal(r.code, 1, '重做中的 spec 一律升級 full,defer 不合法');
  assert.ok(r.err.includes('full'));
});

test('review:defer 但 spec 無 requires_test / 無 test → exit 1(沒有機器護欄不得略過 reviewer)', () => {
  const m = fixture({ planning: { review_map: [
    { task: 'spec-2', risk: 'low', review_depth: 'defer-until-signal', split_reason: 'x', upgrade_triggers: [], reason: 'x' },
  ] } });
  m.specs['spec-2'].status = 'pending';
  m.specs['spec-4'].status = 'pending';
  const mp = writeJson('m.json', m);
  const r = run('produce', mp, 'spec-2', writeJson('r.json', { ok: true, outputs: ['orchestrator/triage.md'], review: { depth: 'defer-until-signal' } }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('requires_test'));
});

// ── 委派 brief:next 輸出附機械派工輸入 ─────────────────────────────

test('next:action 附 brief(上游 outputs / 重做脈絡 / required review depth)', () => {
  const m = fixture();
  m.specs['spec-2'].outputs = ['orchestrator/triage.md'];
  m.specs['spec-4'].status = 'failed';
  m.specs['spec-4'].last_failure = '上次接線錯';
  const mp = writeJson('m.json', m);
  const r = run('next', mp);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.type, 'produce');
  assert.equal(r.out.spec, 'spec-4');
  assert.deepEqual(r.out.brief.depends_on_outputs, { 'spec-2': ['orchestrator/triage.md'] });
  assert.equal(r.out.brief.last_failure, '上次接線錯');
  assert.equal(r.out.brief.review.required_depth, 'full', 'last_failure 非空 → 重做升級 full');
});

// ── resume 收緊:只能解除引擎停下的對象 ─────────────────────────────

test('resume:非引擎停下的對象 → exit 1;震盪 clarify 指向的 failed spec 可 resume', () => {
  const mp = writeJson('m.json', fixture());
  let r = run('resume', mp, 'spec-4', writeJson('a.json', { answer: '直接重做' }));
  assert.equal(r.code, 1, 'pending spec 不是 clarify 對象,resume 會變成重做後門');
  assert.ok(r.err.includes('clarify'));

  const m2 = fixture();
  m2.specs['spec-4'].status = 'failed';
  m2.orchestration.failSignals = ['spec-4:code', 'spec-4:code', 'spec-4:code'];
  const mp2 = writeJson('m.json', m2);
  r = run('resume', mp2, 'spec-4', writeJson('a.json', { answer: '改用方案 B' }));
  assert.equal(r.code, 0, r.err);
  assert.equal(readJson(mp2).specs['spec-4'].status, 'pending');
});

// ── validate:懸空參照與環 ──────────────────────────────────────

test('validate:健康 manifest → ok:true', () => {
  const mp = writeJson('m.json', fixture());
  const r = run('validate', mp);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.ok, true);
});

test('validate:懸空 depends_on / verifies → ok:false、exit 1', () => {
  const m = fixture();
  m.specs['spec-4'].depends_on = ['spec-ghost'];
  m.tests['test-unit'].verifies = 'spec-ghost';
  const mp = writeJson('m.json', m);
  const r = run('validate', mp);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.errors.filter(e => e.includes('spec-ghost')).length, 2);
});

test('validate:spec 依賴成環 → 報「spec 依賴成環」', () => {
  const m = fixture();
  m.specs['spec-1'].depends_on = ['spec-4'];   // 1 → 4 → 2 → 1
  const mp = writeJson('m.json', m);
  const r = run('validate', mp);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.stdout).errors.some(e => e.includes('spec 依賴成環')));
});

test('validate:test 依賴成環 → 報「test 依賴成環」(decide 對此只會 halt,難診斷)', () => {
  const m = fixture();
  m.tests['test-e2e'] = { id: 'test-e2e', verifies: 'spec-4', runner: 'ui-e2e', kind: 'e2e', depends_on: ['test-unit'], status: 'pending', last_fail: null };
  m.tests['test-unit'].depends_on = ['test-e2e'];   // unit ↔ e2e 互等
  const mp = writeJson('m.json', m);
  const r = run('validate', mp);
  assert.equal(r.code, 1);
  assert.ok(JSON.parse(r.stdout).errors.some(e => e.includes('test 依賴成環')));
});

// ── 未申報修改硬驗:git status 與回報的 outputs / deleted 比對 ───────────────
// 這組測試需要真 git repo 當 cwd(tmp 不是 git repo,其餘測試自動跳過此驗)。

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-cli-git-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/app.js'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  // orchestrator/ 過程目錄(review record 落盤處),守門應整個目錄忽略
  fs.mkdirSync(path.join(dir, 'orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'orchestrator/review.md'), '// reviewer 結論\n');
  return dir;
}
function writeIn(dir, rel, content = '// stub\n') {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('dirty 硬驗:worker 改了檔卻不回報 → exit 1、manifest 不動', () => {
  const repo = makeGitRepo();
  writeIn(repo, 'src/Foo.jsx');                                    // 有申報的新檔
  fs.appendFileSync(path.join(repo, 'src/app.js'), 'sneaky\n');    // 未申報的修改
  const mp = writeJson('m.json', fixture());
  const r = runIn(repo, 'produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW }));
  assert.equal(r.code, 1, '未申報的修改應被擋');
  assert.ok(r.err.includes('src/app.js'));
  const after = readJson(mp);
  assert.equal(after.specs['spec-4'].status, 'pending', 'manifest 不應被污染');
  assert.equal(after.orchestration.turn, 0, '回合不應增加');
});

test('dirty 硬驗:修改全數申報、orchestrator/ 過程目錄不計 → 照常記回', () => {
  const repo = makeGitRepo();
  writeIn(repo, 'src/Foo.jsx');
  writeIn(repo, 'orchestrator/notes.md');                          // 過程產物,不必申報
  const mp = writeJson('m.json', fixture());
  const r = runIn(repo, 'produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'produced');
});

test('dirty 硬驗:先前站已記回、尚未 commit 的 outputs → 不算本站未申報', () => {
  const repo = makeGitRepo();
  fs.appendFileSync(path.join(repo, 'src/app.js'), 'earlier station\n');
  writeIn(repo, 'src/Foo.jsx');
  const m = fixture();
  m.specs['spec-2'].outputs = ['src/app.js'];                      // 上一站的產出,同一 run 內還沒 commit
  const mp = writeJson('m.json', m);
  const r = runIn(repo, 'produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW }));
  assert.equal(r.code, 0, r.err);
});

test('dirty 硬驗:in-flight lease 的 allowed_outputs 範圍內豁免;無 ownership 不豁免', () => {
  const repo = makeGitRepo();
  writeIn(repo, 'src/Foo.jsx');
  writeIn(repo, 'src/layout/Sidebar.tsx');                         // 平行站 spec-5 in-flight 已落盤的檔
  const m = fixture();
  m.specs['spec-5'] = { id: 'spec-5', skill: 'w', status: 'pending', depends_on: ['spec-2'], outputs: [], last_failure: null, fix_target: null, allowed_outputs: ['src/layout/*'] };
  m.orchestration.leases.push('produce:spec-5');
  const mp = writeJson('m.json', m);
  let r = runIn(repo, 'produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW }));
  assert.equal(r.code, 0, r.err);

  const repo2 = makeGitRepo();
  writeIn(repo2, 'src/Foo.jsx');
  writeIn(repo2, 'src/layout/Sidebar.tsx');
  const m2 = fixture();
  m2.specs['spec-5'] = { id: 'spec-5', skill: 'w', status: 'pending', depends_on: ['spec-2'], outputs: [], last_failure: null, fix_target: null };
  m2.orchestration.leases.push('produce:spec-5');
  const mp2 = writeJson('m.json', m2);
  r = runIn(repo2, 'produce', mp2, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW }));
  assert.equal(r.code, 1, '沒宣告 allowed_outputs ownership 的 in-flight 髒檔不得豁免');
  assert.ok(r.err.includes('Sidebar.tsx'));
});

test('deleted 申報:刪檔未申報 → exit 1;申報 deleted → 照常記回', () => {
  const repo = makeGitRepo();
  writeIn(repo, 'src/Foo.jsx');
  fs.rmSync(path.join(repo, 'src/app.js'));
  const mp = writeJson('m.json', fixture());
  let r = runIn(repo, 'produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], review: REVIEW }));
  assert.equal(r.code, 1, '未申報的刪檔應被擋');
  assert.ok(r.err.includes('src/app.js'));
  r = runIn(repo, 'produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], deleted: ['src/app.js'], review: REVIEW }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'produced');
});

test('deleted 申報:宣告刪了但檔還在 / 刪到 ownership 外 → exit 1', () => {
  const repo = makeGitRepo();
  writeIn(repo, 'src/Foo.jsx');
  const mp = writeJson('m.json', fixture());
  let r = runIn(repo, 'produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], deleted: ['src/app.js'], review: REVIEW }));
  assert.equal(r.code, 1, '宣告刪除但檔仍存在應被擋');
  assert.ok(r.err.includes('src/app.js'));

  const repo2 = makeGitRepo();
  writeIn(repo2, 'src/Foo.jsx');
  fs.rmSync(path.join(repo2, 'src/app.js'));
  const m2 = fixture();
  m2.specs['spec-4'].allowed_outputs = ['src/Foo.jsx'];
  const mp2 = writeJson('m.json', m2);
  r = runIn(repo2, 'produce', mp2, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], deleted: ['src/app.js'], review: REVIEW }));
  assert.equal(r.code, 1, '刪 ownership 外的檔應被擋');
  assert.ok(r.err.includes('src/app.js'));
});

test('produce 驗證:deleted 不是 string 陣列 → exit 1', () => {
  const mp = writeJson('m.json', fixture());
  const r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'], deleted: 'src/app.js', review: REVIEW }));
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('deleted'));
});

console.log(`\n${pass} passed`);
