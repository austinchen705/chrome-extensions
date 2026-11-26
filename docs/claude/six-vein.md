# 六脈神劍（書生助手）

六脈神劍要對落魄書生給對的物品，成功 3 次。擴充功能把整條路拆成下面幾塊；這裡只列各塊的位置，細節寫在各自的文件，不重複。

| 塊 | 做什麼 | 在哪裡 | 說明 |
|---|---|---|---|
| 書生助手開關與開始前檢查 | 面板「書生助手」；開之前讀 `sc`（靈性）與 `sk`（技能數，分頁送 Enter 讀到最後），技能數超過靈性（已有六脈神劍則 +1）就不開、提示要 abandon 幾個 | `content.js` 的 `toggleScholarHelper`、`scholar.js`（純函式，不碰 DOM） | `zap-riddles.md` 的「書生助手」 |
| 遇到書生自動給 | 看到書生就 `follow dire`、認出他要的物品（`matchRequest`）、`i` 讀身上、`give` 給、判讀結果；消失時 `follow none` | `content.js` 的 `scholarStep`、`scholarFlow` | `zap-riddles.md` 的「書生助手」 |
| 成功次數與通知 | `scholarSuccess[角色]`，滿 3 次或已領悟就關助手；LINE 與響鈴，標題 `CatWorld 六脈神劍` | `content.js` 的 `alertOnly`（走既有的 LINE 與響鈴） | `zap-riddles.md`、`line-notify.md` |
| 物品清單與讀身上 | 六脈神劍詳情的「物品清單」分頁，標記身上有沒有（`i`） | `scholar-items-data.js`（產生的資料）、`zap-riddle-ui.js` | `zap-riddles.md`、`builtin-data.md` |
| 購買巨集 | 清單每列的購買指令（`scholarBuyMacros`）、執行與全部缺的一起買 | `zap-riddle-ui.js` | `zap-riddles.md` |
| 書生出沒紀錄 | 出現、要的話、消失，含重生後幾秒與房間（`scholarSightings`） | `content.js` 的 `watchScholar` | `map-collect.md` |
| 戶外格子紀錄 | 掃描、巡怪讀房間時與手動一步一步走時記戶外／室內（`mapOutdoor`），地圖上藍色虛線框標出，設定頁顯示各區數量、可清除 | `scholar.js` 的 `isOutdoor`、`map-hunt.js` 的 `deps.markOutdoor` | `map-hunt-scan.md` |
| 找書生模式 | 面板「找書生」：每個重生整點起，時間窗內照最近的先走巡戶外格子、只讀描述，遇到書生就停；窗到了送待命指令 | `map-hunt.js` 的 `start({ scholar: true })`、設定頁「六脈神劍」組 | `map-hunt-scan.md` |
| 巡怪中遇到書生 | 一般巡怪與掃描遇到書生暫停，助手處理完接著巡；被帶出巡怪區用 `restReturnCommand` 走回來 | `map-hunt.js` 的 `scholarHoldTick` | `map-hunt.md` |

- 備份：`scholarSuccess`、`scholarSightings`、`scholarBuyMacros`、`mapOutdoor` 都在設定備份的鍵裡（`settings-backup.md`）。
- 測試：`tests/unit/scholar.test.js`、`tests/unit/scholar-items.test.js`；整合 `tests/integration/game/scholar*.test.js`、`map-hunt-scholar.test.js`、`zap-riddle-ui.test.js`。
