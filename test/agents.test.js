// Agent rows: closed by the agent that really stopped, and closed when the agent vanished. Run: node test/agents.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'python');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-agents-'));
  return { home, sid: 'sess-' + Math.random().toString(36).slice(2) };
}
const hook = (t, ev) => spawnSync(PY, ['-I', path.join(SRC, 'hook.py')],
  { input: JSON.stringify({ session_id: t.sid, ...ev }), encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: t.home } });
const job = (t) => {
  const dir = path.join(t.home, 'jobs');
  const f = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n))
    .map((p) => JSON.parse(fs.readFileSync(p, 'utf8'))).find((j) => j.session === t.sid || true);
  return f;
};
const age = (t, secs) => {  // make every agent row older, to get past the grace period
  const dir = path.join(t.home, 'jobs');
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const p = path.join(dir, n); const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    (j.agents || []).forEach((a) => { a.t0 -= secs; });
    fs.writeFileSync(p, JSON.stringify(j));
  }
};
const launch = (t, desc) => hook(t, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: desc, prompt: 'x' } });
const task = (id, desc, status = 'running') => ({ id, type: 'subagent', status, description: desc });
const row = (t, name) => job(t).agents.find((a) => a.name === name);

// 1. the agent that stopped is the one ticked, not the oldest
{
  const t = fresh();
  hook(t, { hook_event_name: 'UserPromptSubmit', prompt: 'do it' });
  launch(t, 'Build slides 1'); launch(t, 'Build slides 2');
  const r = hook(t, { hook_event_name: 'SubagentStop', agent_id: 'b2', agent_type: 'general-purpose',
    background_tasks: [task('b1', 'Build slides 1'), task('b2', 'Build slides 2')] });
  ok('SubagentStop: exit 0', r.status === 0, r.stderr);
  ok('SubagentStop: the stopped agent is ticked', row(t, 'Build slides 2').done === true && !row(t, 'Build slides 2').stopped);
  ok('SubagentStop: the older, still running agent stays open and learns its id', row(t, 'Build slides 1').done === false && row(t, 'Build slides 1').id === 'b1');
}

// 2. agents that vanished (stopped by hand, killed by a restart) are closed as stopped; the job can end
{
  const t = fresh();
  launch(t, 'Resume batch 1'); launch(t, 'Resume batch 2'); launch(t, 'Still going');
  age(t, 120);
  hook(t, { hook_event_name: 'Stop', background_tasks: [task('s3', 'Still going')] });
  ok('Stop: vanished agents closed as stopped', row(t, 'Resume batch 1').stopped === true && row(t, 'Resume batch 2').stopped === true);
  ok('Stop: the listed agent stays open, job waits', row(t, 'Still going').done === false && job(t).waiting === true && !job(t).end);
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 's3', background_tasks: [task('s3', 'Still going')] });
  ok('last agent stops: done (not stopped), job ends', row(t, 'Still going').done === true && !row(t, 'Still going').stopped && !!job(t).end);
}

// 3. grace: an agent launched a moment ago is not closed just because it is not listed yet
{
  const t = fresh();
  launch(t, 'Old one'); age(t, 120); launch(t, 'Brand new');
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'zz', background_tasks: [] });
  ok('grace: a brand-new agent stays open', row(t, 'Brand new').done === false);
}

// 4. foreground agent (never in the list): ticked as done, not as stopped
{
  const t = fresh();
  launch(t, 'Foreground check');
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'f1', background_tasks: [] });
  ok('foreground agent: done, not stopped', row(t, 'Foreground check').done === true && !row(t, 'Foreground check').stopped);
}

// 5. older Claude Code without background_tasks: the oldest open row, as before
{
  const t = fresh();
  launch(t, 'First'); launch(t, 'Second');
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'x' });
  ok('no list: oldest closed, the other untouched', row(t, 'First').done === true && row(t, 'Second').done === false);
  hook(t, { hook_event_name: 'Stop' });
  ok('no list: Stop does not close agents it cannot see', row(t, 'Second').done === false);
}

// 6. a message to a running agent carries its id
{
  const t = fresh();
  hook(t, { hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'm1', summary: 'Use Sonnet', message: 'x' } });
  const a = job(t).agents[0];
  ok('SendMessage: id taken from "to"', a.id === 'm1');
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'm1', background_tasks: [task('m1', 'Original description')] });
  ok('SendMessage row closed by its own agent', job(t).agents[0].done === true && !job(t).agents[0].stopped);
}

// 7. the view says how many were stopped without a report
{
  const t = fresh();
  for (let i = 0; i < 4; i++) launch(t, 'Batch ' + i);
  age(t, 120);
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'q0', background_tasks: [task('q0', 'Batch 0')] });
  const out = spawnSync(PY, ['-I', '-c', `
import sys, os, re, json
sys.path.insert(0, ${JSON.stringify(SRC)})
import core, view
j = [x for x in core.all_jobs()][0]
for _ in range(10):
    view._dt = 3.0
    lines = view.section(j, 150, 50, j['t0'] + 200)
print('\\n'.join(re.sub(r'\\x1b\\[[0-9;]*m', '', l) for l in lines))
`], { encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: t.home } });
  ok('view: one folded line with the stopped count', /4 agents done \(3 stopped without a report\)/.test(out.stdout), out.stdout + out.stderr);
}

console.log(`--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
