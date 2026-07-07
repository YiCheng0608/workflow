# 設計筆記:後續設計方向

> 狀態:第 1、2 項已實作(見各項標註),其餘為提案。本筆記是方向盤點,不是承諾;各項動工前應各自開設計討論。
> 前提:引擎核心(manifest + `cli.js` + `decide.js`)已收斂,後續空間不在「把引擎變聰明」,
> 而在沿主筆記([generic-recursive-task-engine.md](generic-recursive-task-engine.md))劃出的三條軸往外長:
> **接觸現實的表面積、軟自律變硬約束、人類 gate 的槓桿。**

按價值排序:

## 1. 把「回報的 outputs」升級成「實際 diff」的硬驗(引擎硬化)——✅ 已實作

實作:`cli.js produce` 成功記回時拿 `git status --porcelain -z -uall` 與申報比對(扣掉 `orchestrator/`;非 git 目錄跳過),未申報修改 exit 1、manifest 不動。刪檔走新增的選填 `deleted` 欄位申報(驗「真的已不在磁碟」+ ownership);已記回的先前站 outputs 與 in-flight lease 的 `allowed_outputs` 範圍豁免(平行批次序列記回不誤傷)。`decide.js` 未動。

原始缺口:`allowed_outputs` / `forbid_outputs` 驗的是 **worker 自己回報的清單**,引擎另驗「回報的檔案存在於磁碟」,但沒驗反方向——worker 改了檔卻不回報,引擎看不見。

提案:`cli.js produce` 記回時拿 `git status --porcelain`(扣掉 `orchestrator/` 過程目錄)與回報 outputs 比對,未申報的修改直接 exit 1、manifest 不動。

理由:延續既有軌跡(leases、review 硬驗、evidence 計數檢查都是把 prompt 自律變引擎硬約束)。純 `cli.js` 層改動,`decide.js` 不動,小改動高價值。

## 2. 人類 gate 的呈現工具(可靠度槓桿最高的一處)——✅ 已實作

實作:`scripts/gate-view.js`(唯讀)把 manifest 渲染成一頁 Markdown——依 `depends_on` 分層的任務波次、每節點裁判類型與審查深度、no-judge / defer 標記與升級訊號、「凍結前必修」紅燈與「gate 要人明確接受的事」清單。orchestrator 在 `kind:"review"` 時呈現給使用者。不碰引擎。

原始缺口:人是系統中唯一與模型不相關的誤差源,拆解完整性只有 gate 抓得到(主筆記 §四、§六),但 gate 的介面是幾份 raw `.md` + manifest,人要自己在腦中重建依賴圖、驗證地圖、review map 的對應。

提案:一支小 script 把 draft manifest 渲染成一頁——任務圖、每節點的裁判類型、哪些是 no-judge、哪些 defer、哪些訊號會自動升級——直接放大 gate 的頻寬。

理由:系統其他部分再怎麼修,可靠度上限都卡在 gate 品質;這是槓桿最高的投資。不碰引擎。

## 3. 計畫範本層:讓 intake 可引用既有計畫形狀

觀察:同形狀的需求反覆出現時,現生計畫是浪費;凍結過的計畫形狀可以重用(workflow repo 的 tweak flow 已在另一端驗證此事)。

提案:intake 遇到見過的需求形狀時,提案「套用範本 X + 這幾處填空」而非從零拆解;gate 審的東西從整份分析書縮成 diff。人類 gate 照過、引擎零改動,成本下降但不變式全保留。

附帶收益:定義「flow = 凍結過 gate 的計畫範本」,把 automation(動態規劃)與 workflow(靜態 flow)收斂成同一概念的兩端,避免兩套引擎各自演化漂移。

## 4. 引擎的 sim / fuzz harness

引擎 100% 確定性,天然適合 property-test:隨機生 DAG、隨機注入 fail / blame / cascade / clarify 序列,斷言不變式——一定終止、不假 `done`、cascade 後不殘留過時 verified、震盪必觸發 clarify。現有兩支 test 是 case-based,fuzz 是另一維度的信心。

**此項是第 5 項(遞迴)的必要前置。**

## 5. 遞迴 / `expand` 事務——路線圖已畫好,但別先做

主筆記 §八已列完遞迴要付的四筆帳(cascade 遞迴、lineage 型震盪偵測、expand 事務、每子樹預算)。天花板最高,但扁平是最穩定形態;動工訊號 = 反覆出現「intake 拆不動、必須中途加節點」的實案。在那之前維持現狀。

## 6. 跨 run 遙測

現況缺口:manifest 是單次 run 的事實來源,跨 run 沒有記憶——每個 spec 花幾輪、review depth 分佈、defer 升級率、震盪觸發率,全部流失。

提案:累積這些數據(journal 分支是現成落點),讓 intake 出 review map 與 tier 建議時有數據可依,而非每次憑感覺。這是 cost-aware 方向的自然下一步。

---

1、2 已完成。**剩餘各項中,3 是中期最有意思的**(同時解「成本」與「兩 repo 漂移」兩個問題);4 是 5 的必要前置;6 順著 cost-aware 方向自然生長。
