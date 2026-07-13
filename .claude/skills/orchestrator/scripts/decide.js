// decide.js — runtime 無關的「編排大腦」。
// Claude Code 的 Workflow 腳本與你自建環境共用同一份。
// 輸入:manifest(唯一事實來源) + ctx(回合數 / 上限 / 進度紀錄)
// 輸出:一個 action,描述「下一步該做什麼」。
// 100% 確定性:無 LLM、無記憶、同樣的 manifest 一定得到同樣的決策。
'use strict';

function depsVerified(m, spec) {
  return spec.depends_on.every(id => m.specs[id] && m.specs[id].status === 'verified');
}
function testsOf(m, specId) {
  return Object.values(m.tests).filter(t => t.verifies === specId);
}
// test 可以有 depends_on(指向同 manifest 的其他 test id):它的前置 test 全 pass 才可跑。
// 用途:讓 e2e(ui-e2e)排在 unit(unit-tests)之後——把排序變成 manifest 事實,
// 而非隱性 insertion order。無 depends_on 的 test 視為無前置,行為與舊版一致。
function testDepsMet(m, t) {
  return (t.depends_on || []).every(id => m.tests[id] && m.tests[id].status === 'pass');
}
function pendingTest(m, specId) {
  return testsOf(m, specId).find(t => t.status !== 'pass' && testDepsMet(m, t));
}

// ── 終止保證:任何「即使沒成功也會停」的硬出口 ──────────────────
// 回傳 null(可繼續) / { type:'halt', reason }(放棄) / { type:'clarify', ... }(停下問人)。
// 兩種停法:maxTurns → halt(放棄);無進度震盪 → clarify(問人,可續)而非直接放棄。
function terminationGuard(m, ctx) {
  if (ctx.turn >= ctx.maxTurns)
    return { type: 'halt', reason: `達到最大回合上限 ${ctx.maxTurns}` };
  // 無進度偵測(v2):改「窗口內同一訊號出現 K 次」(頻率),不再只看「連續 K 次相同」。
  // 某 target 一有進度,cli.js 只清掉「該 target」的訊號(per-target,非整窗——平行批次下別節點
  // 的進度才不會洗掉它正在累積的震盪證據);故每個 target 各自維持一段未解決 episode,在窗口內同一
  // {target}:{altitude} 累計達 K 次 = 同一問題反覆/震盪(含修A壞B的交替,各自累計達 K)。
  // 識別鍵只用 target+altitude(訊號前綴),不含 reason 文字——否則 LLM 每輪措辭略異會讓
  // 計數永遠湊不到 K、護欄失效。reason 只進 last_failure 做診斷,不進識別鍵。
  const h = ctx.failSignals, K = ctx.noProgressK;
  const counts = {};
  for (const s of h) {
    counts[s] = (counts[s] || 0) + 1;
    if (counts[s] >= K) {
      const target = String(s).split(':')[0];        // 訊號一律 target-first(見 cli.js)
      const spec = m.specs[target];
      return {
        type: 'clarify', spec: target, kind: 'oscillation',
        question: (spec && (spec.clarify || spec.last_failure)) ||
                  `反覆失敗訊號「${s}」累計 ${K} 次,疑似震盪,需使用者釐清`,
      };
    }
  }
  return null;
}

// ── 核心:讀 manifest 狀態,挑下一步 ──────────────────────────
function decide(m, ctx) {
  const stop = terminationGuard(m, ctx);       // 0. 硬性出口永遠先判(halt 或 震盪 clarify)
  if (stop) return stop;

  const specs = Object.values(m.specs);

  // 0.4 停下問人(manifest 層級):environment 與任何 phase 無關 → 不歸咎 spec,掛 m.block。
  //     先於 spec 層級 blocked 檢查:它指向「跑不起來的 test」,resume 後只重跑該 test。
  if (m.block) return { type: 'clarify', test: m.block.test, question: m.block.question, kind: m.block.kind };

  // 0.5 停下問人(spec 層級):有 spec 被標 blocked(altitude=requirement / 震盪)→ 先問,不前進。
  //     刻意全域停:需要人輸入時 surface 出來,而不是繞過它churn 其他工作。答覆後 resume 續跑。
  const blocked = specs.find(s => s.status === 'blocked');
  if (blocked) return { type: 'clarify', spec: blocked.id, question: blocked.clarify, kind: blocked.block_kind };

  // 1. 被回頭標成 failed 的 spec → 優先重做(這就是「回頭」)
  const broken = specs.find(s => s.status === 'failed' && depsVerified(m, s));
  if (broken) return { type: 'produce', spec: broken.id, reason: `${broken.id} 被回頭,重新產出` };

  // 2. 還有 test 沒通過 → 先驗證在製品(優先於開新工作)。produced 與 verified 都納入:
  //    正常 verified spec 其 test 全 pass,pendingTest 回 undefined → 略過,等同舊行為;只有
  //    被授權補了新 pending test(如補跑 e2e)時才取到,使其完全經引擎、不需手改 status。
  const toTest = specs.find(s => (s.status === 'produced' || s.status === 'verified') && pendingTest(m, s.id));
  if (toTest) return { type: 'test', test: pendingTest(m, toTest.id).id, spec: toTest.id };

  // 3. pending 且依賴都已 verified → 產出新工作
  const ready = specs.find(s => s.status === 'pending' && depsVerified(m, s));
  if (ready) return { type: 'produce', spec: ready.id, reason: '依賴齊備,產出' };

  // 4. 全部 verified → 完成
  if (specs.length && specs.every(s => s.status === 'verified')) return { type: 'done' };

  // 5. 沒事可做又沒完成 = 卡死(例如依賴永遠不滿足)
  return { type: 'halt', reason: '無可執行動作,可能依賴無法滿足' };
}

// ── decideAll:回傳「此刻所有可平行的 action」(async / 平行 runtime 用)──────
// decide() 一次挑一個(sync);decideAll() 把同一輪所有 runnable 的都列出來。
// 平行性不是這裡「判斷」出來的,是 manifest 的 depends_on 圖「算」出來的:
// 任兩個同時 ready 的 spec,誰都不可能是對方還沒 verified 的依賴——因為某 spec 要
// ready,它 depends_on 的全部必須 verified;若 A 依賴 B 而 B 未好,A 不會 ready,
// 若 B 已 verified,B 又不在 ready 集裡。故 ready 集合裡沒有父子對,彼此無依賴邊 →
// 可安全平行。狀態套用仍須序列(見 cli.js / orchestrator),平行的只有 worker 做事。
// 注意:依賴獨立 ≠ 檔案獨立——next-all 只保證 manifest 的 depends_on 互不依賴,不保證
// worker 寫入的檔案範圍不重疊;平行安全還要靠 flow/spec 讓輸出路徑不重疊或只讀(見 SKILL)。
// 分組順序與 decide() 的優先序一致(failed 重做 → test → produce),且兩者都用同一個
// Object.values 走訪序,因此在目前排序規則下 decideAll 的第一個動作與 decide() 相容——
// 這是「同步退化相容」,不是對未來改排序策略的承諾。
function decideAll(m, ctx, options = {}) {
  const stop = terminationGuard(m, ctx);
  if (stop) return { ...stop, actions: [] };

  const specs = Object.values(m.specs);

  // 停下問人優先(與 decide 一致):manifest 層級 block(environment)先於 spec 層級 blocked。
  if (m.block) return { type: 'clarify', test: m.block.test, question: m.block.question, kind: m.block.kind, actions: [] };
  const blocked = specs.find(s => s.status === 'blocked');
  if (blocked) return { type: 'clarify', spec: blocked.id, question: blocked.clarify, kind: blocked.block_kind, actions: [] };

  const actions = [];

  // 1. 所有被回頭的 failed spec(依賴已齊)→ 重做
  for (const s of specs)
    if (s.status === 'failed' && depsVerified(m, s))
      actions.push({ type: 'produce', spec: s.id, reason: `${s.id} 被回頭,重新產出` });

  // 2. 每個 produced / verified spec 預設只取一個 test。只有 test 明示 parallel_safe:true，
  //    且 resource_keys 與本批已選 test 不衝突時，才允許同 spec 多 test 平行。
  //    produced spec 的 test 必 pending/pass(fail 會同時把 spec 轉 failed → 落上面重做分支);
  //    verified spec 一般 test 全 pass、find 回 undefined 自動略過,只有補了新 pending test 才取到。
  //    刻意每 spec 每輪只取一個:同一 spec 的多個 test 常共用同一套 runner / 工作區,
  //    平行跑會互踩(搶寫同檔、同 port…);不同 spec 的 test 仍各自平行。剩下的
  //    test 下一輪再取(且若這個先 fail,fail-fast 還省下其餘平行跑)。
  const usedResources = new Set();
  for (const s of specs)
    if (s.status === 'produced' || s.status === 'verified') {
      const ready = testsOf(m, s.id).filter(x => x.status !== 'pass' && testDepsMet(m, x));
      for (const t of ready) {
        const keys = Array.isArray(t.resource_keys) ? t.resource_keys : [];
        const conflict = keys.some(key => usedResources.has(key));
        const alreadySelected = actions.some(a => a.type === 'test' && a.spec === s.id);
        if (conflict || (alreadySelected && t.parallel_safe !== true)) continue;
        actions.push({ type: 'test', test: t.id, spec: s.id, ...(keys.length ? { resource_keys: keys } : {}) });
        keys.forEach(key => usedResources.add(key));
        if (t.parallel_safe !== true) break;
      }
    }

  // 3. 所有依賴已齊的 pending spec → 產出
  for (const s of specs)
    if (s.status === 'pending' && depsVerified(m, s))
      actions.push({ type: 'produce', spec: s.id, reason: '依賴齊備,產出' });

  if (actions.length) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : actions.length;
    return { type: 'batch', actions: actions.slice(0, limit), total_ready: actions.length };
  }

  // 沒有 runnable:全 verified → done,否則卡死
  if (specs.length && specs.every(s => s.status === 'verified')) return { type: 'done', actions: [] };
  return { type: 'halt', reason: '無可執行動作,可能依賴無法滿足', actions: [] };
}

// ── 共用小工具:從 result 解出「性質軸 altitude」與「定位軸 target spec-id」──
// 兩處(decide 的 applyTestResult、cli.js 的輸出/訊號)都用同一份,避免 target 規則在兩邊漂移。
function altitudeOf(result) {
  return result.altitude || result.verdict || 'code';   // 向後相容:舊 verdict 直接當 altitude
}
// 失敗該歸到哪個 spec-id:有 blame 且該 spec 存在 → 用 blame(可指上游,一跳直達);否則預設被測 spec。
// 注意:environment 不歸咎任何 spec(見 applyTestResult),此函數只用於 code / spec / requirement。
function blameTargetId(m, testId, result) {
  return (result.blame && m.specs[result.blame]) ? result.blame : m.tests[testId].verifies;
}

// ── 把一次 test 結果套用到 manifest(v2:定位軸 blame + 性質軸 altitude 四向)──
// result 形狀:{ pass:true } 或
//   { pass:false, blame?:specId, altitude:'code'|'spec'|'requirement'|'environment',
//     reason:string, evidence?:object }
//   - blame(定位軸):根因在哪個 spec 節點(= 哪一站)。省略時預設 = t.verifies。
//   - altitude(性質軸):code=做歪了(只重做、不 cascade);spec=規格錯(重做+cascade);
//     requirement=需求欠明確 → 該 spec 標 blocked、停下問人(需求對應某一站,有 phase 可歸);
//     environment=基礎設施錯(app 起不來 / 後端不通)→ 與任何 phase 內容無關 → 標 manifest 層級
//       block(m.block),**不歸咎、不重做、不 cascade 任何 spec**;resume 後只重跑卡住的那個 test。
//   向後相容:舊 { pass:false, verdict:'spec'|'code' } 自動映射成同名 altitude、blame 預設 t.verifies。
function applyTestResult(m, testId, result) {
  const t = m.tests[testId];
  const specId = t.verifies;

  if (result.pass) {
    t.status = 'pass';
    t.last_fail = null;
    if (testsOf(m, specId).every(x => x.status === 'pass'))
      m.specs[specId].status = 'verified';     // 該 spec 的 test 全過 → verified
    return;
  }

  const altitude = altitudeOf(result);

  t.status = 'fail';
  t.last_fail = result.reason || null;
  if (result.evidence) t.evidence = result.evidence;   // 結構化證據另存,不污染 last_fail(string)

  if (altitude === 'environment') {
    // 基礎設施錯 → 與任何 phase 內容無關:不歸咎、不重做、不 cascade 任何 spec。
    // 改標 manifest 層級 block,掛在「跑不起來的那個 test」上;decide 看到 m.block 即轉 clarify。
    // resume 後只重跑該 test(見 applyResumeEnv),不會白白重做一個其實沒問題的 spec。
    m.block = { kind: 'environment', test: testId,
                question: result.reason || `${testId} 無法執行(environment),需使用者釐清` };
    return;
  }

  const target = (result.blame && m.specs[result.blame]) ? m.specs[result.blame] : m.specs[specId];

  if (altitude === 'requirement') {
    // 需求欠明確 → 該 spec(其需求有歧義的那一站)標 blocked,由 decide 轉 clarify 問人;不 cascade。
    target.status = 'blocked';
    target.clarify = result.reason || `${testId} 失敗(requirement),需使用者釐清`;
    target.block_kind = 'requirement';
    return;
  }

  // code / spec → 標 failed 由 decide 規則 1 重做(target 可為任一節點,含上游 → 一跳直達)
  target.status = 'failed';
  target.last_failure = result.reason || null;
  target.fix_target = altitude === 'spec' ? 'spec' : 'code';
  if (altitude === 'spec') cascadeInvalidate(m, target.id);   // 規格語意變 → 串級下游重驗
}

// ── 串級失效:依賴改動 spec 的下游,退回 pending 重驗(回答你的問題 3)──
function cascadeInvalidate(m, changedSpecId) {
  for (const s of Object.values(m.specs)) {
    if (s.depends_on.includes(changedSpecId) && s.status !== 'pending') {
      s.status = 'pending';
      testsOf(m, s.id).forEach(t => { t.status = 'pending'; });
    }
  }
}

// ── 產出守門:flow 在 spec 上宣告 forbid_outputs(glob 樣式陣列),本站產出命中任一樣式
//    即視為越界(這站不該產這種檔,該交給負責它的站)。引擎只做樣式比對,不認得任何
//    flow-specific 語意(「測試檔」「scaffold」都不知道)——那些知識留在 flow 定義裡,
//    由 bootstrap 把樣式填進對應 spec。`*` 為萬用字元(跨路徑分隔),其餘字元照字面比對。
function globToRegExp(pattern) {
  const body = String(pattern).split('*')
    .map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + '$');
}
function forbiddenOutputs(spec, outputs) {
  const pats = Array.isArray(spec.forbid_outputs) ? spec.forbid_outputs : [];
  if (!pats.length || !Array.isArray(outputs)) return [];
  const rxs = pats.map(globToRegExp);
  return outputs.filter(o => rxs.some(rx => rx.test(String(o))));
}
function disallowedOutputs(spec, outputs) {
  const pats = Array.isArray(spec.allowed_outputs) ? spec.allowed_outputs : [];
  if (!pats.length || !Array.isArray(outputs)) return [];
  const rxs = pats.map(globToRegExp);
  return outputs.filter(o => !rxs.some(rx => rx.test(String(o))));
}

// ── 把一次 produce 結果套用到 manifest(worker 跑完 skill 後回報)──
// result 三種:
//   { ok:true, outputs:[...] }                          產出成功
//   { ok:false, reason, fix_target:'spec'|'code' }       這個 spec 自己產不出來 → 重做它
//   { ok:false, reason, blame:'spec-1', fix_target? }    真正的問題在更前面的 spec → 往前修
//     (blame 時 fix_target 預設 'spec'(語意錯居多);上游產物格式壞掉等 code 層問題可明示 'code')
function applyProduce(m, specId, result) {
  const s = m.specs[specId];
  result = result || { ok: true };

  if (result.ok === false) {
    // (a) 往前歸咎:worker 判定根因在更上游的某個 spec(回答「前面的 skill 才是問題」)
    if (result.blame && m.specs[result.blame] && result.blame !== specId) {
      const up = m.specs[result.blame];
      up.status = 'failed';
      up.last_failure = result.reason || `下游 ${specId} 指出根因在 ${result.blame}`;
      up.fix_target = result.fix_target === 'code' ? 'code' : 'spec';
      cascadeInvalidate(m, result.blame);     // 上游要重做 → 依賴它的下游一律退回重驗
      s.status = 'pending';                    // 自己先退回 pending,等上游修好、依賴重新 verified
      s.last_failure = null;
      return;
    }
    // (b) 就是這個 spec 自己產不出來 → 標 failed,由 decide 規則 1 接手重做
    s.status = 'failed';
    s.last_failure = result.reason || 'produce 失敗';
    s.fix_target = result.fix_target || 'code';
    return;
  }

  // 產出守門(成功路徑先過):本站產出命中宣告的 forbid_outputs → 不記成功,改判 code 失敗
  // 回頭重做(沿用既有 failed→規則1 重做機制)。把「誰能產哪種檔」從 skill 軟自律變成引擎硬約束。
  const offending = forbiddenOutputs(s, result.outputs);
  if (offending.length) {
    s.status = 'failed';
    s.last_failure = `本站不得產生這些檔(命中 forbid_outputs):${offending.join(', ')};` +
      `禁止樣式:${s.forbid_outputs.join(', ')}。請移除越界產物,該類檔交由負責它的站處理。`;
    s.fix_target = 'code';
    return;
  }

  // 產出白名單守門:flow 可用 allowed_outputs 把分片鎖在自己的檔案 ownership 內。
  // 未宣告 allowed_outputs 的 spec 維持舊行為。
  const outside = disallowedOutputs(s, result.outputs);
  if (outside.length) {
    s.status = 'failed';
    s.last_failure = `本站只能產生 allowed_outputs 允許的檔,但回報了:${outside.join(', ')};` +
      `允許樣式:${s.allowed_outputs.join(', ')}。請把越界修改移到擁有該檔的 spec,或修正 feature-plan / manifest ownership。`;
    s.fix_target = 'code';
    return;
  }

  // 冪等:重做時先把它的 test 全部重置,避免沿用上一輪的結果
  testsOf(m, specId).forEach(t => { t.status = 'pending'; t.last_fail = null; });
  s.last_failure = null;
  s.fix_target = null;
  if (Array.isArray(result.outputs)) {
    // retained_outputs 只有 review_gate spec(重 intake 沿用上版文件)有效;一般 spec 一律忽略。
    s.outputs = s.review_gate
      ? [...new Set([...result.outputs, ...(result.retained_outputs || [])])]
      : result.outputs;
  }
  s.deleted = Array.isArray(result.deleted) ? result.deleted : [];
  if (s.review_gate) {
    // review gate:flow 在 spec 上宣告 review_gate:true → 產出成功也不前進,改標 blocked
    // (kind:'review'),decide 會轉 clarify 全域停下,讓使用者查看產出文件、討論後才續跑。
    // 與失敗無關:這是宣告式查看點。resume 帶 {approve:true} → 進 produced/verified;
    // 帶修改意見 → 照一般 resume 重做(意見進 last_failure),重做成功後再次 gate。
    s.status = 'blocked';
    s.block_kind = 'review';
    s.clarify = `${specId}(${s.skill})已產出,依 review_gate 停下等使用者查看。` +
      `產出檔:${(s.outputs || []).join(', ') || '(無檔案紀錄)'}。` +
      `請使用者查看並討論後 resume:同意續跑 → {"approve":true};要修改 → {"answer":"<修改意見>"}`;
  } else {
    // 有 test 的 spec → 等驗證;沒有 test 的 spec → 直接 verified
    s.status = testsOf(m, specId).length ? 'produced' : 'verified';
  }
  // 重新產出 → 串級讓「已驗過的下游」退回重驗,避免它們吃到舊上游輸出的髒狀態。
  // 失效因此能遞移整條鏈(spec-2 重做 → spec-3 退回 → spec-3 重做時再退回 spec-4…)。
  // 首次產出時下游都還是 pending,cascadeInvalidate 為 no-op,不造成額外擾動。
  cascadeInvalidate(m, specId);
}

// ── 把使用者對 clarify 的答覆套回 manifest,解除 blocked、續跑 ──────────────
// answer 形狀:{ answer:string, reopen?:'pending'|'failed', approve?:true }(預設 pending)。
// 效果:記錄答覆 → 清 blocked → status 改回 pending/failed → 把答覆當新輸入(last_failure)
// 餵給重做的 worker → 串級下游重驗。適用「明確 blocked 的 spec」與「震盪 clarify 指到的 spec」
// (後者 status 可能是 failed,本函數對 status 無前提,照樣解除並記錄)。
// review gate 特例:block_kind === 'review' 且 answer.approve === true → 使用者查看後同意,
// 內容沒變 → 不重做、不 cascade,直接接回 produce 成功原本該去的狀態(produced/verified)。
// review 下不帶 approve(帶修改意見)→ 走一般 reopen 路徑重做,重做成功後會再次 gate。
function applyResume(m, specId, answer) {
  const s = m.specs[specId];
  answer = answer || {};
  const wasReview = s.block_kind === 'review';
  s.clarifications = s.clarifications || [];
  s.clarifications.push({ question: s.clarify || null, answer: answer.answer || (answer.approve === true ? 'approved' : null), kind: s.block_kind || null });
  s.clarify = null;
  s.block_kind = null;
  if (wasReview && answer.approve === true) {
    s.status = testsOf(m, specId).length ? 'produced' : 'verified';
    return;
  }
  const reopen = answer.reopen === 'failed' ? 'failed' : 'pending';
  s.status = reopen;
  if (answer.answer) s.last_failure = answer.answer;       // 答覆 = 重做時的新輸入
  if (reopen === 'failed' && !s.fix_target) s.fix_target = 'spec';
  cascadeInvalidate(m, specId);                            // 語意可能變 → 下游退回重驗
}

// ── environment block 的 resume:使用者修好基礎設施後,只重跑卡住的那個 test,不動任何 spec ──
// 對應 m.block(environment 不歸咎 phase,故沒有 spec 要重做;spec 維持原狀,test 退回 pending 重跑)。
function applyResumeEnv(m, answer) {
  answer = answer || {};
  const b = m.block;
  if (!b) return;
  const t = m.tests[b.test];
  if (t) {
    t.clarifications = t.clarifications || [];
    t.clarifications.push({ question: b.question || null, answer: answer.answer || null, kind: b.kind || null });
    t.status = 'pending';     // 只重跑該 test;spec 不動(它本就沒問題)
    t.last_fail = null;
  }
  m.block = null;
}

module.exports = { decide, decideAll, applyProduce, applyTestResult, applyResume, applyResumeEnv, altitudeOf, blameTargetId, cascadeInvalidate, testsOf, forbiddenOutputs, disallowedOutputs };
