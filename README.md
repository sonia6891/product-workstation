# 產品工作站

團隊共用的產品成效與問題追蹤網站：各產品、各市場的下載、訂閱、營收、廣告花費趨勢，以及 Bug 與功能需求。

- 網站：https://sonia6891.github.io/product-workstation/
- 資料存放在 Supabase，必須登入且 Email 在團隊白名單內才讀得到（資料庫 Row Level Security）。
- 網頁裡的 Supabase 金鑰是公開用的 anon key，本身沒有讀取資料的權限。

## 自動同步（每分鐘）

各 App 自己的 Supabase 資料庫用 pg_cron 每分鐘把當天和前兩天的數字推到工作站（`public.ingest_metrics`），每小時再推一次最近 120 天，讓隔天才到的 App Store 報表補上正式數字。工作站網頁用 Realtime 收到後立即更新，總覽頂部的「今天即時」會顯示最後更新時間。

| 產品 | 來源專案 | 下載 | 新訂閱／有效訂閱／營收 |
|---|---|---|---|
| 喵的，又要上班了 | `meow-work` | App Store 銷售報表的總下載（首次＋重新下載）；報表還沒到的日子與 Android 用「App 首次開啟」估算 | App Store 訂閱通知（用戶付款金額，未扣 Apple 抽成） |
| 職缺體檢 | `job-check` | 新用戶（首次開啟建立的帳號），市場一律 TW | 目前免費；有效訂閱讀 `profiles.plan = 'pro'` |
| 提醒喵 | 尚未接 | — | — |

- 每個來源專案都只多了一個 `workstation` schema（`config`、`export_rows`、`push`）和兩個 cron 工作（`workstation-push-live`、`workstation-push-full`），只讀 App 的資料表，不改任何 App 資料。程式碼見 `integrations/`。
- 每個產品有自己的推送金鑰：來源端存在 `workstation.config`（API 讀不到），工作站只存 SHA-256（`private.ingest_keys`）。
- 自動同步會覆蓋下載、訂閱、營收；廣告花費不會被動到，請在「數據輸入」手動填。
- 「退訂紀錄」頁：App Store 的關閉自動續訂、重新開啟、到期、退款、扣款失敗通知（`public.sub_events`，由 `public.ingest_events` 寫入），附第一次付費時間與已付金額。目前只有「喵的，又要上班了」有。
- 營收依「設定」的幣別換算（`private.fx` 的固定匯率）。
- 暫停同步：在來源專案執行 `select cron.unschedule('workstation-push-live'); select cron.unschedule('workstation-push-full');`

## Sentry 自動回報（Bug 追蹤）

Edge function `sentry-sync`（原始碼 `integrations/sentry-sync/index.ts`）每 2 分鐘由 pg_cron 呼叫一次，把 Sentry 上「未解決」的錯誤寫進 Bug 追蹤：

- 每筆會抓最新一次發生的「錯誤細節」：卡在哪幾行程式（★ 是 App 自己的程式）、發生前的動作（換頁、連線、App 進背景等），顯示在 Bug 視窗，「交給站長」時也會一起送出。
- 新錯誤 → 新增一筆「待處理」Bug，優先級依等級與影響人數自動給（fatal → P0，error 且 ≥ 20 人 → P1，error → P2，其他 → P3），之後可以自己改。
- 次數、影響人數、最後發生時間會持續更新；狀態、優先級、負責人以工作站上的設定為準。
- 在 Sentry 標成已解決（或 90 天沒再發生）→ 這裡自動變「已解決」；標了已解決之後又再發生 → 自動回到「待處理」。
- 目前來源（org `sole-proprietorship-jo`）：喵的，又要上班了（project `meow-work-app`）、提醒喵（project `remindcat`）。職缺體檢還沒裝 Sentry。要加其他 App，在函式的 `SOURCES` 加一行。

需要 Supabase secret `SENTRY_AUTH_TOKEN`（Sentry → Settings → Auth Tokens，只勾 Read 權限）。沒有權杖時 Bug 追蹤頁會顯示「尚未啟用」。暫停同步：`select cron.unschedule('sentry-sync');`

## 站長（交給 Claude 修）

在 Bug 或功能需求的編輯視窗按 **交給站長**：手機或電腦會打開 GitHub 的新 issue，標題、Sentry 資料、描述都已填好，按「Submit new issue」送出。負責人會改成「站長」；狀態要等 GitHub 上真的收到 issue 才會變「處理中」（見下方「站長回報」）。

- 站長是 App 倉庫裡的 GitHub Actions（`.github/workflows/claude.yml`），看到 issue 或留言寫 `@claude` 就會開工：讀程式、找原因、把修正推到 `claude/…` 分支，在 issue 回報並附上開 PR 的連結。要它改方向，就在 issue 留言 `@claude …`。
- 只推新分支，不動 main、不合併。iOS 程式在 GitHub 上無法編譯，要自己用 Xcode build 過再送審。
- 用的是 Claude 訂閱（secret `CLAUDE_CODE_OAUTH_TOKEN`，在電腦上跑 `claude setup-token` 產生），不需要 API 金鑰，電腦不用開著。
- 產品對應的倉庫寫在 `index.html` 的 `STATION_REPO`：喵的，又要上班了 → `sonia6891/meow-work-app`，提醒喵 → `sonia6891/RemindCat`。沒有對應倉庫的產品不會出現這個按鈕。
- issue 內容最後有「工作站編號 pws:…」，工作站用它找到對應的 issue。

### 站長回報（不用開 GitHub）

Edge function `station-sync`（原始碼 `integrations/station-sync/index.ts`）每 2 分鐘由 pg_cron 呼叫一次，把站長的進度寫回那筆 Bug／需求：

- 列表上會出現「站長・處理中 2/5」這類標籤；打開那筆，可以看到進度條和站長的完整回報（原因、改了什麼），還有「開 PR」「看 PR、合併」的按鈕。
- 進度依序是：等你送出 → 已收到 → 處理中 → 做完了 → 已開 PR → 已合併。出錯也會顯示。
- Bug 的狀態跟著 GitHub 上真正的情況走：issue 送出、站長收到 → 「處理中」；PR 合併 → 「待驗證」；交出 30 分鐘還沒送出、站長出錯、或 PR 被關掉 → 回到「待處理」。你自己設成待驗證／已解決／不處理的不會被改。用新版本確認沒問題後，再自己改成「已解決」。
- 交出 30 分鐘後還找不到 issue，會顯示「還沒在 GitHub 送出」，按「再交一次」就好。

需要 Supabase secret `STATION_GITHUB_TOKEN`：GitHub → Settings → Developer settings → Fine-grained tokens，Repository access 選 App 倉庫（`meow-work-app`、`RemindCat`），權限只給 Issues、Pull requests 的 **Read-only**。沒有權杖時，站長區塊會顯示「自動回報尚未啟用」。暫停：`select cron.unschedule('station-sync');`

## 外觀

預設是「喵風格」（跟《喵的，又要上班了》同一套紙卡＋縫線、深色時是胡桃木色）。到 **設定 → 外觀** 可以切回「經典」樣式，選擇只記在那台裝置上。圖表的市場／產品配色兩種樣式各有一套，都檢查過色盲也分得開。
