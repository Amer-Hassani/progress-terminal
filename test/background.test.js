// Background jobs (Bash run_in_background, Monitor): a row each, settled from Claude Code's output file.
// Run: node test/background.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'python');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';
const UID = process.getuid();

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bg-'));
  const t = { home, tmp: path.join(home, 'tmp'), sid: 'sess-' + Math.random().toString(36).slice(2), slug: '-Users-test' };
  t.tasks = path.join(t.tmp, `claude-${UID}`, t.slug, t.sid, 'tasks');
  fs.mkdirSync(t.tasks, { recursive: true });
  t.transcript = path.join(home, 'projects', t.slug, t.sid + '.jsonl');
  return t;
}
const env = (t) => ({ ...process.env, PROGRESS_HOME: t.home, CLAUDE_CONFIG_DIR: path.join(t.home, 'cfg'), CLAUDE_CODE_TMPDIR: t.tmp });
const hook = (t, ev) => spawnSync(PY, ['-I', path.join(SRC, 'hook.py')],
  { input: JSON.stringify({ session_id: t.sid, transcript_path: t.transcript, ...ev }), encoding: 'utf8', env: env(t) });
const py = (t, code) => spawnSync(PY, ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(SRC)})\nimport core, time\n` + code],
  { encoding: 'utf8', env: env(t) });
const prune = (t) => py(t, 'with core.Lock():\n    core.prune()');  // what the view does every second
const job = (t) => {
  const dir = path.join(t.home, 'jobs');
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))[0];
};
const bg = (t, name) => (job(t).bg || []).find((r) => r.name === name);
const edit = (t, fn) => {
  const dir = path.join(t.home, 'jobs');
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const p = path.join(dir, n); const j = JSON.parse(fs.readFileSync(p, 'utf8')); fn(j); fs.writeFileSync(p, JSON.stringify(j));
  }
};
const out = (t, id, text) => fs.writeFileSync(path.join(t.tasks, id + '.output'), text);
const bash = (t, uid, desc, extra = {}) => hook(t, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: uid,
  tool_input: { command: 'cp -r a b', description: desc, run_in_background: true, ...extra } });
const bashDone = (t, uid, desc, id) => hook(t, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: uid,
  tool_input: { command: 'cp -r a b', description: desc, run_in_background: true },
  tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id } });
const monitor = (t, uid, desc, id, ms) => {
  hook(t, { hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_use_id: uid, tool_input: { description: desc, command: 'tail -f x', timeout_ms: ms } });
  return hook(t, { hook_event_name: 'PostToolUse', tool_name: 'Monitor', tool_use_id: uid, tool_input: { description: desc, timeout_ms: ms },
    tool_response: { taskId: id, timeoutMs: ms, persistent: false } });
};

// 1. a background command: a row while it runs, the job waits for it, and it ends as done
{
  const t = fresh();
  hook(t, { hook_event_name: 'UserPromptSubmit', prompt: 'copy the files' });
  bash(t, 'tu1', 'Copy WhatsApp held');
  ok('command: one row, running, named after its description', job(t).bg.length === 1 && bg(t, 'Copy WhatsApp held').kind === 'command' && !bg(t, 'Copy WhatsApp held').state);
  const r = bashDone(t, 'tu1', 'Copy WhatsApp held', 'bcopy1');
  ok('command: PostToolUse exits 0 and gives the task id', r.status === 0 && bg(t, 'Copy WhatsApp held').id === 'bcopy1', r.stderr);
  out(t, 'bcopy1', 'copying...\n');
  hook(t, { hook_event_name: 'Stop', background_tasks: [{ id: 'bcopy1', type: 'shell', status: 'running', description: 'Copy WhatsApp held' }] });
  ok('command: the turn ends, the job waits for it', job(t).waiting === true && !job(t).end);
  ok('command: its output file is found', (bg(t, 'Copy WhatsApp held').out || '').endsWith('bcopy1.output'));
  prune(t);
  ok('command: still running while the file has no end line', !bg(t, 'Copy WhatsApp held').state && !job(t).end);
  out(t, 'bcopy1', 'copying...\n\n[exited with code 0]\n');
  prune(t);
  ok('command: ends as done, exit 0, and the job ends', bg(t, 'Copy WhatsApp held').state === 'done' && bg(t, 'Copy WhatsApp held').code === 0 && !!job(t).end);
  ok('command: post flag untouched by a Bash PostToolUse', !job(t).post);
}

// 2. a failed command keeps its exit code; a stopped one says stopped
{
  const t = fresh();
  bash(t, 'tu1', 'Pre-copy history'); bashDone(t, 'tu1', 'Pre-copy history', 'bpre1');
  bash(t, 'tu2', 'Server'); bashDone(t, 'tu2', 'Server', 'bsrv1');
  out(t, 'bpre1', 'x\n\n[exited with code 144]\n');
  out(t, 'bsrv1', 'listening\n\n[killed]\n');
  prune(t);
  ok('failed: exit code kept', bg(t, 'Pre-copy history').state === 'failed' && bg(t, 'Pre-copy history').code === 144);
  ok('killed command: stopped', bg(t, 'Server').state === 'stopped');
}

// 3. a watch (Monitor): latest event, then expired at its time limit or stopped before it
{
  const t = fresh();
  monitor(t, 'tm1', 'WhatsApp pre-copy progress', 'bwat1', 1800000);
  monitor(t, 'tm2', 'Oracle launch', 'bwat2', 600000);
  ok('watch: row kind and time limit', bg(t, 'WhatsApp pre-copy progress').kind === 'watch' && bg(t, 'WhatsApp pre-copy progress').timeout === 1800000);
  out(t, 'bwat1', 'copied 2 MB of ~139\ncopied 3 MB of ~139\n');
  prune(t);
  ok('watch: latest event line kept', bg(t, 'WhatsApp pre-copy progress').last === 'copied 3 MB of ~139', JSON.stringify(bg(t, 'WhatsApp pre-copy progress')));
  edit(t, (j) => { j.bg.find((r) => r.id === 'bwat2').t0 -= 601; });
  out(t, 'bwat2', 'LAUNCHED\n\n[killed]\n');
  out(t, 'bwat1', 'copied 2 MB of ~139\ncopied 3 MB of ~139\n\n[killed]\n');
  prune(t);
  ok('watch killed at its limit: expired', bg(t, 'Oracle launch').state === 'expired');
  ok('watch killed early: stopped, latest event still the real one', bg(t, 'WhatsApp pre-copy progress').state === 'stopped' &&
    bg(t, 'WhatsApp pre-copy progress').last === 'copied 3 MB of ~139');
}

// 4. without PostToolUse (older settings): the id is learned from Stop's list of background work
{
  const t = fresh();
  bash(t, 'tu1', 'Build the app');
  out(t, 'bbld1', 'building\n');
  hook(t, { hook_event_name: 'Stop', background_tasks: [{ id: 'bbld1', type: 'shell', status: 'running', description: 'Build the app' }] });
  ok('no PostToolUse: id learned from Stop', bg(t, 'Build the app').id === 'bbld1' && !bg(t, 'Build the app').state && job(t).waiting === true);
  out(t, 'bbld1', 'building\n\n[exited with code 2]\n');
  prune(t);
  ok('no PostToolUse: still settled from the file', bg(t, 'Build the app').state === 'failed' && bg(t, 'Build the app').code === 2 && !!job(t).end);
}

// 5. task notifications fill in what the file can't tell (file already cleaned up)
{
  const t = fresh();
  bash(t, 'tu1', 'Long copy'); bashDone(t, 'tu1', 'Long copy', 'blong1');
  monitor(t, 'tm1', 'Copy watch', 'bwat9', 1800000);
  hook(t, { hook_event_name: 'Stop', background_tasks: [{ id: 'blong1', type: 'shell', status: 'running', description: 'Long copy' },
    { id: 'bwat9', type: 'monitor', status: 'running', description: 'Copy watch' }] });
  hook(t, { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>bwat9</task-id>\n<summary>Monitor event: "Copy watch"</summary>\n<event>copied 9 MB of ~139</event>\n</task-notification>' });
  ok('notice: a watch event becomes its latest line', bg(t, 'Copy watch').last === 'copied 9 MB of ~139');
  hook(t, { hook_event_name: 'UserPromptSubmit', prompt: '[SYSTEM NOTIFICATION]\n<task-notification>\n<task-id>blong1</task-id>\n<status>failed</status>\n<summary>Background command "Long copy" failed with exit code 144</summary>\n</task-notification>' });
  ok('notice: failed with its exit code', bg(t, 'Long copy').state === 'failed' && bg(t, 'Long copy').code === 144);
  hook(t, { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>bwat9</task-id>\n<summary>Monitor event: "Copy watch"</summary>\n<event>[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>' });
  ok('notice: watch expiry', bg(t, 'Copy watch').state === 'expired' && bg(t, 'Copy watch').last === 'copied 9 MB of ~139');
  ok('notice: nothing open any more, the waiting job ends', !!job(t).end);
  ok('notice: never used as the task title', !fs.existsSync(path.join(t.home, 'sessions', t.sid + '.json')) ||
    !JSON.parse(fs.readFileSync(path.join(t.home, 'sessions', t.sid + '.json'), 'utf8')).title.includes('task-notification'));
}

// 6. what is not a background job
{
  const t = fresh();
  hook(t, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'f1', tool_input: { command: 'ls', description: 'List files' } });
  bash(t, 'p1', 'Install CLI', { command: '/Users/x/.claude/progress-terminal/progress run "Install" -- brew install x' });
  ok('foreground Bash and background `progress run` (it shows as its own step): no row', !(job(t).bg || []).length);
  bash(t, 'x1', 'Quick one');
  hook(t, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x1', tool_input: {}, tool_response: { stdout: 'hi', stderr: '' } });
  ok('a call that did not go to the background: row removed', !(job(t).bg || []).length);
  hook(t, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: {}, tool_response: {} });
  ok('PostToolUse of another tool still marks tool-finished events', job(t).post === true);
  hook(t, { hook_event_name: 'PreToolUse', agent_type: 'general-purpose', agent_id: 'a1', tool_name: 'Bash', tool_use_id: 's1',
    tool_input: { command: 'x', description: 'Agent bg', run_in_background: true } });
  ok("an agent's own background command is not shown in the main job", !(job(t).bg || []).length);
}

// 7. a vanished command (no file, no longer listed on Stop) is closed as ended, not left running for hours
{
  const t = fresh();
  bash(t, 'tu1', 'Ghost');
  edit(t, (j) => { j.bg[0].t0 -= 120; });
  hook(t, { hook_event_name: 'Stop', background_tasks: [] });
  ok('vanished: ended, job ends', bg(t, 'Ghost').state === 'ended' && !!job(t).end);
}

// 8. the view: BACKGROUND block, folding, widths
{
  const t = fresh();
  const r = py(t, String.raw`
import json, re, view
strip = lambda l: re.sub(r'\x1b\[[0-9;]*m', '', l)
now = time.time()
j = core.new_job('sess-v', 'Move WhatsApp')
j['bg'] = [
  {'kind': 'command', 'name': 'Copy WhatsApp held (121 MB, laptop to Oracle)', 't0': now - 750},
  {'kind': 'watch', 'name': 'WhatsApp pre-copy progress (MB on Oracle)', 't0': now - 200, 'timeout': 1800000, 'last': 'copied 3 MB of ~139 ' + 'x' * 300},
  {'kind': 'command', 'name': 'Install CLI', 't0': now - 300, 't1': now - 170, 'state': 'done', 'code': 0},
  {'kind': 'command', 'name': 'Pre-copy', 't0': now - 3000, 't1': now - 600, 'state': 'failed', 'code': 144},
]
j['tool'] = {'name': 'Bash: x', 't': now}; j['ev_t'] = now
out = {}
for cols in (150, 80, 50):
    W = max(20, min(50, cols - 40))
    lines = view.section(j, cols, W, now)
    out[str(cols)] = {'lines': [strip(l) for l in lines], 'shown': [len(strip(view.visual(view.clip(l, cols - 1)))) for l in lines],
                      'raw': [len(strip(l)) for l in lines if 'B1.' in strip(l) or 'B2.' in strip(l) or 'latest:' in strip(l)]}
view.show_all = True
out['all'] = [strip(l) for l in view.section(j, 150, 50, now)]
out['doing'] = view.activity(j, now)[1]
print(json.dumps(out))
`);
  let v = {};
  try { v = JSON.parse(r.stdout); } catch { console.log(r.stderr); }
  const L = (v['150'] || {}).lines || [];
  ok('view: BACKGROUND header with counts', L.some((l) => /BACKGROUND\s+2 running · 2 done/.test(l)), L.join('\n'));
  ok('view: running command with its time', L.some((l) => /B1\. Copy WhatsApp held.*command · running · 12m 30s/.test(l)));
  ok('view: running watch with its limit and latest event', L.some((l) => /B2\. .*watch · running · 3m 20s of 30m 00s/.test(l)) && L.some((l) => l.includes('latest: copied 3 MB of ~139')));
  ok('view: finished jobs fold into one line', L.some((l) => /✔ 2 background jobs done \(1 failed or stopped\) · press a/.test(l)) && !L.some((l) => l.includes('Install CLI')));
  const A = v.all || [];
  ok('view: a lists them, with exit code', A.some((l) => /B3\. Install CLI.*done · 2m 10s/.test(l)) && A.some((l) => /B4\. Pre-copy.*failed · exit 144 · 40m 00s/.test(l)));
  ok('view: "now" names the background work', /1 background command · 1 watch running/.test(v.doing || ''), v.doing);
  for (const c of ['150', '80', '50']) {
    ok(`view ${c} cols: no line wider than the terminal`, ((v[c] || {}).shown || [0]).every((n) => n <= Number(c) - 1));
  }
  ok('view 80 cols: background rows fit without cutting', ((v['80'] || {}).raw || [999]).every((n) => n <= 79), JSON.stringify((v['80'] || {}).raw));
}

console.log(`--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
