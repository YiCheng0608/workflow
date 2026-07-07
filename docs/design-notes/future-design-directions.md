# 設計筆記:後續設計方向

> 狀態:方向盤點,不是承諾;各項動工前應各自開設計討論。已實作的項目直接移除(歷史見 git)。
> 前提:引擎核心(manifest + `cli.js` + `decide.js`)已收斂,後續空間不在「把引擎變聰明」,
> 而在沿主筆記([generic-recursive-task-engine.md](generic-recursive-task-engine.md))劃出的軸往外長:
> **接觸現實的表面積、軟自律變硬約束、人類 gate 的槓桿**,以及第四條軸——
> **迴圈本身的可靠度**(loop engineering:笨迴圈 + 狀態全在磁碟 + fresh context。
> 前兩者與可斷可續已由常駐模式承載:狀態全在 manifest、決策在 `decide.js`、任意時點可 resume;
> 重活的 fresh context 由 worker / reviewer 子代理承載。唯一未取的是「每輪叫起全新 session」——
> 它必然依賴 host-specific 扳機(CLI / 排程器),與「多種 agent runtime 皆可用」的目標相斥,暫不追求)。

按價值排序:

## 1. task-flow 值守模式:無人值守跑到完

現況缺口:task-flow 只有互動式一種形態——human gate 逐題訪談使用者、clarify 同步等人答覆,人不在場時 run 就停在停點,「agent 自己把任務做完」做不到。

提案:task-flow 加「值守模式」(有人值守為預設 / 無人值守),對稱 orchestrator 驅動模式的鐵律——**值守模式只改停點的答覆來源,不改流程其他任何規則**。無人值守以使用者親手寫的**政策檔**為啟用條件:常備授權的可稽核實體,沒有政策檔就沒有合法路徑進入(對 orchestrator 而言,政策檔就是「呼叫端帶進的使用者明確同意」,只是從即時同意變成常備同意)。停點處置:

- **human gate 拆成兩半處理**:
  - **soundness**(拆解完整性、驗證地圖是否把該人審的標成 no-judge、ownership 邊界)——平行派多個不同對抗式 framing 的 critic 子代理挑戰 intake 產出,intake 修到 critic 收斂才放行;輪數上限 3(對稱 worker↔reviewer),收斂不了 → halt。同模型的多 critic 只有部分分布獨立,準確率升但不等價於人。
  - **intent**(開放問題,答案取決於使用者偏好)——自動採 intake 建議答案;critic 與 intake 同模型,不得代猜使用者意圖。
- **全數落盤,人審從事前審批移到事後審計**:gate-view、critic 結論、實際採用的答案全進 journal;人改在 merge 前看 diff + 審計材料。可接受的原因:全程 local、不 push,最壞情況被 worktree 圍住——燒掉的 token 加一條可丟棄的 branch,不是災難。
- **震盪 clarify 是紅線**:引擎的震盪偵測是「我卡死了」的誠實訊號,任何值守模式都不得代答,一律 halt 擱置回報。

範圍:task-flow 契約 + 政策檔格式 + critic 面板的派工規格;引擎與 orchestrator 零改動。

## 2. 跨 run 遙測:迴圈的外圈學習

現況缺口:manifest 是單次 run 的事實來源,跨 run 沒有記憶——每個 spec 花幾輪、review depth 分佈、defer 升級率、震盪觸發率,run 結束即全部流失,intake 下次出 review map 與 tier 建議仍憑感覺。

提案:累積這些數據(journal 分支是現成落點),讓 intake 規劃時有數據可依。

理由:單 run 的迴圈已收斂,下一層槓桿在 meta-loop——這輪 run 的結果讓下輪更準。與第 3 項互相餵養:遙測指出哪些計畫形狀反覆出現、值得凍結成範本。

## 3. 計畫範本層:讓 intake 可引用既有計畫形狀

觀察:同形狀的需求反覆出現時,現生計畫是浪費;凍結過的計畫形狀可以重用(workflow repo 的 tweak flow 已在另一端驗證此事)。人類 gate 是每次 run 的固定成本,gate 不可拿掉,但人審的東西可以從「整份分析書」縮成「範本 X + 這幾處填空的 diff」。

提案:intake 遇到見過的需求形狀時,提案「套用範本 X + 填空 diff」而非從零拆解。人類 gate 照過、引擎零改動,成本下降但不變式全保留。

附帶收益:定義「flow = 凍結過 gate 的計畫範本」,把 automation(動態規劃)與 workflow(靜態 flow)收斂成同一概念的兩端,避免兩套引擎各自演化漂移。對第 1 項也是放大器:過過 gate 的計畫形狀,無人值守自動放行的正當性遠高於全新拆解。

理由:gate 頻寬省下來,run 的節奏才上得去;與第 2 項合起來構成「每次 run 讓下次 run 更便宜」的複利迴圈。

## 4. 多 run 佇列:gate 阻塞時迴圈不空轉

現況缺口:人類 gate 在 intake 之後、全圖凍結之前,gate 卡住時整條迴圈沒有任何可跑的工作,只能同步等人。單 run 內這無解(設計如此,不是缺陷要修)。

提案:外層 driver 面對**多個 requirement 的佇列**——某個 run 停在 clarify 就通知人、換跑下一個 run。人類 gate 從同步阻塞點變成非同步收件匣;每個 run 各自的 manifest / worktree 互不干擾,不變式全保留。

前置取捨:driver 的「無人在場時叫起 session」必然依賴 host-specific 扳機(CLI / 排程器),與「多種 agent runtime 皆可用」的目標相斥。動工訊號 = 接受綁定單一宿主、或出現可攜的啟動介面;在那之前,第 1 項的值守模式已吃掉單一 run 的無人值守需求。

## 5. 引擎的 sim / fuzz harness

引擎 100% 確定性,天然適合 property-test:隨機生 DAG、隨機注入 fail / blame / cascade / clarify 序列,斷言不變式——一定終止、不假 `done`、cascade 後不殘留過時 verified、震盪必觸發 clarify。現有 test 是 case-based,fuzz 是另一維度的信心。

**此項是第 6 項(遞迴)的必要前置**;引擎是全系統唯一的長命部件,對它的信心值得這筆投資。

## 6. 遞迴 / `expand` 事務——路線圖已畫好,但別先做

主筆記 §八已列完遞迴要付的四筆帳(cascade 遞迴、lineage 型震盪偵測、expand 事務、每子樹預算)。天花板最高,但扁平是最穩定形態;動工訊號 = 反覆出現「intake 拆不動、必須中途加節點」的實案。在那之前維持現狀。

---

**建議路線:1(值守模式)→ 2(遙測)→ 3(範本)。** 1 直接交付無人值守;2、3 合起來構成外圈學習的複利,3 同時把 1 的自動放行車道變寬;4(佇列)等「host-specific 扳機 vs 多 runtime」的取捨有解再動;5 是 6 的前置;6 維持「有實案才動」。
