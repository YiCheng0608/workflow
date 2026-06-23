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
// cwd 設在 tmp:cli 會對 outputs 做磁碟存在性驗證,宣稱的檔要相對於執行目錄真的存在。
function run(...args) {
  try {
    // stderr 用 pipe 捕捉(預設 inherit 會把預期中的「✗ 不合法」噪音漏到測試輸出)
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: tmp });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.status, err: String(e.stderr || ''), stdout: String(e.stdout || '') };
  }
}
// outputs 存在性守門:測試裡宣稱的產出檔要先真的寫到 tmp 磁碟
function touch(rel) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '// stub\n');
  return rel;
}
['src/Foo.jsx', 'src/Foo.test.jsx', 'src/layout/Sidebar.tsx', 'src/layout/Header.tsx', 'orchestrator/triage.md'].forEach(touch);
// unit test 報 pass 時的合法實跑證據(引擎要求 command / exit_code:0 / 計數)
const EV_PASS = { command: 'vitest run', exit_code: 0, passed: 5, failed: 0 };

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
    orchestration: { turn: 0, maxTurns: 30, noProgressK: 3, failSignals: [] },
  }, over);
}

console.log('cli.js regression:');

// ── produce:記回與訊號 ──────────────────────────────────────────

test('produce 成功:outputs 記回、turn+1、failSignals 清空', () => {
  const m = fixture();
  m.orchestration.failSignals = ['spec-4:code'];   // 殘留的震盪窗口
  const mp = writeJson('m.json', m);
  const rp = writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'] });
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
  const r = run('produce', mp, 'spec-4', writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx'] }));
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
  const rp = writeJson('r.json', { ok: true, outputs: ['src/Foo.jsx', 'src/Foo.test.jsx'] });
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
  const rp = writeJson('r.json', { ok: true, outputs: ['src/layout/Sidebar.tsx', 'src/layout/Header.tsx'] });
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
  let r = run('produce', mp, 'spec-1', writeJson('r.json', { ok: true, outputs: ['orchestrator/triage.md'] }));
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
  r = run('produce', mp2, 'spec-2', writeJson('r.json', { ok: true, outputs: ['orchestrator/triage.md'] }));
  assert.equal(r.code, 1, 'requires_test 卻無 test 的 produce 應被擋');
  assert.equal(readJson(mp2).specs['spec-2'].status, 'pending');
  // 掛上 test 後同樣的記回就能過
  m2.tests['test-spec2'] = { id: 'test-spec2', verifies: 'spec-2', runner: 'unit-tests', kind: 'unit', status: 'pending', last_fail: null };
  const mp3 = writeJson('m.json', m2);
  r = run('produce', mp3, 'spec-2', writeJson('r.json', { ok: true, outputs: ['orchestrator/triage.md'] }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.status, 'produced');
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

console.log(`\n${pass} passed`);
