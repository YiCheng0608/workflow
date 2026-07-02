#!/usr/bin/env node
// cli.js — runtime 無關的 I/O adapter。把「純大腦」decide.js 接到磁碟上的 manifest。
//
// 任何 agent(Claude / Codex / Gemini …)都用「同樣的指令」呼叫它,得到「同樣的決策」:
//   node orchestrator/cli.js next     <manifest>                 → 印出下一個 action(JSON)
//   node orchestrator/cli.js produce  <manifest> <specId> [result.json]
//   node orchestrator/cli.js test     <manifest> <testId>  <result.json>
//
// 鐵則:routing / 狀態轉移邏輯全在 decide.js,這支只負責讀檔、呼叫、寫回。
// 唯一事實來源 = manifest 檔本身(含迴圈計數 orchestration,所以可以 crash 後接著跑)。
// 協議強制:next / next-all 發派 action 時把授權寫進 orchestration.leases;
// produce / test 只接受發派過的 action(先問、再派、再記回,繞過 next 私跑會被 exit 1 擋下)。
'use strict';
const fs = require('fs');
const path = require('path');
const { decide, decideAll, applyProduce, applyTestResult, applyResume, applyResumeEnv, altitudeOf, blameTargetId, specForFailedTest } = require('./decide');

function load(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { fail(`讀不到或解析不了 manifest: ${p}\n${e.message}`); }
}
function save(p, m) { fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n'); }
function fail(msg) { process.stderr.write('✗ ' + msg + '\n'); process.exit(1); }
function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// 迴圈計數也存在 manifest 裡(orchestration 區塊),保持單一事實來源
function ctxOf(m) {
  const o = m.orchestration || {};
  return {
    turn: o.turn || 0,
    maxTurns: o.maxTurns != null ? o.maxTurns : 30,
    noProgressK: o.noProgressK != null ? o.noProgressK : 3,
    failSignals: o.failSignals || [],
  };
}
function writeCtx(m, ctx) {
  m.orchestration = {
    turn: ctx.turn, maxTurns: ctx.maxTurns,
    noProgressK: ctx.noProgressK, failSignals: ctx.failSignals,
    leases: (m.orchestration || {}).leases || [],
  };
}

// 進度只清「該 target」的震盪訊號,不是整個窗口。訊號一律 target-first(`${target}:${…}`),
// 故以 ':' 前綴比對。全域清空在序列下等價,但平行批次下會讓 A 的進度洗掉 B 正在累積的震盪
// 證據——「別處總有進度」時某節點的反覆失敗就永遠湊不到 K。per-target 清除讓 terminationGuard
// 在平行下仍能抓到各自累計達 K 的節點(含修 A 壞 B 的交替)。
function clearSignalsFor(signals, ...targets) {
  const set = new Set(targets);
  return (signals || []).filter(s => !set.has(String(s).split(':')[0]));
}

// ── action lease(協議強制):引擎只接受「自己發派過的 action」記回。──────────────
// next / next-all 每次都把「此刻 decideAll 授權的 action 集合」併進 orchestration.leases;
// produce / test 記回前查驗授權存在,記回後消耗它(重做等新授權由記回後的 decideAll 重新算出)。
// 這把「先問 next 再派工再記回」從 SKILL 自律變成引擎硬約束:繞過 next 私跑一站、或把沒發派過
// 的結果塞回 manifest,都 exit 1(manifest 不動)。clarify / done / halt 不清既有授權:平行批次
// 裡其他 in-flight worker 的結果仍可記回,不因某一項先觸發停點而作廢已做完的工作。
function leaseKey(a) {
  return a.type === 'produce' ? `produce:${a.spec}` : a.type === 'test' ? `test:${a.test}` : null;
}
function refreshLeases(m, consumed) {
  const set = new Set((m.orchestration && m.orchestration.leases) || []);
  if (consumed) set.delete(consumed);
  for (const a of (decideAll(m, ctxOf(m)).actions || [])) {
    const k = leaseKey(a);
    if (k) set.add(k);
  }
  m.orchestration = m.orchestration || {};
  m.orchestration.leases = [...set];
}
function requireLease(m, key) {
  const leases = (m.orchestration && m.orchestration.leases) || [];
  if (!leases.includes(key)) {
    fail(`「${key}」不在引擎發派的授權裡(orchestration.leases)。記回只接受 next / next-all 發派過的 action;` +
         `先跑 cli.js next-all(或 next)取得本輪發派,再委派、再記回(manifest 未變動、回合未增)`);
  }
}

// ── 委派 brief:把 manifest 能機械算出的派工輸入直接附在 action 上。──────────────
// 縮小 orchestrator 自由組裝委派輸入的空間:上游 outputs、重做脈絡、ownership 約束、
// 要求的審查深度、env 事實都由引擎給;語意(需求原文、任務描述)住在 requirement / intake
// 文件,引擎不讀也不轉述。gate_outputs = review_gate spec(intake)已記回的產出檔路徑。
function enrichAction(m, a) {
  if (a && a.type === 'produce' && m.specs[a.spec]) {
    const s = m.specs[a.spec];
    const upstream = {};
    for (const d of (s.depends_on || [])) upstream[d] = (m.specs[d] && m.specs[d].outputs) || [];
    const gateOutputs = Object.values(m.specs)
      .filter(x => x.review_gate === true && x.id !== s.id)
      .flatMap(x => x.outputs || []);
    return { ...a, brief: {
      skill: s.skill,
      ...(s.tier !== undefined ? { tier: s.tier } : {}),
      depends_on_outputs: upstream,
      ...(gateOutputs.length ? { gate_outputs: gateOutputs } : {}),
      last_failure: s.last_failure, fix_target: s.fix_target,
      ...(s.allowed_outputs ? { allowed_outputs: s.allowed_outputs } : {}),
      ...(s.forbid_outputs ? { forbid_outputs: s.forbid_outputs } : {}),
      ...(s.requires_test === true ? { requires_test: true } : {}),
      review: { required_depth: requiredReviewDepth(m, a.spec) },
      env: m.env || {},
    } };
  }
  if (a && a.type === 'test' && m.tests[a.test]) {
    const t = m.tests[a.test];
    const s = m.specs[t.verifies];
    return { ...a, brief: {
      runner: t.runner, kind: t.kind, verifies: t.verifies,
      spec_outputs: (s && s.outputs) || [],
      last_fail: t.last_fail,
      env: m.env || {},
    } };
  }
  return a;
}
function enrichDecision(m, r) {
  if (r.type === 'batch') return { ...r, actions: r.actions.map(a => enrichAction(m, a)) };
  return enrichAction(m, r);
}

// ── 記回 produce/test 後,順手把「下一步」算進輸出,消掉「記回」與「再呼叫 next」之間的停頓點。
// 只多算一次 decide(),不改狀態,兩 runtime 共享。continue 是純訊號:
// produce/test ⇒ true(同回合續跑),clarify/done/halt ⇒ false。停點語意由 SKILL.md 獨家擁有。
function nextStep(m) {
  const next = decide(m, ctxOf(m));   // m / ctx 此刻已是記回後的新狀態(已 writeCtx + save)
  return { next: enrichAction(m, next), continue: next.type === 'produce' || next.type === 'test' };
}

// ── result.json schema 驗證:套用前擋下不合法結果(exit 1、manifest 不動、回合不增)。──
// 為什麼要在這裡硬擋:result.json 是 LLM 翻譯出來的,而 altitude / blame 正是引擎的路由輸入。
// 不驗的話,altitude 打錯字(如 "enviroment")會掉進 applyTestResult 的 else 分支被靜默當成
// code 去重做 spec——本該停下問人的環境問題就這樣空轉到震盪。驗不過就 fail,讓 orchestrator
// 修正 result.json 後重記一次,manifest 完全不被污染。
const ALTITUDES = ['code', 'spec', 'requirement', 'environment'];
function isPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function validateProduceResult(m, specId, r) {
  const errs = [];
  if (!isPlainObject(r)) return ['result.json 必須是 JSON object'];
  if (r.ok !== undefined && typeof r.ok !== 'boolean') errs.push('ok 必須是 boolean');
  if (r.ok === false) {
    if (r.reason !== undefined && typeof r.reason !== 'string') errs.push('reason 必須是 string');
    if (r.blame !== undefined) {
      if (typeof r.blame !== 'string' || !m.specs[r.blame]) errs.push(`blame「${r.blame}」不是 manifest 裡存在的 spec`);
      else if (r.blame === specId) errs.push('blame 不可指向自己(根因在本站請改用 fix_target)');
    }
    if (r.fix_target !== undefined && !['code', 'spec'].includes(r.fix_target)) errs.push(`fix_target「${r.fix_target}」不合法(可用: code / spec)`);
  } else if (r.outputs !== undefined && (!Array.isArray(r.outputs) || r.outputs.some(o => typeof o !== 'string'))) {
    errs.push('outputs 必須是 string 陣列');
  }
  return errs;
}
function validateTestResult(m, testId, r) {
  const errs = [];
  if (!isPlainObject(r)) return ['result.json 必須是 JSON object'];
  if (typeof r.pass !== 'boolean') errs.push('pass 必須是 boolean(true / false)');
  if (r.pass === false) {
    if (r.altitude !== undefined) {
      if (!ALTITUDES.includes(r.altitude)) errs.push(`altitude「${r.altitude}」不合法(可用: ${ALTITUDES.join(' / ')})`);
    } else if (r.verdict !== undefined) {
      if (!['code', 'spec'].includes(r.verdict)) errs.push(`verdict「${r.verdict}」不合法(舊格式僅 code / spec)`);
    } else {
      // 失敗結果必須明帶 altitude:它是路由輸入,缺了就只能瞎猜 code,寧可退回要求補上。
      errs.push('失敗結果必須帶 altitude(code / spec / requirement / environment;舊格式 verdict 亦可)');
    }
    // environment 的定義就是「與任何 phase 內容無關、不歸咎任何 spec」,帶 blame 是語意矛盾。
    if (r.altitude === 'environment' && r.blame !== undefined) errs.push('altitude "environment" 不歸咎任何 spec,不可帶 blame(根因真在某站請改用 spec / requirement)');
    if (r.reason !== undefined && typeof r.reason !== 'string') errs.push('reason 必須是 string(結構化細節放 evidence)');
    if (r.blame !== undefined && (typeof r.blame !== 'string' || !m.specs[r.blame])) errs.push(`blame「${r.blame}」不是 manifest 裡存在的 spec`);
  }
  if (r.evidence !== undefined && !isPlainObject(r.evidence)) errs.push('evidence 必須是 object');
  if (r.env_patch !== undefined && !isPlainObject(r.env_patch)) errs.push('env_patch 必須是 object');

  // ── 實跑證據:防「沒跑卻報 pass」。pass 是引擎把 spec 標 verified 的唯一輸入,
  // 沒有證據的 pass 一律拒收;有計數就做一致性檢查(編造一份內部一致又與摘要相符的
  // 計數,門檻遠高於空口報 pass)。todo-only(passed=0)不算通過——零實質斷言驗不了任何東西。
  if (r.pass === true && (!isPlainObject(r.evidence) || !Object.keys(r.evidence).length)) {
    errs.push('pass:true 必須帶非空 evidence(實跑證據:unit 為 runner 指令+計數,e2e 為畫面證據)');
  }
  if (isPlainObject(r.evidence)) {
    for (const k of ['passed', 'failed', 'todo']) {
      if (r.evidence[k] !== undefined && (!Number.isInteger(r.evidence[k]) || r.evidence[k] < 0)) errs.push(`evidence.${k} 必須是非負整數`);
    }
    if (r.pass === true && Number.isInteger(r.evidence.failed) && r.evidence.failed > 0) errs.push(`pass:true 與 evidence.failed=${r.evidence.failed} 矛盾`);
    if (r.pass === true && Number.isInteger(r.evidence.passed) && r.evidence.passed === 0) errs.push('pass:true 但 evidence.passed=0:todo-only / 零實質斷言不算通過');
    // 「failed=0 卻報失敗」只在 code / spec(真跑過斷言的失敗)算矛盾;environment(跑不起來)
    // 與 requirement(需求欠明確、無斷言可計)本就沒有有意義的 failed 計數,不適用此檢查。
    if (r.pass === false && Number.isInteger(r.evidence.failed) && r.evidence.failed === 0 && !['environment', 'requirement'].includes(r.altitude)) errs.push('pass:false 但 evidence.failed=0:計數與結果矛盾');
  }
  // unit test(會實跑 runner 的測試)的 pass 必須附完整實跑證據;e2e 等其他 kind 的
  // evidence 形狀由其 worker 契約定(畫面描述等),引擎只要求非空。
  const t = m.tests[testId];
  if (t && t.kind === 'unit' && r.pass === true && isPlainObject(r.evidence)) {
    if (typeof r.evidence.command !== 'string' || !r.evidence.command.trim()) errs.push('unit test 的 pass 必須帶 evidence.command(實際執行的 runner 指令)');
    if (r.evidence.exit_code !== 0) errs.push('unit test 的 pass 必須帶 evidence.exit_code 且為 0(runner 真跑過且成功)');
    if (!Number.isInteger(r.evidence.passed) || !Number.isInteger(r.evidence.failed)) errs.push('unit test 的 pass 必須帶 evidence.passed / evidence.failed 實跑計數');
  }

  // ── env_patch 白名單:manifest 宣告 env_patchable 時,worker 只能回寫列出的欄位。
  // 不擋的話 worker 理論上可改寫 commitType / scope / ticketId 等身份欄位。
  if (isPlainObject(r.env_patch) && Array.isArray(m.env_patchable)) {
    const illegal = Object.keys(r.env_patch).filter(k => !m.env_patchable.includes(k));
    if (illegal.length) errs.push(`env_patch 含未授權欄位:${illegal.join(', ')}(manifest.env_patchable 僅允許 ${m.env_patchable.join(', ')})`);
  }
  return errs;
}
// answer.json 與 result.json 同樣是 LLM 翻譯點,同樣硬擋。最危險的靜默降級在 review gate:
// applyResume 只認 approve === true(嚴格 boolean),寫成 "true"(字串)或漏寫不會報錯——
// 會把使用者「已同意」的產出悄悄 reopen 盲目重做一輪,再 gate 一次。
function validateResumeAnswer(kind, a) {
  const errs = [];
  if (!isPlainObject(a)) return ['answer.json 必須是 JSON object'];
  if (a.reopen !== undefined && !['pending', 'failed'].includes(a.reopen)) errs.push(`reopen「${a.reopen}」不合法(可用: pending / failed)`);
  const hasAnswer = typeof a.answer === 'string' && a.answer.trim() !== '';
  if (a.answer !== undefined && !hasAnswer) errs.push('answer 必須是非空 string');
  if (kind === 'review') {
    if (a.approve !== undefined && a.approve !== true) errs.push(`approve「${JSON.stringify(a.approve)}」不合法(同意續跑只接受 boolean true)`);
    if (a.approve === undefined && !hasAnswer) errs.push('review gate 的 resume 必須二選一:{"approve":true}(同意續跑)或 {"answer":"<修改意見>"}(reopen 重做)');
  } else {
    if (a.approve !== undefined) errs.push('approve 只在 review gate 的 resume 合法(本次 clarify 不是 review,請帶 answer)');
    if (!hasAnswer) errs.push('answer 必填(使用者的答覆是重做/重跑的輸入,不可空)');
  }
  return errs;
}

// ── review 欄位硬驗:produce 成功記回必須交代「這一站的審查怎麼做的」。────────────
// review map 是人類 gate 凍結的審查策略;不驗的話「跳過 reviewer 直接記 ok:true」只能靠
// SKILL 自律。這裡把它變成引擎守門:深度不得低於 review map 要求(未列預設 full、fail-closed;
// last_failure 非空的重做一律升級 full),full / focused 必附落盤的 reviewer 結論檔(record),
// defer-until-signal 只在該 spec 有機器測試護欄(requires_test + test)時合法。
const REVIEW_DEPTHS = ['full', 'focused', 'defer-until-signal'];
const REVIEW_RANK = { 'defer-until-signal': 0, focused: 1, full: 2 };
function requiredReviewDepth(m, specId) {
  const s = m.specs[specId];
  if (s.review_gate === true) return 'full';        // gate spec(intake)固定對抗式 full
  if (s.last_failure != null) return 'full';        // 重做 = 升級訊號
  const entry = (((m.planning || {}).review_map) || []).find(e => isPlainObject(e) && e.task === specId);
  return entry && REVIEW_DEPTHS.includes(entry.review_depth) ? entry.review_depth : 'full';
}
function validateReview(m, specId, r) {
  const errs = [];
  const rv = r.review;
  const required = requiredReviewDepth(m, specId);
  if (!isPlainObject(rv)) {
    return [`produce 成功記回必須帶 review 欄位(此 spec 要求的審查深度:${required});` +
            `形狀:{ "depth": "full|focused|defer-until-signal", "record": "<reviewer 結論檔路徑>" }(defer 免 record)`];
  }
  if (!REVIEW_DEPTHS.includes(rv.depth)) {
    return [`review.depth「${rv.depth}」不合法(可用: ${REVIEW_DEPTHS.join(' / ')})`];
  }
  if (REVIEW_RANK[rv.depth] < REVIEW_RANK[required]) {
    errs.push(`review.depth「${rv.depth}」低於此 spec 要求的「${required}」(review map 未列預設 full;last_failure 非空的重做一律 full)`);
  }
  if (rv.depth === 'defer-until-signal') {
    const s = m.specs[specId];
    const hasTest = Object.values(m.tests || {}).some(t => t.verifies === specId);
    if (s.requires_test !== true || !hasTest) {
      errs.push('defer-until-signal 只能用於 requires_test:true 且至少有一個 test verifies 它的 spec(沒有機器護欄不得略過 reviewer)');
    }
  } else if (typeof rv.record !== 'string' || !rv.record.trim()) {
    errs.push('full / focused 審查必須帶 review.record(reviewer 結論檔路徑,落盤供追溯)');
  }
  return errs;
}

const [cmd, manifestPath, arg1, arg2] = process.argv.slice(2);
if (!cmd || !manifestPath) {
  fail('用法: node cli.js <next|next-all|produce|test|resume> <manifest> [args]');
}

// ── next:讀狀態,印出「下一步該做什麼」(單一)。發派授權寫進 orchestration.leases,
// 不動任何 spec / test 狀態;同樣的狀態重呼叫得到同樣的 action 與授權(冪等)。──────────
if (cmd === 'next') {
  const m = load(manifestPath);
  const r = decide(m, ctxOf(m));
  refreshLeases(m);
  save(manifestPath, m);
  out(enrichDecision(m, r));
  process.exit(0);
}

// ── next-all:印出「此刻所有可平行的 action」(批次),並發派授權(同 next,冪等)。────────
// 非同步 / 平行 runtime 用:回 { type:'batch', actions:[...] } / { type:'done' } /
// { type:'halt', reason }。actions 裡的 produce/test 彼此無依賴邊,可同時委派子代理跑;
// 但結果一律序列記回(逐一 cli.js produce / test),平行的只有 worker 做事,不是改 manifest。
if (cmd === 'next-all') {
  const m = load(manifestPath);
  const r = decideAll(m, ctxOf(m));
  refreshLeases(m);
  save(manifestPath, m);
  out(enrichDecision(m, r));
  process.exit(0);
}

// ── produce:把 worker 跑完一個 spec 的結果寫回 manifest,並推進一個回合。────
if (cmd === 'produce') {
  if (!arg1) fail('produce 需要 <specId>');
  const m = load(manifestPath);
  if (!m.specs[arg1]) fail(`manifest 沒有 spec「${arg1}」`);
  requireLease(m, `produce:${arg1}`);
  const result = arg2 ? load(arg2) : { ok: true };

  const verrs = validateProduceResult(m, arg1, result);
  if (verrs.length) fail(`result.json 不合法(manifest 未變動、回合未增,修正後重新記回):\n  - ${verrs.join('\n  - ')}`);

  // outputs 存在性:宣稱寫了的檔必須真的在磁碟上(對所有 worker 的「謊報寫檔」做一刀通用的
  // 確定性守門——outputs 是下游站的輸入與 review gate 給使用者看的東西,記回前先驗真)。
  if (result.ok !== false && Array.isArray(result.outputs)) {
    const missing = result.outputs.filter(p => !fs.existsSync(path.resolve(p)));
    if (missing.length) fail(`outputs 裡的檔不存在於磁碟(worker 宣稱寫了但沒寫?manifest 未變動、回合未增):\n  - ${missing.join('\n  - ')}\n  (執行目錄:${process.cwd()};outputs 路徑應相對於專案工作目錄)`);
  }

  // review 欄位硬驗(成功路徑):審查深度合規,且 full / focused 的 reviewer 結論檔真的落盤。
  if (result.ok !== false) {
    const rerrs = validateReview(m, arg1, result);
    if (rerrs.length) fail(`result.json 不合法(manifest 未變動、回合未增,修正後重新記回):\n  - ${rerrs.join('\n  - ')}`);
    if (result.review.record && !fs.existsSync(path.resolve(result.review.record))) {
      fail(`review.record 指向的檔不存在於磁碟:${result.review.record}(reviewer 結論必須落盤;manifest 未變動、回合未增。執行目錄:${process.cwd()})`);
    }
  }

  // requires_test 第二道防線(第一道在 validate):宣告必測的 spec 若沒有任何 test verifies 它,
  // 記回成功會走「無 test → 直接 verified」靜默跳過驗證——在記回前擋下,逼 manifest 修正。
  if (result.ok !== false && m.specs[arg1].requires_test === true &&
      !Object.values(m.tests || {}).some(t => t.verifies === arg1)) {
    fail(`spec「${arg1}」宣告 requires_test,但 manifest 沒有任何 test verifies 它——記回成功會被靜默跳過驗證。請補上 test 節點(或修正宣告)再記回(manifest 未變動、回合未增)`);
  }

  applyProduce(m, arg1, result);

  // 審查紀錄落盤到 manifest(執行期欄位,由 cli 寫):供 audit 與下一輪升級判斷追溯。
  if (result.ok !== false) {
    m.specs[arg1].last_review = { depth: result.review.depth, record: result.review.record || null };
  }

  // 守門擋下:worker 報 ok,但產出命中 spec 宣告的 forbid_outputs / allowed_outputs → applyProduce 已改判 failed。
  // 偵測法 = 「沒回報失敗、卻變成 failed」,以便比照一般 produce 失敗留訊號並對 orchestrator 揭露原因。
  const guardRejected = result.ok !== false && m.specs[arg1].status === 'failed';

  const ctx = ctxOf(m);
  ctx.turn += 1;                       // 執行了一個動作 → 回合 +1(終止保證靠它)
  if (result.ok === false) {
    // produce 失敗也要留訊號,否則無進度偵測對「一直重跑壞掉的 skill」是瞎的。
    // 一律 target-first(被歸咎的那個 spec 開頭),讓 terminationGuard 的 split(':')[0] 取得正確 target:
    // 往前 blame → 以上游 spec 為 target;否則 → 以這個 spec 自己為 target。
    const sig = result.blame ? `${result.blame}:blame` : `${arg1}:${result.fix_target || 'code'}`;
    ctx.failSignals = ctx.failSignals.concat(sig);
  } else if (guardRejected) {
    // 被守門擋下也是失敗 → 同樣留訊號,讓「反覆越界產出」也能被震盪偵測抓到、停下問人。
    ctx.failSignals = ctx.failSignals.concat(`${arg1}:${m.specs[arg1].fix_target || 'code'}`);
  } else {
    // 成功 = 這個 spec 有進度 → 只清掉「它自己」的震盪訊號(per-target,非整窗;見 clearSignalsFor)。
    // 往前 blame 的訊號 target 是上游 spec,等上游被重做(也走這條 produce 成功)時自然清掉。
    ctx.failSignals = clearSignalsFor(ctx.failSignals, arg1);
  }
  writeCtx(m, ctx);
  refreshLeases(m, `produce:${arg1}`);   // 消耗本次授權;重做等新授權由記回後的狀態重新算出
  save(manifestPath, m);

  // review gate:產出成功但 spec 宣告 review_gate → applyProduce 已標 blocked(kind:'review'),
  // 對 orchestrator 揭露「這不是失敗,是停下等使用者查看」,下一個 next 會回 clarify(kind:'review')。
  const reviewGated = result.ok !== false && m.specs[arg1].status === 'blocked' && m.specs[arg1].block_kind === 'review';

  out({ recorded: 'produce', spec: arg1, status: m.specs[arg1].status, turn: ctx.turn,
        ...(result.ok === false ? { failed: true, blame: result.blame || null } : {}),
        ...(guardRejected ? { failed: true, rejected: 'output_guard', reason: m.specs[arg1].last_failure } : {}),
        ...(reviewGated ? { review_gate: true, clarify: m.specs[arg1].clarify } : {}),
        ...nextStep(m) });
  process.exit(0);
}

// ── test:把一次 test 結果寫回 manifest。掛了會自動查出該回頭修哪個 spec / 標 blocked。────
if (cmd === 'test') {
  if (!arg1) fail('test 需要 <testId>');
  if (!arg2) fail('test 需要 <result.json>(內含 { pass, altitude|verdict, blame?, reason, evidence?, env_patch? })');
  const m = load(manifestPath);
  if (!m.tests[arg1]) fail(`manifest 沒有 test「${arg1}」`);
  requireLease(m, `test:${arg1}`);
  const result = load(arg2);

  const verrs = validateTestResult(m, arg1, result);
  if (verrs.length) fail(`result.json 不合法(manifest 未變動、回合未增,修正後重新記回):\n  - ${verrs.join('\n  - ')}`);

  applyTestResult(m, arg1, result);

  // env_patch:worker(如 ui-e2e)偵測到的啟動方式等,經 cli 寫進 manifest.env
  // (維持「狀態變更只經 cli.js」慣例,worker 不直接改 manifest)。不論 pass/fail 都套用。
  if (result.env_patch && typeof result.env_patch === 'object') {
    m.env = Object.assign({}, m.env, result.env_patch);
  }

  const altitude = altitudeOf(result);

  const ctx = ctxOf(m);
  ctx.turn += 1;
  if (!result.pass) {
    // 無進度訊號:target-first + 性質(altitude),不含 reason 文字(見 decide.js terminationGuard)。
    // environment 不歸咎 spec → 以「跑不起來的 test」為 target(它本就會立刻 block,不會累積到震盪)。
    const sigTarget = altitude === 'environment' ? arg1 : blameTargetId(m, arg1, result);
    ctx.failSignals = ctx.failSignals.concat(`${sigTarget}:${altitude}`);
  } else {
    // 通過 = 被測 spec(與該 test)有進度 → 只清這兩個 target 的震盪訊號,不洗別節點(見 produce 成功路徑註)。
    ctx.failSignals = clearSignalsFor(ctx.failSignals, m.tests[arg1].verifies, arg1);
  }
  writeCtx(m, ctx);
  refreshLeases(m, `test:${arg1}`);   // 消耗本次授權;重跑 / 重做的新授權由記回後的狀態算出
  save(manifestPath, m);

  if (result.pass) {
    out({ recorded: 'test', test: arg1, pass: true, spec: m.tests[arg1].verifies, turn: ctx.turn,
          ...nextStep(m) });
  } else if (altitude === 'environment') {
    // manifest 層級 block:不歸咎任何 spec,等使用者修好環境後 `resume <testId>` 重跑該 test
    out({ recorded: 'test', test: arg1, pass: false, altitude: 'environment', blocked: true,
          scope: 'environment', clarify: m.block.question, turn: ctx.turn, ...nextStep(m) });
  } else if (altitude === 'requirement') {
    const target = blameTargetId(m, arg1, result);
    out({ recorded: 'test', test: arg1, pass: false, altitude: 'requirement', blocked: true,
          spec: target, clarify: m.specs[target].clarify, turn: ctx.turn, ...nextStep(m) });
  } else {
    const target = blameTargetId(m, arg1, result);
    out({ recorded: 'test', test: arg1, pass: false, altitude,
          go_back_to: target, fix_target: m.specs[target].fix_target, turn: ctx.turn, ...nextStep(m) });
  }
  process.exit(0);
}

// ── resume:把使用者對 clarify 的答覆寫回,解除 blocked、續跑。────
if (cmd === 'resume') {
  if (!arg1) fail('resume 需要 <specId 或 testId>');
  if (!arg2) fail('resume 需要 <answer.json>(內含 { answer, reopen?:"pending"|"failed", approve?:true };review gate 同意續跑用 {"approve":true})');
  const m = load(manifestPath);
  const answer = load(arg2);

  const isEnvBlock = !!(m.block && m.block.test === arg1 && m.tests[arg1]);
  if (!isEnvBlock && !m.specs[arg1]) fail(`resume 找不到可解除的對象「${arg1}」(既非 blocked spec,也非 environment block 的 test)`);

  // resume 只能解除「引擎此刻停在的對象」:blocked spec、environment block 的 test、或震盪
  // clarify 指向的 spec(status 可能是 failed)。開放任意 spec 會讓 reopen 變成繞過流程的重做後門。
  if (!isEnvBlock && m.specs[arg1].status !== 'blocked') {
    const cur = decide(m, ctxOf(m));
    if (!(cur.type === 'clarify' && cur.spec === arg1)) {
      fail(`spec「${arg1}」不是引擎停下的 clarify 對象(status=${m.specs[arg1].status}),resume 不適用。要重做請走正常失敗路徑(produce / test 記回失敗)`);
    }
  }

  // 先解析目標的 clarify kind 再驗 answer:review gate 與其他 kind 的合法形狀不同。
  const kind = isEnvBlock ? m.block.kind : (m.specs[arg1].block_kind || null);
  const verrs = validateResumeAnswer(kind, answer);
  if (verrs.length) fail(`answer.json 不合法(manifest 未變動、回合未增,修正後重新 resume):\n  - ${verrs.join('\n  - ')}`);

  let targetDesc;
  if (isEnvBlock) {
    applyResumeEnv(m, answer);                       // environment:只重跑該 test,不動任何 spec
    targetDesc = { test: arg1, status: m.tests[arg1].status };
  } else {
    applyResume(m, arg1, answer);                    // requirement / 震盪 / review:解除 spec blocked、續跑
    targetDesc = { spec: arg1, status: m.specs[arg1].status };
  }

  const ctx = ctxOf(m);
  ctx.turn += 1;
  // 釐清 = 這個 target(被 resume 的 spec 或 environment block 的 test)有進度 → 只清它的震盪訊號。
  ctx.failSignals = clearSignalsFor(ctx.failSignals, arg1);
  writeCtx(m, ctx);
  refreshLeases(m);   // 解除 blocked 後世界改變,重算本輪授權
  save(manifestPath, m);

  out({ recorded: 'resume', ...targetDesc, turn: ctx.turn });
  process.exit(0);
}

// ── validate:bootstrap 後的結構自檢(唯讀,不改 manifest)。──────────────
// 引擎(decide.js)對「懸空參照」與「依賴成環」不會報錯,只會讓相關節點永遠不 ready、
// 最後撞 halt(「無可執行動作」),難以診斷。這支在凍結前/後給一個明確紅燈:
// 檢查 spec.depends_on / test.verifies / test.depends_on 都指向存在的節點、且 spec 依賴無環。
// 回 { ok:true, ... }(exit 0)或 { ok:false, errors:[...] }(exit 1,可當 gate 用)。
if (cmd === 'validate') {
  const m = load(manifestPath);
  const specs = m.specs || {};
  const tests = m.tests || {};
  const errors = [];

  if (!Object.keys(specs).length) errors.push('manifest 沒有任何 spec');

  for (const [id, s] of Object.entries(specs)) {
    if (s.id !== id) errors.push(`spec「${id}」的 id 欄位(${s.id})與 key 不一致`);
    for (const d of (s.depends_on || []))
      if (!specs[d]) errors.push(`spec「${id}」depends_on 指向不存在的 spec「${d}」`);
    if (s.tier !== undefined && !['high', 'low'].includes(s.tier))
      errors.push(`spec「${id}」tier「${s.tier}」不合法(可用: high / low)`);
    // requires_test:flow 宣告「此 spec 必須被測」,凍結前就要掛好 test,否則 produce 後
    // 會走「無 test → 直接 verified」靜默跳過測試站(produce 記回時還有第二道防線)。
    if (s.requires_test === true && !Object.values(tests).some(t => t.verifies === id))
      errors.push(`spec「${id}」宣告 requires_test,但沒有任何 test verifies 它(測試站會被靜默跳過)`);
  }
  for (const [id, t] of Object.entries(tests)) {
    if (t.id !== id) errors.push(`test「${id}」的 id 欄位(${t.id})與 key 不一致`);
    if (!specs[t.verifies]) errors.push(`test「${id}」verifies 指向不存在的 spec「${t.verifies}」`);
    for (const d of (t.depends_on || []))
      if (!tests[d]) errors.push(`test「${id}」depends_on 指向不存在的 test「${d}」`);
  }

  // review_map 是 orchestrator 的策略資料,不參與 decide.js routing;但 defer 代表 produce 前
  // 合法略過 reviewer,所以凍結前必須確定它後面一定接得到機器驗證,否則會靜默沒有現實接觸。
  const reviewMap = (m.planning || {}).review_map;
  if (reviewMap !== undefined && !Array.isArray(reviewMap)) {
    errors.push('planning.review_map 必須是 array');
  } else {
    for (const entry of (reviewMap || [])) {
      if (!isPlainObject(entry)) { errors.push('planning.review_map 含非 object 項目'); continue; }
      const id = entry.task;
      if (typeof id !== 'string' || !id.trim()) { errors.push('planning.review_map 每一項都必須有 task(string)'); continue; }
      const s = specs[id];
      if (!s) { errors.push(`review_map 指向不存在的 spec「${id}」`); continue; }
      if (!['full', 'focused', 'defer-until-signal'].includes(entry.review_depth)) {
        errors.push(`review_map spec「${id}」的 review_depth「${entry.review_depth}」不合法(可用: full / focused / defer-until-signal)`);
        continue;
      }
      if (entry.review_depth === 'defer-until-signal') {
        const hasTest = Object.values(tests).some(t => t.verifies === id);
        if (s.requires_test !== true || !hasTest) {
          errors.push(`review_map 將 spec「${id}」標為 defer-until-signal,但該 spec 必須 requires_test:true 且至少有一個 test verifies 它`);
        }
      }
    }
  }

  // 依賴環檢測(DFS 三色):有環 → 相關節點永遠不 ready → halt「無可執行動作」,先在這裡擋下。
  // spec.depends_on 與 test.depends_on 都要檢:test 成環的症狀一樣難診斷(spec 卡在 produced)。
  const cycleCheck = (nodes, label) => {
    const color = {};   // undefined=white / 1=gray(在當前路徑上) / 2=black(已完成)
    const visit = (id, path) => {
      color[id] = 1;
      for (const d of ((nodes[id] && nodes[id].depends_on) || [])) {
        if (!nodes[d]) continue;                       // 懸空已在上面報過,跳過
        if (color[d] === 1) { errors.push(`${label} 依賴成環:${[...path, id, d].join(' → ')}`); continue; }
        if (color[d] !== 2) visit(d, [...path, id]);
      }
      color[id] = 2;
    };
    for (const id of Object.keys(nodes)) if (!color[id]) visit(id, []);
  };
  cycleCheck(specs, 'spec');
  cycleCheck(tests, 'test');

  if (errors.length) { out({ ok: false, errors }); process.exit(1); }
  out({ ok: true, specs: Object.keys(specs).length, tests: Object.keys(tests).length });
  process.exit(0);
}

fail(`未知指令「${cmd}」。可用: next / next-all / produce / test / resume / validate`);
