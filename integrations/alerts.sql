-- Workstation project: run the edge function `alerts` (LINE 日報與異常通知) every 15 minutes.
-- It checks the header against threads_config.cron_secret, the same secret 串文雷達 uses.
-- Pause: select cron.unschedule('alerts');
select cron.schedule('alerts', '*/15 * * * *', $$select net.http_post(
  url := 'https://bpovoxjdqdwhhlfwgpep.supabase.co/functions/v1/alerts',
  headers := jsonb_build_object('Content-Type', 'application/json', 'x-alerts-secret', (select value from public.threads_config where key = 'cron_secret')),
  body := '{}'::jsonb, timeout_milliseconds := 30000)$$);
