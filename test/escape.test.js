// Text from commands, watches, prompts and task names never reaches the terminal as a control code.
// Only the view's own colour codes may. Run: node test/escape.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'python');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';

// Each field below gets every kind of control sequence: clipboard write (OSC 52), link (OSC 8), window title,
// clear screen (CSI 2J), bell, and the one-byte C1 form of CSI.
const BAD = {
  osc52: '\x1b]52;c;aGVsbG8=\x07',
  osc8: '\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\',
  title: '\x1b]0;new title\x07',
  clear: '\x1b[2J\x1b[H',
  bell: '\x07',
  c1: '\x9b2J\x9d0;t\x9c',
};
const ALL = Object.values(BAD).join('');

const DRIVER = String.raw`
import json, os, sys, time
sys.path.insert(0, sys.argv[1])
import core, view
bad = json.loads(sys.argv[2])
now = time.time()
def job(ended):
    j = {'id': 'x' + str(ended), 'sid': 's', 'title': 'Title ' + bad, 't0': now - 100, 'end': (now - 5) if ended else None,
         'waiting': False, 'actions': 3, 'pids': [],
         'steps': [{'name': 'Step ' + bad, 'pct': 40, 'w': 1, 'detail': 'detail ' + bad, 't0': now - 50, 't1': None},
                   {'name': 'Done ' + bad, 'pct': 100, 'w': 1, 'detail': '', 't0': now - 90, 't1': now - 60}],
         'agents': [{'name': 'Agent ' + bad, 'done': False, 't0': now - 40, 'type': 'type ' + bad, 'model': 'Model ' + bad,
                     'effort': 'effort ' + bad, 'tasks': [{'name': 'task ' + bad, 'done': False}], 'msgs': ['msg ' + bad]},
                    {'name': 'Old ' + bad, 'done': True, 't0': now - 90, 't1': now - 80, 'stopped': True, 'model': 'M', 'effort': 'e'},
                    {'name': 'Old2 ' + bad, 'done': True, 't0': now - 90, 't1': now - 80}],
         'bg': [{'kind': 'watch', 'name': 'Watch ' + bad, 't0': now - 30, 'timeout': 60000, 'last': 'last ' + bad,
                 'agent': 'a', 'agent_type': 'agenttype ' + bad},
                {'kind': 'command', 'name': 'Cmd ' + bad, 't0': now - 30, 't1': now - 10, 'state': 'failed', 'code': 1},
                {'kind': 'command', 'name': 'Cmd2 ' + bad, 't0': now - 30, 't1': now - 10, 'state': 'done', 'code': 0}],
         'tool': {'name': 'Tool ' + bad, 't': now - 2}, 'ev_t': now - 2, 'post': True,
         'log': ['12:00:00 log ' + bad], 'end_msg': 'end ' + bad}
    return j
out = {}
for show_all in (False, True):
    view.show_all = show_all
    for ended in (False, True):
        lines = view.section(job(ended), 300, 50, now)
        out['%s-%s' % (str(show_all).lower(), str(ended).lower())] = {'raw': lines, 'screen': [view.visual(view.clip(l, 299)) for l in lines]}
# the last guard on its own: clip lets only colour codes through, whatever a line holds
out['clip'] = view.clip('a' + bad + view.G + 'b' + view.R0 + 'بحث', 299)
out['short'] = core.short('x' + bad + 'y', 200)
print(json.dumps(out))
`;

const SGR = /\x1b\[[0-9;]*m/g;
const controls = (s) => [...s.replace(SGR, '')].filter((c) => { const n = c.codePointAt(0); return n < 0x20 || (n >= 0x7f && n <= 0x9f); });

for (const [kind, seq] of Object.entries(BAD).concat([['all at once', ALL]])) {
  const r = spawnSync(PY, ['-I', '-c', DRIVER, SRC, JSON.stringify(seq)], { encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pt-esc-')) } });
  let v = null;
  try { v = JSON.parse(r.stdout); } catch { console.log(r.stderr); }
  if (!v) { ok(`${kind}: driver ran`, false); continue; }
  for (const k of ['false-false', 'false-true', 'true-false', 'true-true']) {
    const { raw, screen } = v[k];
    const bad = [...raw, ...screen].flatMap(controls);
    ok(`${kind} (${k.startsWith('true') ? 'all listed' : 'folded'}, ${k.endsWith('true') ? 'finished' : 'running'} task): no control code on screen`,
      bad.length === 0, JSON.stringify(bad.map((c) => c.codePointAt(0).toString(16))));
  }
  const live = v['true-false'].screen.join('\n');
  ok(`${kind}: every field still shown (title, step, detail, agent, model, task, watch, latest line, log, now-line)`,
    ['Title', 'Step', 'detail', 'Agent', 'Model', 'task', 'Watch', 'last', 'log', 'Tool', 'Cmd', 'agenttype'].every((w) => live.includes(w)), ['Title', 'Step', 'detail', 'Agent', 'Model', 'task', 'Watch', 'last', 'log', 'Tool', 'Cmd', 'agenttype'].filter((w) => !live.includes(w)).join(','));
  ok(`${kind}: finished task shows its end message cleanly`, v['true-true'].screen.join('\n').includes('end '));
  ok(`${kind}: clip passes colour codes only`, controls(v.clip).length === 0 && v.clip.includes('\x1b[92m') && v.clip.includes('\x1b[0m'), JSON.stringify(v.clip));
  ok(`${kind}: core.short stores no control code`, controls(v.short).length === 0 && v.short.startsWith('x') && v.short.endsWith('y'), JSON.stringify(v.short));
}

// what the hooks store: a description with control codes is saved without them
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-esc-'));
  const hook = (ev) => spawnSync(PY, ['-I', path.join(SRC, 'hook.py')], { input: JSON.stringify({ session_id: 'sess-esc', ...ev }), encoding: 'utf8',
    env: { ...process.env, PROGRESS_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'cfg') } });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Prompt ' + ALL });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'x', description: 'Desc ' + ALL, run_in_background: true } });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Agent ' + ALL } });
  const files = ['jobs', 'sessions'].flatMap((d) => fs.readdirSync(path.join(home, d)).filter((n) => n.endsWith('.json')).map((n) => path.join(home, d, n)));
  const stored = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const text = JSON.stringify(stored);
  const strings = []; const walk = (o) => { if (typeof o === 'string') strings.push(o); else if (o && typeof o === 'object') Object.values(o).forEach(walk); }; walk(stored);
  ok('hooks: title, log line, background row and agent row stored without control codes', strings.flatMap(controls).length === 0 &&
    text.includes('Prompt') && text.includes('Desc') && text.includes('Agent'), JSON.stringify(strings.flatMap(controls)));
}

console.log(`--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
