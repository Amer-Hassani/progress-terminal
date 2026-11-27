// What a running agent is doing, under its row: latest action, the one before, tool calls, running time.
// Run: node test/activity.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'python');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';

// Runs hook.main() in one process for a list of payloads, counting job-file writes per payload, then renders the job.
const DRIVER = String.raw`
import json, os, re, sys, time
sys.path.insert(0, sys.argv[1])
import core, hook, view
steps = json.loads(sys.stdin.read())
writes = []
real_save = core.save
count = [0]
def counting_save(j):
    count[0] += 1
    real_save(j)
core.save = counting_save
for d in steps['calls']:
    count[0] = 0
    hook.main(d)
    writes.append(count[0])
core.save = real_save
j = [x for x in core.all_jobs() if not x.get('end')][-1] if any(not x.get('end') for x in core.all_jobs()) else core.all_jobs()[-1]
strip = lambda l: re.sub(r'\x1b\[[0-9;]*m', '', l)
out = {'writes': writes, 'job': j, 'render': {}, 'raw': {}}
for cols in steps.get('cols', [120]):
    W = max(20, min(50, cols - 40))
    lines = view.section(j, cols, W, time.time() + steps.get('later', 0))
    out['render'][str(cols)] = [strip(view.visual(view.clip(l, cols - 1))) for l in lines]
    out['raw'][str(cols)] = [view.visual(view.clip(l, cols - 1)) for l in lines]
print(json.dumps(out))
`;

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-act-'));
  const sid = 'sess-' + Math.random().toString(36).slice(2);
  const tr = path.join(home, 'proj', sid + '.jsonl');
  fs.mkdirSync(path.join(home, 'proj', sid, 'subagents'), { recursive: true });
  fs.writeFileSync(tr, '');
  return { home, sid, tr };
}
const meta = (t, id, m) => fs.writeFileSync(path.join(t.home, 'proj', t.sid, 'subagents', `agent-${id}.meta.json`), JSON.stringify(m));
function run(t, calls, opts = {}) {
  const r = spawnSync(PY, ['-I', '-c', DRIVER, SRC], {
    input: JSON.stringify({ calls: calls.map((c) => ({ session_id: t.sid, transcript_path: t.tr, ...c })), ...opts }),
    encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: t.home, CLAUDE_CONFIG_DIR: path.join(t.home, 'cfg') } });
  try { return JSON.parse(r.stdout); } catch { console.log(r.stderr); return { writes: [], job: {}, render: {} }; }
}
const A = (id, type, e) => ({ agent_id: id, agent_type: type, ...e });
const pre = (tool, input, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'tu' + Math.random(), ...extra });
const launch = (desc, type) => pre('Agent', { description: desc, subagent_type: type, model: 'opus', effort: 'medium' });
const W = (r, cols) => (r.render[String(cols)] || []);

// 1. one tool call by an agent writes the job file once; history stays at two actions + a counter
{
  const t = fresh();
  meta(t, 'a1', { agentType: 'general-purpose', description: 'Fix the server' });
  const calls = [launch('Fix the server', 'general-purpose')];
  for (let i = 1; i <= 10; i++) calls.push(A('a1', 'general-purpose', pre('Read', { file_path: `/Users/x/deep/secret-folder/file${i}.mjs` })));
  calls.push(A('a1', 'general-purpose', pre('Bash', { command: 'rm -rf /Users/x/private && echo glpat-abcdefghijklmnopqrstuv', description: 'Run the tests' })));
  calls.push(A('a1', 'general-purpose', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: {}, tool_response: { stdout: 'ok' } }));
  calls.push(A('a1', 'general-purpose', pre('Read', { file_path: '/Users/x/deep/server.mjs' })));
  const r = run(t, calls, { cols: [120, 80, 50], later: 12 });
  const agentWrites = r.writes.slice(1);
  ok('one tool call by an agent = one write of the job file', agentWrites.slice(0, 11).every((n) => n === 1) && agentWrites[12] === 1, JSON.stringify(r.writes));
  ok("an agent's foreground PostToolUse writes nothing", agentWrites[11] === 0, JSON.stringify(r.writes));
  const st = r.job.acts && r.job.acts.a1;
  ok('history per agent: last two actions and a counter, nothing more', st && st.n === 12 && st.last.length === 2 &&
    st.last[0].a === 'Bash: Run the tests' && st.last[1].a === 'Read: server.mjs', JSON.stringify(st));
  const text = JSON.stringify(r.job);
  ok('never command text, full paths or secrets in the job file', !text.includes('rm -rf') && !text.includes('/Users/x/deep') && !text.includes('glpat-'), text);
  ok('the row was found from Claude Code\'s record of the agent (no id needed)', r.job.agents[0].aid === 'a1' && !r.job.agents[0].id);
  const L = W(r, 120);
  ok('rendered: "now:" line with the latest action and its age', L.some((l) => /^ {7}now: Read: server\.mjs · started 12s ago$/.test(l)), L.join('\n'));
  ok('rendered: the action before, tool calls and running time', L.some((l) => /^ {7}before: Bash: Run the tests · 12 tool calls · running \d+s$/.test(l)), L.join('\n'));
  for (const c of [120, 80, 50]) ok(`rendered at ${c} columns: "now:" says "started"`, W(r, c).some((l) => /^ {7}now: .* · started /.test(l)), JSON.stringify(W(r, c)));
  for (const c of [120, 80, 50]) ok(`rendered at ${c} columns: no line wider than the terminal`, W(r, c).every((l) => [...l].length <= c - 1), JSON.stringify(W(r, c)));
  console.log('SAMPLE agent row:\n' + L.filter((l) => /A1\.|^ {7}/.test(l)).join('\n'));
}

// 2. the tech lead: named "Tech lead" (never after a message summary), its own work shown the same way
{
  const t = fresh();
  meta(t, 'lead1', { agentType: 'tech-lead', description: 'Supervise the build' });
  const calls = [pre('Read', { file_path: '/a/b.txt' }),
    pre('SendMessage', { to: 'lead1', summary: 'GO: build 0.1.11 activity', message: 'x' }),
    A('lead1', 'tech-lead', pre('Read', { file_path: '/Users/x/.claude/projects/p/session.jsonl' })),
    A('lead1', 'tech-lead', pre('Grep', { pattern: 'secret', path: '/Users/x' }))];
  fs.mkdirSync(path.join(t.home, 'cfg', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(t.home, 'cfg', 'agents', 'tech-lead.md'), '---\nname: tech-lead\nmodel: fable\neffort: medium\n---\n');
  const r = run(t, calls, { cols: [120], later: 75 });
  const row = r.job.agents[0];
  ok('tech lead: row named "Tech lead", the summary kept as its message', row.name === 'Tech lead' && row.msgs[0] === 'GO: build 0.1.11 activity', JSON.stringify(row));
  ok('tech lead: its activity is recorded and bound to its row', r.job.acts.lead1.n === 2 && r.job.acts.lead1.last[1].a === 'Grep');
  const L = W(r, 120);
  ok('tech lead: rendered with "now:" and the action before', L.some((l) => /A1\. Tech lead/.test(l)) && L.some((l) => /now: Grep · started 1m 1\ds ago/.test(l)) &&
    L.some((l) => /before: Read: session\.jsonl · 2 tool calls/.test(l)), L.join('\n'));
  ok('tech lead: grep pattern and searched path never stored', !JSON.stringify(r.job).includes('secret') && !JSON.stringify(r.job).includes('/Users/x'));
  console.log('SAMPLE tech lead row:\n' + L.filter((l) => /A1\.|^ {7}/.test(l)).join('\n'));
  const t2 = fresh();
  const r2 = run(t2, [launch('Review the plan', 'tech-lead')], { cols: [120] });
  ok('tech lead launched with the Agent tool: also "Tech lead"', r2.job.agents[0].name === 'Tech lead');
}

// 3. a message to an agent from an earlier prompt keeps its first good name
{
  const t = fresh();
  meta(t, 'b7', { agentType: 'general-purpose', description: 'Build slides' });
  const r = run(t, [pre('Read', { file_path: '/a' }), pre('SendMessage', { to: 'b7', summary: 'please also fix slide 4', message: 'x' })]);
  ok('message row: named from the agent\'s record, not the summary', r.job.agents[0].name === 'Build slides' && r.job.agents[0].msgs[0] === 'please also fix slide 4', JSON.stringify(r.job.agents[0]));
}

// 4. a background agent learns its id from Stop; its activity follows that id; control codes and Arabic stay safe
{
  const t = fresh();
  const calls = [launch('ترجمة \x1b]52;c;eA==\x07الملفات', 'general-purpose'),
    { hook_event_name: 'Stop', background_tasks: [{ id: 'c3', type: 'subagent', status: 'running', description: 'ترجمة \x1b]52;c;eA==\x07الملفات' }] },
    A('c3', 'general-purpose', pre('Edit', { file_path: '/x/ملف.md' })),
    A('c3', 'general-purpose', pre('Bash', { command: 'x', description: 'Check \x1b[2J the output' }))];
  const r = run(t, calls, { cols: [80] });
  const L = W(r, 80);
  const ctl = L.join('').split('').filter((c) => c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f));
  ok('background agent: activity shown under its row', L.some((l) => /now: Bash: Check .{0,6}the output · started \d+s ago/.test(l)) && L.some((l) => /before: Edit: .* · 2 tool calls/.test(l)), L.join('\n'));
  ok('no control codes, Arabic shaped, width kept', ctl.length === 0 && L.some((l) => /[ﹰ-﻿]/.test(l)) && L.every((l) => [...l].length <= 79), L.join('\n'));
}

// 5. finished agents show no activity lines
{
  const t = fresh();
  meta(t, 'd1', { agentType: 'general-purpose', description: 'Quick look' });
  const r = run(t, [launch('Quick look', 'general-purpose'), A('d1', 'general-purpose', pre('Read', { file_path: '/a/b' })),
    { hook_event_name: 'SubagentStop', agent_id: 'd1', agent_type: 'general-purpose', background_tasks: [] }], { cols: [120] });
  ok('finished agent: no "now:" line', !W(r, 120).some((l) => /now: Read/.test(l)), W(r, 120).join('\n'));
}


// 6. the model and effort line has its own colour (cyan), apart from the grey details
{
  const t = fresh();
  meta(t, 'm1', { agentType: 'tech-lead', description: 'Check the plan' });
  const r = run(t, [launch('Check the plan', 'tech-lead'), A('m1', 'tech-lead', pre('Read', { file_path: '/a/plan.md' }))], { cols: [120, 50] });
  for (const c of ['120', '50']) {
    const raw = (r.raw && r.raw[c]) || [];
    const line = raw.find((l) => /^ {7}\x1b\[96m/.test(l) && /medium effort/.test(l)) || '';
    ok(`model line at ${c} columns: model and effort in cyan`, /^ {7}\x1b\[96m[^\x1b]*medium effort/.test(line), JSON.stringify(raw));
    ok(`model line at ${c} columns: no line wider than the terminal`, (r.render[c] || []).every((l) => [...l].length <= Number(c) - 1), (r.render[c] || []).join('\n'));
  }
}

console.log(`--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
