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

- 每個來源專案都只多了一個 `workstation` schema（`config`、`export_rows`、`push`）和兩個 cron 工作（`workstation-push-live`、`workstation-push-full`；`meow-work` 另有每小時的 `workstation-push-usage`），只讀 App 的資料表，不改任何 App 資料。程式碼見 `integrations/`。
- 每個產品有自己的推送金鑰：來源端存在 `workstation.config`（API 讀不到），工作站只存 SHA-256（`private.ingest_keys`）。
- 自動同步會覆蓋下載、訂閱、營收；廣告花費不會被動到，請在「數據輸入」手動填。
- 「退訂紀錄」頁：App Store 的關閉自動續訂、重新開啟、到期、退款、扣款失敗通知（`public.sub_events`，由 `public.ingest_events` 寫入），附第一次付費時間與已付金額。目前只有「喵的，又要上班了」有。
- 營收依「設定」的幣別換算（`private.fx` 的固定匯率）。
- 「版本使用」「新用戶留存」卡片（總覽）：`meow-work` 每小時用 `workstation.push_usage()`（cron `workstation-push-usage`，`integrations/usage-meow-work.sql`）把匿名的 App 開啟紀錄整理成各版本每天的使用人數、依第一次開 App 那天分組的隔天／第 7 天／一週內回來比例、免費試用轉付費，送到工作站的 `public.ingest_usage`（`integrations/usage.sql`），存成 `cfg/usage-meow-work`。開啟紀錄從 2026-11-02 開始，第 30 天留存要等 12 月才有。
- 「廣告回本」卡片（總覽）：期間內廣告費、每次下載成本、每個新付費用戶成本、營收 ÷ 廣告費，以及每個新訂閱帶來的營收，依投廣告的市場列出，旁邊附沒投廣告的市場做比較。Meta 沒有給下載歸因，所以都是「整體平均」。
- 改版標記：`sentry-sync` 每小時查一次 App Store 公開資料，有新版本就在總覽趨勢圖加一個 ◆「iOS x.y.z 上架」事件（產品要填 App Store ID）。刪掉的不會再加回來。
- 暫停同步：在來源專案執行 `select cron.unschedule('workstation-push-live'); select cron.unschedule('workstation-push-full');`

## Sentry 自動回報（Bug 追蹤）

Edge function `sentry-sync`（原始碼 `integrations/sentry-sync/index.ts`）每 2 分鐘由 pg_cron 呼叫一次，把 Sentry 上「未解決」的錯誤寫進 Bug 追蹤：

- 每筆會抓最新一次發生的「錯誤細節」：卡在哪幾行程式（★ 是 App 自己的程式）、發生前的動作（換頁、連線、App 進背景等），顯示在 Bug 視窗，「交給站長」時也會一起送出。
- 新錯誤 → 新增一筆「待處理」Bug，優先級依等級與影響人數自動給（fatal → P0，error 且 ≥ 20 人 → P1，error → P2，其他 → P3），之後可以自己改。
- 次數、影響人數、最後發生時間會持續更新；狀態、優先級、負責人以工作站上的設定為準。
- 在 Sentry 標成已解決（或 90 天沒再發生）→ 這裡自動變「已解決」；標了已解決之後又再發生 → 自動回到「待處理」。
- 標成「已解決」的 Bug 會從清單移除：資料庫觸發器把它搬到 `solved`（`integrations/solved.sql`，網頁不顯示）。Sentry 的錯誤之後又發生，會帶著原本的紀錄自動回到「待處理」。要手動救回一筆，見 `solved.sql` 開頭的說明。
- 站長修好的也會自動變「已解決」：站長回報修好（修正已經在 main 上，或它的 PR 已合併），App Store 上已經有比出錯那版更新的版本（用 Apple 公開查詢，產品要填 App Store ID），而且新版上架後沒再發生。Bug 視窗會寫是哪一版上架後自動標的。
- 目前來源（org `sole-proprietorship-jo`）：喵的，又要上班了（project `meow-work-app`）、提醒喵（project `remindcat`）。職缺體檢還沒裝 Sentry。要加其他 App，在函式的 `SOURCES` 加一行。

需要 Supabase secret `SENTRY_AUTH_TOKEN`（Sentry → Settings → Auth Tokens，只勾 Read 權限）。沒有權杖時 Bug 追蹤頁會顯示「尚未啟用」。暫停同步：`select cron.unschedule('sentry-sync');`

## 站長（交給 Claude 修）

在 Bug 或功能需求的編輯視窗按 **交給站長**：表單內容先存檔，接著雲端的 Claude 馬上開工，不用開 GitHub。這筆會改成「處理中」、負責人「站長」，旁邊有「看 Claude 進度 ↗」（也會出現在 Claude App 的 Code 分頁）。

- 站長是 claude.ai 上的雲端排程任務「站長（產品工作站）」（`trig_01DCZDusxqi6hevT241db7g4`，claude.ai/code/routines），掛了 `meow-work-app` 和 `RemindCat` 兩個倉庫，模型 Opus 5.5。任務的說明原文在 `integrations/station/routine-prompt.md`；要改請在 claude.ai 上改，再同步回這個檔案。
- 按下去時，edge function `station`（原始碼 `integrations/station/index.ts`）確認你是擁有者或編輯者，把標題、描述、Sentry 錯誤細節整理成資料，透過任務的 API 觸發叫醒站長。同一筆還在處理中（3 小時內）再按，要按兩次才會重來。
- 站長讀程式、找原因、修好後推到 `claude/pws-…` 分支，不動 main、不合併、不開 GitHub issue。iOS 程式在雲端無法編譯，它會在回報裡寫出要你用 Xcode 試什麼。
- 進度與回報（原因、改了什麼、怎麼驗證、沒測到的部分）由站長自己寫回這筆：處理中 2/5 → 做完了 → 有「開 PR ↗」可以按。修正本來就在 main 上（沒推分支）的 Bug 會直接變「待驗證」；有分支的等 PR 合併才變。每次交出都會產生一把只對這一筆有效的回報鑰匙，工作站只存它的雜湊。
- 站長用的是 Claude 訂閱額度，跟平常用 Claude Code 算在一起。API 觸發每小時最多 30 次。
- 產品對應的倉庫寫在 `index.html` 和 `integrations/station/index.ts` 的 `STATION_REPO`（兩邊要一致）；產品也可以有自己的 `repo` 欄位。沒有對應倉庫的產品不會出現這個按鈕。

### 第一次接上（擁有者做一次）

1. claude.ai/code/routines → 站長（產品工作站）→ 名字旁的選單 →「Edit」→「Trigger」那列按「＋」→「API」→「Generate token」，複製金鑰（只會顯示一次）。順便可以把原本的排程（每年 1/1）刪掉，它沒有任務資料時什麼都不做。
2. 工作站「設定 → 站長」貼上金鑰按儲存。金鑰存在 `private.station_config`（`integrations/station/station.sql`），網頁 API 讀不到，只有 edge function 能用。換金鑰就是重新產生再貼一次。
3. 雲端環境要能連到工作站：claude.ai/code 的環境設定（任務用的是「Default」）→ Network access 選「Limited」並在 Allowed domains 加上 `bpovoxjdqdwhhlfwgpep.supabase.co`（或選 Full）。沒加的話站長還是會修，但進度回不來，4 小時後這筆會顯示「出錯了」。

### PR 追蹤與舊的 GitHub 流程

Edge function `station-sync`（原始碼 `integrations/station-sync/index.ts`）每 2 分鐘由 pg_cron 呼叫一次：

- 直接交給站長的：超過 4 小時沒回報 → 「出錯了」、Bug 回到「待處理」。有 Supabase secret `STATION_GITHUB_TOKEN` 時，還會跟著站長推的分支看 PR：開了 → 「已開 PR，等你合併」，合併 → 「已合併，等你驗證」（Bug 變「待驗證」）。
- 以前用 GitHub issue 交出的那幾筆，有權杖時照舊從 issue 讀進度。App 倉庫裡的 GitHub Actions（`.github/workflows/claude.yml`，在 issue 留言 `@claude`）也還在，可以繼續用。
- `STATION_GITHUB_TOKEN`：GitHub → Settings → Developer settings → Fine-grained tokens，Repository access 選 `meow-work-app`、`RemindCat`，權限只給 Issues、Pull requests 的 **Read-only**。暫停：`select cron.unschedule('station-sync');`

## LINE 日報與異常通知

Edge function `alerts`（原始碼 `integrations/alerts/index.ts`）每 15 分鐘由 pg_cron 呼叫（`integrations/alerts.sql`），用跟串文雷達同一個 LINE 官方帳號推播給擁有者：

- 每日日報：每天 9 點後送一次，昨天每個產品的下載、新訂閱、營收、廣告費、關閉續訂、未結案 Bug，跟前 7 天平均比較；掉很多或暴衝會加 ⚠。
- 異常通知（8 點到 23 點，半夜發生的早上 8 點再送）：新的 P0 Bug、修好又發生的 Bug、今天廣告費已經超過平常兩倍、同步停了（App 數字 30 分鐘、Sentry 2 小時、Meta 3 小時沒成功）。每件只通知一次，同一輪的合併成一則。
- 用到 Supabase secret `LINE_CHANNEL_ACCESS_TOKEN` 和 `threads_config.line_user_id`（串文雷達已經設好），呼叫時要帶 `threads_config.cron_secret`。LINE 免費方案每月 200 則推播，跟串文雷達共用。
- 送過什麼記在 `cfg/alerts`。暫停：`select cron.unschedule('alerts');`

## 外觀

預設是「喵風格」（跟《喵的，又要上班了》同一套紙卡＋縫線、深色時是胡桃木色）。到 **設定 → 外觀** 可以切回「經典」樣式，選擇只記在那台裝置上。圖表的市場／產品配色兩種樣式各有一套，都檢查過色盲也分得開。
