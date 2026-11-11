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

- 新錯誤 → 新增一筆「待處理」Bug，優先級依等級與影響人數自動給（fatal → P0，error 且 ≥ 20 人 → P1，error → P2，其他 → P3），之後可以自己改。
- 次數、影響人數、最後發生時間會持續更新；狀態、優先級、負責人以工作站上的設定為準。
- 在 Sentry 標成已解決（或 90 天沒再發生）→ 這裡自動變「已解決」；標了已解決之後又再發生 → 自動回到「待處理」。
- 目前來源（org `sole-proprietorship-jo`）：喵的，又要上班了（project `meow-work-app`）、提醒喵（project `remindcat`）。職缺體檢還沒裝 Sentry。要加其他 App，在函式的 `SOURCES` 加一行。

需要 Supabase secret `SENTRY_AUTH_TOKEN`（Sentry → Settings → Auth Tokens，只勾 Read 權限）。沒有權杖時 Bug 追蹤頁會顯示「尚未啟用」。暫停同步：`select cron.unschedule('sentry-sync');`

## 外觀

預設是「喵風格」（跟《喵的，又要上班了》同一套紙卡＋縫線、深色時是胡桃木色）。到 **設定 → 外觀** 可以切回「經典」樣式，選擇只記在那台裝置上。圖表的市場／產品配色兩種樣式各有一套，都檢查過色盲也分得開。
