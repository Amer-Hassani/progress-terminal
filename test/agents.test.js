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
  { input: JSON.stringify({ session_id: t.sid, ...ev }), encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: t.home, CLAUDE_CONFIG_DIR: path.join(t.home, 'cfg') } });
const job = (t) => {
  const dir = path.join(t.home, 'jobs');
  const f = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n))
    .map((p) => JSON.parse(fs.readFileSync(p, 'utf8')))[0];
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

// 8. two foreground agents (never listed): the first stopping leaves the second running
{
  const t = fresh();
  launch(t, 'FG one'); launch(t, 'FG two'); age(t, 60);
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'f1', background_tasks: [] });
  ok('foreground pair: the second stays running, not stopped', row(t, 'FG two').done === false && !row(t, 'FG two').stopped);
}

// 9. a background agent stopping while a foreground one runs leaves the foreground one alone
{
  const t = fresh();
  launch(t, 'BG'); launch(t, 'FG long'); age(t, 60);
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'b1', background_tasks: [task('b1', 'BG')] });
  ok('bg stops during fg: bg done, fg still running', row(t, 'BG').done === true && row(t, 'FG long').done === false);
}

// 10. a message to an agent by id reuses its row (one agent = one row); it closes as done when it stops, not "stopped"
{
  const t = fresh();
  launch(t, 'Lead');
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'other', background_tasks: [task('l1', 'Lead'), task('other', 'Other')] });
  hook(t, { hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'l1', summary: 'RESULT' } });
  age(t, 60);
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'l1', background_tasks: [task('l1', 'Lead')] });
  const rows = job(t).agents.filter((a) => a.id === 'l1');
  ok('message by id: one row for the agent, done, not stopped, message kept', rows.length === 1 && rows[0].done && !rows[0].stopped && rows[0].msgs[0] === 'RESULT', JSON.stringify(job(t).agents));
}

// 11. a message to an agent by name, agent still running: never labelled stopped
{
  const t = fresh();
  launch(t, 'Lead');
  hook(t, { hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'lead-name', summary: 'RESULT' } });
  age(t, 60);
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'zz', background_tasks: [task('l1', 'Lead')] });
  ok('message by name: not closed on another agent stopping', row(t, 'RESULT').done === false);
  hook(t, { hook_event_name: 'Stop', background_tasks: [task('l1', 'Lead')] });
  ok('message by name: on Stop done, never "stopped"; the agent itself stays running', !row(t, 'RESULT').stopped && row(t, 'Lead').done === false);
}

// 7. the view says how many were stopped without a report
{
  const t = fresh();
  for (let i = 0; i < 4; i++) launch(t, 'Batch ' + i);
  age(t, 120);
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'q0', background_tasks: [task('q0', 'Batch 0')] });
  hook(t, { hook_event_name: 'Stop', background_tasks: [] });  // turn over: the other three vanished
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


// 6. each agent row shows its model and effort; tasks under one agent drive its %
{
  const t = fresh();
  const agentsDir = path.join(t.home, 'proj', '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'lead.md'), '---\nname: lead\nmodel: claude-fable-5-2\neffort: low\n---\nbody');
  const cwd = path.join(t.home, 'proj');
  hook(t, { hook_event_name: 'PreToolUse', cwd, tool_name: 'Agent', tool_input: { description: 'Set A', prompt: 'x', model: 'sonnet', effort: 'medium' } });
  hook(t, { hook_event_name: 'PreToolUse', cwd, tool_name: 'Agent', tool_input: { description: 'Lead', prompt: 'x', subagent_type: 'lead' } });
  hook(t, { hook_event_name: 'PreToolUse', cwd, tool_name: 'Agent', tool_input: { description: 'Plain', prompt: 'x' } });
  ok('spec: model + effort from the call', row(t, 'Set A').model === 'Sonnet' && row(t, 'Set A').effort === 'medium');
  ok('spec: model + effort from the definition file', row(t, 'Lead').model === 'Fable 5.2' && row(t, 'Lead').effort === 'low' && row(t, 'Lead').type === 'lead');
  ok('spec: nothing given = same as session', row(t, 'Plain').model === 'same model as session' && row(t, 'Plain').effort === 'default effort');
  const prog = (...a) => spawnSync(PY, ['-I', path.join(SRC, 'progress.py'), '-j', job(t).id, ...a], { encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: t.home } });
  const r1 = prog('tasks', 'Set A', 'slide 63|slide 97|slide 98|slide 99');
  const r2 = prog('task', 'Set A', 'slide 63');
  ok('tasks: listed under the agent and ticked', r1.status === 0 && r2.status === 0 && row(t, 'Set A').tasks.length === 4 && row(t, 'Set A').tasks[0].done === true, r1.stderr + r2.stderr);
  const v = spawnSync(PY, ['-I', '-c', `import sys,re,json; sys.path.insert(0, sys.argv[1]); import core, view
j = core.load(sys.argv[2]); print('\\n'.join(re.sub(r'\\x1b\\[[0-9;]*m', '', l) for l in view.section(j, 160, 50, j['t0'] + 5)))`, SRC, job(t).id],
  { encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: t.home } });
  ok('view: model and effort under the agent row', /Sonnet · medium effort/.test(v.stdout) && /Fable 5\.2 · low effort · lead/.test(v.stdout), v.stdout + v.stderr);
  ok('view: tasks line with the ticked one', /tasks 1\/4: ✔ slide 63  ▸ slide 97/.test(v.stdout), v.stdout);
  ok('view: agent % comes from its tasks', /A1\.\s+Set A\s+~?\s*25\.000%/.test(v.stdout), v.stdout);
  const v2 = spawnSync(PY, ['-I', '-c', `import sys; sys.path.insert(0, sys.argv[1]); import view; print(view.mid('agent: Retype slide words, set A', 30)); print(view.mid('agent: Retype slide words, set B', 30))`, SRC], { encoding: 'utf8' });
  const [m1, m2] = v2.stdout.trim().split('\n');
  ok('view: long names cut in the middle keep their end', m1.length === 30 && m1.endsWith('set A') && m2.endsWith('set B') && m1 !== m2, v2.stdout + v2.stderr);
  ok('view: AGENTS heading counts running and done, by model, main chat as A0', /AGENTS\s+4 running · 0 done\s+1 × model unknown · default effort, 1 × Sonnet · medium effort, 1 × Fable 5\.2 · low effort/.test(v.stdout) && /A0\.\s+Main chat/.test(v.stdout), v.stdout);
  ok('view: now line counts agents by model', /3 agents running \(Sonnet · medium effort, Fable 5\.2 · low effort, same model as session · default effort\)/.test(v.stdout), v.stdout);
}

// 7. model and effort always shown: a message to an agent launched in an earlier prompt, and a plain launch
{
  const t = fresh();
  const cwd = path.join(t.home, 'proj');
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'lead.md'), '---\nname: lead\nmodel: claude-fable-5-2\neffort: low\n---\nbody');
  const tp = path.join(t.home, 'sess.jsonl');
  fs.writeFileSync(tp, '{"message":{"model":"claude-opus-5-5"}}\n');
  const sub = path.join(t.home, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a123.meta.json'), JSON.stringify({ agentType: 'lead' }));
  fs.writeFileSync(path.join(sub, 'agent-a123.jsonl'), '{"message":{"model":"claude-fable-5-2"}}\n');
  hook(t, { hook_event_name: 'PreToolUse', cwd, transcript_path: tp, tool_name: 'SendMessage', tool_input: { to: 'a123', summary: 'DONE: paused', message: 'x' } });
  const m = row(t, 'DONE: paused');
  ok('spec: message to an earlier agent gets its model, effort and type', m && m.model === 'Fable 5.2' && m.effort === 'low' && m.type === 'lead', JSON.stringify(m));
  hook(t, { hook_event_name: 'PreToolUse', cwd, transcript_path: tp, effort: 'medium', tool_name: 'Agent', tool_input: { description: 'Plain2', prompt: 'x' } });
  const p2 = row(t, 'Plain2');
  ok('spec: plain launch names the session model and effort', p2.model === 'Opus 5.5' && p2.effort === 'medium', JSON.stringify(p2));
}

// 8. no effort anywhere on the call, file or event: the level from settings.json, by name
{
  const t = fresh();
  fs.mkdirSync(path.join(t.home, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(t.home, 'cfg', 'settings.json'), JSON.stringify({ effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } }));
  const tp = path.join(t.home, 'sess.jsonl');
  fs.writeFileSync(tp, '{"message":{"model":"claude-opus-5-5"}}\n');
  hook(t, { hook_event_name: 'PreToolUse', transcript_path: tp, tool_name: 'Agent', tool_input: { description: 'P3', prompt: 'x' } });
  hook(t, { hook_event_name: 'PreToolUse', transcript_path: tp, tool_name: 'Agent', tool_input: { description: 'P4', prompt: 'x', model: 'haiku' } });
  ok('spec: effort from settings for that model', row(t, 'P3').model === 'Opus 5.5' && row(t, 'P3').effort === 'medium', JSON.stringify(row(t, 'P3')));
  ok('spec: effort from the general setting', row(t, 'P4').model === 'Haiku' && row(t, 'P4').effort === 'high', JSON.stringify(row(t, 'P4')));
}

// 9. agents launched by an agent: a nested row each, closed by their own stop, never by a main-session guess
{
  const t = fresh();
  const tr = path.join(t.home, 'main.jsonl'); fs.writeFileSync(tr, '');
  const sub = path.join(t.home, 'main', 'subagents'); fs.mkdirSync(sub, { recursive: true });
  const meta = (id, parent, desc) => fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ parentAgentId: parent, description: desc }));
  hook(t, { hook_event_name: 'PreToolUse', tool_name: 'Agent', transcript_path: tr, tool_input: { description: 'Lead', model: 'sonnet', effort: 'medium' } });
  hook(t, { hook_event_name: 'Stop', transcript_path: tr, background_tasks: [task('L1', 'Lead')] }); // the lead runs in the background: its row learns id L1
  const kid = (d) => hook(t, { hook_event_name: 'PreToolUse', agent_type: 'general-purpose', agent_id: 'L1', tool_name: 'Agent',
    tool_input: { description: d, model: 'haiku', effort: 'high' } });
  kid('Fetch A'); kid('Fetch B'); kid('Fetch C');
  hook(t, { hook_event_name: 'PreToolUse', agent_type: 'general-purpose', agent_id: 'L1', tool_name: 'WebSearch', tool_input: {} });
  const rows = job(t).agents;
  ok('nested: one row per launched fetcher, others ignored', rows.length === 4, JSON.stringify(rows.map((a) => a.name)));
  ok('nested: row marked, parent kept, model + effort', row(t, '↳ Fetch B').nested === true && row(t, '↳ Fetch B').parent === 'L1'
    && row(t, '↳ Fetch B').model === 'Haiku' && row(t, '↳ Fetch B').effort === 'high');
  meta('K2', 'L1', 'Fetch B');
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'K2', agent_type: 'general-purpose', transcript_path: tr });
  ok('nested: its own stop ticks the right row', row(t, '↳ Fetch B').done === true && row(t, '↳ Fetch A').done === false);
  ok('nested: a nested stop never closes the lead', row(t, 'Lead').done === false);
  age(t, 120);
  hook(t, { hook_event_name: 'Stop', transcript_path: tr, background_tasks: [task('L1', 'Lead')] });
  ok('nested: main Stop leaves running fetchers open while the lead runs', row(t, '↳ Fetch A').done === false && row(t, '↳ Fetch C').done === false);
  hook(t, { hook_event_name: 'SubagentStop', agent_id: 'L1', transcript_path: tr, background_tasks: [] });
  ok('nested: the lead stops, its fetchers close with it', row(t, 'Lead').done === true && row(t, '↳ Fetch A').done === true && row(t, '↳ Fetch C').done === true);
}

console.log(`--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
