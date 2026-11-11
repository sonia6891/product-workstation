// Edge function `station-sync` (workstation project). Follows every Bug / 功能需求 handed to 站長 (Claude on GitHub)
// and writes its progress back onto the item, so the workstation shows it without opening GitHub.
// Called every 2 minutes by pg_cron. Needs the secret STATION_GITHUB_TOKEN: a fine-grained GitHub token for the app
// repos with read-only Issues + Pull requests. Status goes to cfg/station.
// No caller auth on purpose: it only reads GitHub and refreshes these rows, and runs at most once every 50 s.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
const isOpen = (s: string) => s !== 'done' && s !== 'wont';
const DAY = 86_400_000;

type Station = {
  repo: string; at: number; issue?: number; url?: string; stage?: string; done?: number; total?: number;
  summary?: string; branch?: string; prCreate?: string; pr?: { number: number; url: string; state: string; merged: boolean };
  job?: string; checkedAt?: number; movedTo?: string; foundFor?: number;
};

let token = '';
async function gh(path: string) {
  const r = await fetch('https://api.github.com' + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'workstation-station-sync' },
  });
  if (r.status === 401) throw new Error('token_rejected');
  if (r.status === 403 || r.status === 404) throw new Error('no_access');
  if (!r.ok) throw new Error(`github_${r.status}`);
  return r.json();
}

// Claude's one comment on the issue, which the action keeps editing while it works.
// Starts as "Claude Code is working…", gains a "- [ ] / - [x]" todo list, and ends as
// "**Claude finished …** —— [View job](…) • [`branch`](…/tree/branch) • [Create PR ➔](…)\n\n---\n<report>"
// or "**Claude encountered an error …**".
function readClaude(body: string) {
  const done = (body.match(/^\s*[-*] \[[xX]\]/gm) || []).length;
  const total = done + (body.match(/^\s*[-*] \[ \]/gm) || []).length;
  const stage = /Claude encountered an error/i.test(body) ? 'failed' : /Claude finished/i.test(body) ? 'reported' : 'working';
  const branch = body.match(/\[`([^`]+)`\]\(https:\/\/github\.com\/[^)]+\/tree\/[^)]+\)/)?.[1] || '';
  const prCreate = body.match(/\[Create PR[^\]]*\]\((https:\/\/github\.com\/[^)\s]+)\)/)?.[1] || '';
  const job = body.match(/\[View job(?: run)?\]\((https:\/\/github\.com\/[^)\s]+)\)/)?.[1] || '';
  // The report is everything after the header line; drop the spinner image and other HTML.
  const cut = body.indexOf('\n---');
  let summary = (stage === 'working' || cut < 0 ? body : body.slice(cut + 4))
    .replace(/<img[^>]*>/gi, '').replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/^.*Claude Code is working.*$/gm, '').replace(/^\s*\[View job(?: run)?\]\([^)]*\)\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (summary.length > 4000) summary = summary.slice(0, 4000) + '…';
  return { stage, done, total, branch, prCreate, job, summary };
}

async function follow(id: string, d: Record<string, any>, issuesByRepo: Map<string, any[]>): Promise<Station> {
  const st: Station = { ...d.station };
  const s: Station = { repo: st.repo, at: st.at };
  // Find the GitHub issue: the one whose body ends with "工作站編號 pws:<id>", opened after the hand-off.
  let issue = st.issue && st.foundFor === st.at ? await gh(`/repos/${st.repo}/issues/${st.issue}`) : null;
  if (!issue) {
    const mark = new RegExp(`pws:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    issue = (issuesByRepo.get(st.repo) || []).filter(i => !i.pull_request && mark.test(i.body || '') && Date.parse(i.created_at) > st.at - 10 * 60_000)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] || null;
  }
  if (!issue) return { ...s, stage: 'unsent', checkedAt: Date.now() };
  Object.assign(s, { issue: issue.number, url: issue.html_url, foundFor: st.at });
  if (issue.html_url && !issue.html_url.includes(`/${st.repo}/`)) s.movedTo = issue.html_url;

  const comments: any[] = issue.comments ? await gh(`/repos/${st.repo}/issues/${issue.number}/comments?per_page=100`) : [];
  const mine = comments.filter(c => c.user?.type === 'Bot' && /claude/i.test(c.user?.login || '') && /Claude/.test(c.body || '')).pop();
  if (!mine) return { ...s, stage: issue.state === 'closed' ? 'closed' : 'queued', checkedAt: Date.now() };
  const c = readClaude(mine.body || '');
  Object.assign(s, { stage: c.stage, done: c.done, total: c.total, summary: c.summary, branch: c.branch, prCreate: c.prCreate, job: c.job });

  // A PR from Claude's branch: open → 等你合併, merged → 已合併.
  if (c.branch) {
    const owner = st.repo.split('/')[0];
    const prs: any[] = await gh(`/repos/${st.repo}/pulls?state=all&head=${encodeURIComponent(owner + ':' + c.branch)}&per_page=5`);
    const pr = prs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (pr) {
      s.pr = { number: pr.number, url: pr.html_url, state: pr.state, merged: !!pr.merged_at };
      s.stage = pr.merged_at ? 'merged' : pr.state === 'open' ? 'pr' : 'pr_closed';
    }
  }
  return { ...s, checkedAt: Date.now() };
}

// Still worth asking GitHub about: open items, and anything not merged/closed yet, for 30 days after the hand-off.
const active = (d: Record<string, any>) => d.station?.repo && d.station.at > Date.now() - 30 * DAY &&
  !['merged', 'pr_closed', 'closed'].includes(d.station.stage) && (isOpen(d.status) || d.station.stage !== 'unsent');

Deno.serve(async () => {
  const { data: prev } = await sb.from('docs').select('data').match({ collection: 'cfg', id: 'station' }).maybeSingle();
  if (prev?.data?.ok && Date.now() - prev.data.at < 50_000) return json({ skipped: true });
  token = Deno.env.get('STATION_GITHUB_TOKEN') || '';
  const status: Record<string, any> = { at: Date.now(), ok: !!token, repos: {} };
  if (!token) status.error = 'no_token';
  const { data: docs, error } = token ? await sb.from('docs').select('id,data,updated_at').eq('collection', 'issues').not('data->station', 'is', null) : { data: [], error: null };
  if (error) { status.ok = false; status.error = error.message; }
  const todo = (docs || []).filter(d => active(d.data));

  // One listing per repo covers every hand-off that hasn't found its issue yet.
  const issuesByRepo = new Map<string, any[]>();
  for (const repo of new Set(todo.map(d => d.data.station.repo as string))) {
    try {
      const since = Math.min(...todo.filter(d => d.data.station.repo === repo).map(d => d.data.station.at)) - 10 * 60_000;
      issuesByRepo.set(repo, await gh(`/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&since=${new Date(since).toISOString()}`));
      status.repos[repo] = { ok: true, following: 0 };
    } catch (e) {
      status.ok = false; status.repos[repo] = { ok: false, error: String((e as Error).message || e) };
    }
  }

  for (const d of todo) {
    const repo = d.data.station.repo, rs = status.repos[repo];
    if (!rs?.ok) continue;
    try {
      const s = await follow(d.id, d.data, issuesByRepo);
      rs.following++;
      const old = d.data.station;
      const same = (k: keyof Station) => JSON.stringify(old[k] ?? null) === JSON.stringify(s[k] ?? null);
      if ((['stage', 'issue', 'done', 'total', 'summary', 'branch', 'prCreate', 'pr', 'url'] as const).every(same)) continue;
      const next: Record<string, any> = { ...d.data, station: s, updatedAt: Date.now() };
      // Merged → the bug is waiting for you to check it in a build (待驗證). Only moves it forward from 處理中.
      if (s.stage === 'merged' && old.stage !== 'merged' && d.data.type === 'bug' && d.data.status === 'doing') next.status = 'verify';
      // Write only if nobody edited the item since we read it; otherwise the next run tries again.
      const { error: e2 } = await sb.from('docs').update({ data: next, updated_at: new Date().toISOString(), updated_by: 'station' })
        .match({ collection: 'issues', id: d.id, updated_at: d.updated_at });
      if (e2) throw e2;
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg === 'token_rejected' || msg === 'no_access') { status.ok = false; rs.ok = false; rs.error = msg; }
      else rs.last = msg;
    }
  }
  await sb.from('docs').upsert({ collection: 'cfg', id: 'station', data: status, updated_at: new Date().toISOString(), updated_by: 'station' });
  return json(status);
});
