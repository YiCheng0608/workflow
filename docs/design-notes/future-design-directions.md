# 設計筆記:後續設計方向

> 狀態:方向盤點,不是承諾;各項動工前應各自開設計討論。已實作的項目直接移除(歷史見 git)。
> 前提:引擎核心(manifest + `cli.js` + `decide.js`)已收斂,後續空間不在「把引擎變聰明」,
> 而在沿主筆記([generic-recursive-task-engine.md](generic-recursive-task-engine.md))劃出的軸往外長:
> **接觸現實的表面積、軟自律變硬約束、人類 gate 的槓桿**,以及第四條軸——
> **迴圈本身的可靠度**(loop engineering:笨迴圈 + 狀態全在磁碟 + fresh context)。
> 這條軸的現況:前兩個成分已經成立——狀態全在 manifest、決策在 `decide.js`、任意時點可 resume;
> 重活的 fresh context 由 worker / reviewer 子代理承載。唯一未取的是「每輪叫起全新 session」——
> 它必然依賴 host-specific 扳機(CLI / 排程器),與「多種 agent runtime 皆可用」的目標相斥,暫不追求。

按價值排序:

## 1. 跨 run 遙測:迴圈的外圈學習

現況缺口:manifest 是單次 run 的事實來源,跨 run 沒有記憶——每個 spec 花幾輪、review depth 分佈、defer 升級率、震盪觸發率,run 結束即全部流失,intake 下次出 review map 與 tier 建議仍憑感覺。

提案:累積這些數據(journal 分支是現成落點),讓 intake 規劃時有數據可依。

理由:單 run 的迴圈已收斂,下一層槓桿在 meta-loop——這輪 run 的結果讓下輪更準。與第 2 項互相餵養:遙測指出哪些計畫形狀反覆出現、值得凍結成範本。

## 2. 計畫範本層:讓 intake 可引用既有計畫形狀

觀察:同形狀的需求反覆出現時,現生計畫是浪費;凍結過的計畫形狀可以重用。人類 gate 是每次 run 的固定成本,gate 不可拿掉,但人審的東西可以從「整份分析書」縮成「範本 X + 這幾處填空的 diff」。

提案:intake 遇到見過的需求形狀時,提案「套用範本 X + 填空 diff」而非從零拆解。人類 gate 照過、引擎零改動,成本下降但不變式全保留。

附帶收益:定義「flow = 凍結過 gate 的計畫範本」,讓動態規劃與靜態 flow 收斂成 workflow 同一概念的兩端,避免各自演化成兩套機制而漂移。對無人值守模式也是放大器:已過 gate 的計畫形狀,無人值守自動放行的正當性遠高於全新拆解。

理由:gate 頻寬省下來,run 的節奏才上得去;與第 1 項合起來構成「每次 run 讓下次 run 更便宜」的複利迴圈。

## 3. 多 run 佇列:gate 阻塞時迴圈不空轉

現況缺口:人類 gate 在 intake 之後、全圖凍結之前,gate 卡住時整條迴圈沒有任何可跑的工作,只能同步等人。單 run 內 gate 必然同步阻塞;鬆綁只能發生在多 run 的外層。

提案:外層 driver 面對**多個 requirement 的佇列**——某個 run 停在 clarify 就通知人、換跑下一個 run。人類 gate 從同步阻塞點變成非同步收件匣;每個 run 各自的 manifest / worktree 互不干擾,不變式全保留。

前置取捨:driver 的「無人在場時叫起 session」必然依賴 host-specific 扳機(CLI / 排程器),與「多種 agent runtime 皆可用」的目標相斥。動工訊號 = 接受綁定單一宿主、或出現可攜的啟動介面;在那之前,task-flow 的無人值守模式已吃掉單一 run 的無人值守需求。

## 4. 引擎的 sim / fuzz harness

引擎 100% 確定性,天然適合 property-test:隨機生 DAG、隨機注入 fail / blame / cascade / clarify 序列,斷言不變式——一定終止、不假 `done`、cascade 後不殘留過時 verified、震盪必觸發 clarify。現有 test 是 case-based,fuzz 是另一維度的信心。

**此項是第 5 項(遞迴)的必要前置**;引擎是全系統唯一的長命部件,對它的信心值得這筆投資。

## 5. 遞迴 / `expand` 事務——路線圖已畫好,但別先做

主筆記 §八已列完遞迴要付的四筆帳(cascade 遞迴、lineage 型震盪偵測、expand 事務、每子樹預算)。天花板最高,但扁平是最穩定形態;動工訊號 = 反覆出現「intake 拆不動、必須中途加節點」的實案。在那之前維持現狀。

---

**建議路線:1(遙測)→ 2(範本)。** 兩者合起來構成外圈學習的複利,2 同時把無人值守的自動放行車道變寬;3(佇列)等「host-specific 扳機 vs 多 runtime」的取捨有解再動;4 是 5 的前置;5 維持「有實案才動」。
