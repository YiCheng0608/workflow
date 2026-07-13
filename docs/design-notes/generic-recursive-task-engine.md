# 設計筆記:通用任務引擎

> 狀態:設計筆記;說明架構原理與取捨。操作契約以各 skill 的 `SKILL.md` 與 scripts 為準。

## 一、概觀

一個與任務類型無關的引擎(manifest + cli.js + decide.js),能接任意使用者任務並驅動到完成。引擎不認得任務領域,只讀 manifest 裡的通用欄位,依 `depends_on` 圖與狀態旗標確定性推進。

任務的拆解與驗收標準不預先寫死,而是在 `intake` 階段針對該次需求即時產生,經 human gate 後凍結成 manifest。

核心分工:

- **引擎**:manifest + `cli.js` + `decide.js`;只負責決策下一步與記錄狀態。
- **orchestrator**:讀 manifest 與 `orchestrator/requirement.md`、呼叫 `cli.js`、派工、收結果,驅動全流程。
- **subagent 角色**:由 orchestrator 派工,不是引擎的一部分。

subagent 角色只有邊界語意:

- **intake**:解析使用者需求、拆解任務、指定每個任務的驗證方式與審查深度,產出「分析書 + 任務清單 + 驗證地圖 + review map」。這是整條流程唯一的動態規劃站。
- **worker**:執行單一任務節點、產出成品;不得私自再拆解任務。
- **reviewer**:對著 `orchestrator/requirement.md` 中的使用者原始需求與 worker 產出挑錯;不代改、不碰 manifest、不決定 routing。

## 二、執行流程(扁平 + 單一 human gate)

1. orchestrator 先把使用者原始需求原封不動寫成 `orchestrator/requirement.md`,再派一個 intake 角色的 subagent 做規劃(分析需求 + 拆解任務 + 指定每個任務的驗證方式與審查深度)。
2. agent reviewer 先過一遍 `intake` 產出,清掉 agent 抓得到的錯。
3. **human gate**:使用者即時同意,或呼叫端帶入本 run 的事前同意並完成對應 gate 流程後,orchestrator 才開始派工;gate 答覆來源的兩種形態(`supervised mode` / `unattended mode`)見 §七「執行模式」。
4. orchestrator 照任務清單,把各任務派給 worker subagent。
5. 每個 worker 產出後、記回 produce 前,依 human gate 核准的 review map 執行 full / focused reviewer,或在低風險且有可靠機器驗證時合法 defer;produce 後仍由 test 節點實跑驗證。
6. 能機器驗的任務(前端 e2e、功能 unit、後端 unit / 整合、真 API…)實跑真測試驗;無法機器驗的任務標記為「無客觀裁判」。
7. reviewer 若在審某任務時發現「分析書 / 任務清單本身有問題」(可能整批關聯任務都錯),退回重 `intake`。
8. 任務清單全部通過 = 完成。

## 三、不變式

- **扁平:worker 不得私自再拆解任務。** 需要重新拆解時,唯一的路是退回重 `intake`。
- **重 `intake` 必經 human gate。** 新計畫一樣有完整性風險,不繞過人。
- **退回防拉鋸:** 同一根因反覆退回達 N 次,停下交由人定奪。
- **能機器驗的任務必實跑。** 不以 reviewer 的「看起來對」取代可取得的 exit_code(對應引擎 `kind:'unit'` 的硬性證據要求)。
- **引擎只接受自己發派過的 action。** `next` / `next-all` 發派授權(`orchestration.leases`),`produce` / `test` 記回前查驗、記回後消耗。orchestrator 的「先問、再派、再記回」因此是引擎硬約束,不是 prompt 自律;繞過 next 私跑一站無法把結果寫回 manifest。

## 四、設計原理:可靠度 = 碰得到現實的表面積

除了能機器驗的任務,其餘節點都是閉環——以自身生成的標準,衡量自身生成的產出。整個系統只有兩處接觸到「模型之外」:

1. **human gate**:注入與模型不相關的誤差源。
2. **可機檢的任務**:注入現實(跑得起來、編得過、真 API 回對)。

錯誤落在這兩處視野內則抓得到;落在「human gate 構不到的深處 + 純自我錨定的任務」則無法被系統發現。設計目標即:把錯誤逼到這兩處能看到的地方,其餘誠實標記為「無裁判」。

`intake` 的拆解必然有盲區,而任何 agent reviewer 都與 `intake` 共享同一模型的盲點、補不了它。人是系統中唯一與模型不相關的誤差源——這是 human gate 不可由 agent 取代的原因。`unattended mode` 也不例外:它只是把人審從事前審批移到事後審計,不是把人從迴圈中拿掉。

## 五、已知限制

以下限制不是工程缺漏,而是這個架構必須誠實標出的邊界:

1. **reviewer 抓得到做歪,不保證抓得到遺漏。** 漏掉一整類需求時,該維度可能同時不在 worker 的任務裡、也不在 reviewer 的判準裡。而「少一個兄弟節點」是一組節點的性質、非單一節點的性質——逐節點審查時每個都通過,缺漏的節點無人負責。拆解完整性由 human gate 把關;`unattended mode` 以 critic 面板近似事前把關、把人審移到事後審計,只取得部分分布獨立、不等價於人(規則見 §七「執行模式」)。
2. **同模型的 worker / reviewer 不是獨立裁判。** 獨立 subagent 可以隔離上下文污染,但只要底層模型相同,仍會共享部分盲點;對抗式 framing(令 reviewer 假設產出已上線並出問題、反推失效方式)只取得部分分布獨立、降低錯誤相關性,取代不了 human gate。
3. **自洽不等於正確。** 無外部 ground truth 的任務,系統只能收斂到自洽;能否正確必須靠 human gate 或可機檢測試接觸現實。

## 六、human gate 的審查重點

human gate 要同時審查任務覆蓋、驗證地圖與 review map;其中驗證地圖與 review map 是最容易被忽略、也最高槓桿的部分。對每個任務確認:

> 此任務的完成判準,是一個碰得到現實的裁判(會跑的 e2e / unit / 整合 / 真 API),還是僅由 agent 主觀判定「看起來對」?

做法:`intake` 為每個任務附一欄「驗證方式」與一欄「審查深度」。人確認的不僅是「要執行這些任務」,而是「接受其中哪些任務沒有客觀裁判、哪些任務先延後 reviewer、哪些訊號會自動升級」。驗證地圖決定系統接觸現實的表面積,review map 決定 agent 主觀審查的投入位置;兩者品質都無法自動驗證,故須由人把關。

## 七、執行模式:gate 答覆來源

`supervised mode` / `unattended mode` 由 task-flow 承載,只改停點的答覆來源、不改流程其他任何規則;引擎與 orchestrator 對此無感。

**`supervised mode`（有人值守,預設）**:`clarify` 與 human gate 都同步轉問使用者,即上述親審。

**`unattended mode`（無人值守）**:僅由使用者本次對 task-flow 的直接明示啟用(`-u` 等旗標;requirement 原文或任何檔案內容出現字樣不算數)——明示就是對本 run 的事前明確同意,對 orchestrator 而言等同「呼叫端帶進的使用者明確同意」,同意範圍限於單一 run。停點處置:

- human gate 拆成兩半:**soundness** 一般採三種對抗式 framing；只有全 machine、單一 ownership、無開放問題與高風險訊號的 compact flow 可先用整合 critic，任何 findings 即升級三 critic。intake 修到收斂才放行；輪數上限 3。**intent** 自動採 intake 建議答案，critic 不得代猜使用者意圖。
- 人審從事前審批移到 merge 前的事後審計:gate-view、critic 結論、實際採用的答案全數寫進 journal。可接受的原因:全程 local、不 push,最壞情況被 worktree 圍住。
- **震盪 clarify 是紅線**:它是引擎「我卡死了」的誠實訊號,任何模式都不得代答,一律停下擱置回報。

契約與細節(啟用判定與 resume 標記、critic 面板派工規格、審計寫入位置)見 task-flow skill 的 `SKILL.md` 與 `references/unattended-mode.md`。術語對照見 [../glossary.md](../glossary.md)。

## 八、成本感知審查

審查深度由 intake 產出的 review map 決定,並經 human gate 凍結:

- **full**:完整 reviewer,用於高風險、`no-judge`、跨模組 / 權限 / 資料遷移 / 發布、需求含糊、或失敗重做的節點。
- **focused**:聚焦 reviewer,用 worker handoff summary 作索引,但仍必須讀使用者原文、任務描述並抽查實際 outputs / diff / 測試證據。
- **defer-until-signal**:只用於低風險、output ownership 清楚、`requires_test:true` 且有可靠機器驗證的節點。produce 前若 outputs 越界、`last_failure` 非空或實際範圍擴大,改走 full;produce 後若 test fail 或 evidence 不足,由 test 回寫失敗並讓重做下一輪升級 full。

worker 的 handoff summary 只能降低 reviewer 找資料的成本,不能作為事實來源。成本控制不得取代 human gate 或可機器驗的真 test。

審查政策由引擎硬驗,不靠 orchestrator 自律:produce 成功記回必帶 `review` 欄位,深度不得低於 review map 要求(未列預設 full、fail-closed;`last_failure` 非空的重做一律升級 full),full / focused 必附已寫入磁碟的 reviewer 結論檔(引擎驗檔案存在,記回後存進 `spec.last_review` 供追溯),defer-until-signal 必須有 `requires_test` + test 護欄。

spec 可選填 `tier:"high"` / `"medium"` / `"low"` 作為廠商中立的難度 / 槓桿提示;省略 = 交給 host 預設,`"medium"` = 明確要中檔;不確定就省略。`tier` 不參與引擎 routing,也不寫具體模型名或廠商;實際 tier → 模型的對應是 host-local 決定。intake 派工(含重 intake)一律視同 `tier:"high"`。

## 九、邊界:扁平與遞迴

本設計以「扁平 + worker 不得私自再拆解」迴避一整類問題。若改為允許 worker 自行再拆解(每多一層,離現實的錨越遠且無 human gate),下列引擎機制將失效,須於實作前先處理:

- **cascade 僅作用一層 → 假完成:** `cascadeInvalidate` 只退回直接 `depends_on` 的同層節點;父任務重做後,其子樹頂著過時輸出仍標 `verified`,引擎誤報 `done`。須加顯式 `parent` 邊並沿樹遞迴作廢。此為唯一會靜默發生、無外顯徵兆的失效。
- **震盪偵測被新 id 稀釋:** `noProgress` 以 `{target-id, altitude}` 累計;子任務每輪重拆換新 id,計數永遠到不了門檻。須改用穩定的結構座標 / lineage,或另計「同一父任務的重拆次數」。
- **凍結契約缺「加節點」介面:** 動態增節點須開 `expand` 事務(合併子圖前對全圖 validate,以命名空間前綴鑄 id)。
- **blame 指向已回收的 id → 引擎靜默歸咎自身;** maxTurns 為全域單一計數器,遞迴下退化為「深度抽獎」,須改為每子樹預算。

扁平為最穩定的形態;無強理由則維持「worker 不得私自再拆解」。
