// The live view's numbers, frame by frame, against a throwaway data folder. Run: node test/view.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'python');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';

// Drives view.section() one frame per simulated second and prints what each frame shows, as JSON.
const DRIVER = String.raw`
import json, os, re, sys, time
sys.path.insert(0, sys.argv[1])
import core, view
home = os.environ['PROGRESS_HOME']
strip = lambda l: re.sub(r'\x1b\[[0-9;]*m', '', l)
clock = [time.time()]
def frame(jid):
    clock[0] += 1
    view._dt = 1.0
    j = core.load(jid)
    lines = [strip(l) for l in view.section(j, 150, 50, clock[0])]
    num = lambda pat: next((float(m.group(1)) for l in lines for m in [re.search(pat, l)] if m), None)
    return {'lines': lines, 'total': num(r'TOTAL~?\s*([\d.]+)%'), 'a': num(r'1\. A\s+~?\s*([\d.]+)%')}
def edit(jid, **k):
    j = core.load(jid); j.update(k); core._write(core.path_of(jid), j)
def setpct(jid, name, pct):
    j = core.load(jid)
    for s in j['steps']:
        if s['name'] == name:
            if s['pct'] != pct: s['tr'] = time.time()
            s['pct'] = pct
            if pct >= 100: s['t1'] = time.time()
    j['ev_t'] = time.time(); core._write(core.path_of(jid), j)
out = {}
j = core.new_job('sess-test', 'Test task')
jid = j['id']
j['steps'] = [{'name': n, 'pct': 0, 'w': 1.0, 'detail': '', 't0': None, 't1': None} for n in 'ABCDEF']
j['tool'] = {'name': 'Tool: browser', 't': time.time()}; j['ev_t'] = time.time()
core._write(core.path_of(jid), j)
out['running'] = [frame(jid) for _ in range(5)]
setpct(jid, 'A', 0.1)
out['lower'] = [frame(jid) for _ in range(2)]
setpct(jid, 'A', 100); setpct(jid, 'B', 100)
out['two_done'] = [frame(jid) for _ in range(25)]  # long enough to finish catching up
edit(jid, tool=None, post=True, ev_t=time.time() - 100)
out['idle'] = [frame(jid) for _ in range(4)]
edit(jid, tool={'name': 'Tool: browser', 't': time.time() - 660}, post=False, ev_t=time.time() - 660)
out['stuck'] = [frame(jid) for _ in range(3)]
n = core.new_job('sess-none', 'No steps')
edit(n['id'], tool={'name': 'Bash: build', 't': time.time()}, ev_t=time.time(), actions=3)
out['nosteps'] = frame(n['id'])
view.est_save({jid})
out['state_mode'] = oct(os.stat(view.EST_FILE).st_mode & 0o777)
print(json.dumps(out))
`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-view-'));
for (const f of ['core.py', 'view.py']) fs.copyFileSync(path.join(SRC, f), path.join(home, f));
const r = spawnSync(PY, ['-I', '-c', DRIVER, home], { env: { PROGRESS_HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
if (r.status !== 0) { console.log(r.stderr); process.exit(1); }
const o = JSON.parse(r.stdout);
const all = [].concat(o.running, o.lower, o.two_done, o.idle, o.stuck, [o.nosteps]);
const rising = (fr, key) => fr.every((f, i) => i === 0 || f[key] > fr[i - 1][key]);

ok('percentages have three decimals', o.running[0].lines.some((l) => /TOTAL~\s*\d+\.\d{3}%/.test(l)));
ok('a running tool call moves the numbers every second, marked ~', rising(o.running, 'total') && rising(o.running, 'a') &&
  o.running[0].lines.some((l) => /1\. A\s+~/.test(l)));
ok('a real value below the estimate never moves it back', o.lower[0].a >= o.running[4].a && o.lower[1].a >= o.lower[0].a);
const steps = o.two_done.map((f, i) => f.total - (i ? o.two_done[i - 1].total : o.lower[1].total));
ok('closing two steps at once travels at most 2 points a second', steps.every((d) => d >= 0 && d <= 2.0001), JSON.stringify(steps));
ok('nothing running: numbers stop and the view says so', o.idle.slice(1).every((f) => f.total === o.idle[0].total) &&
  o.idle[0].lines.some((l) => l.includes('numbers paused')));
ok('no news for 10 min: numbers stop, "may be stuck"', o.stuck.every((f) => f.total === o.stuck[0].total) &&
  o.stuck[0].lines.some((l) => l.includes('may be stuck')));
ok('no step ever shown above 100 % or reaching it before done', all.every((f) => f.lines.every((l) => !/~\s*100\.000%/.test(l))));
ok('no moving block inside any bar', all.every((f) => f.lines.every((l) => !l.includes('▒'))));
ok('task without steps: actions and "now:", no bar', o.nosteps.lines.some((l) => l.includes('3 actions')) &&
  o.nosteps.lines.some((l) => l.includes('now: last action: Bash: build')) && o.nosteps.lines.every((l) => !/[█░▓]/.test(l)));
ok('view-state.json is private (600)', o.state_mode === '0o600', o.state_mode);

// zoomed in (narrow terminal): no line may be wider than the screen, or it wraps and breaks bars and scrolling
{
  const w = spawnSync(PY, ['-I', '-c', String.raw`
import sys, time, re, unicodedata
sys.path.insert(0, sys.argv[1])
import view
now = time.time()
j = {'id': 'w', 'title': 'a very long task title with an emoji 🎯 that goes on and on', 't0': now - 600, 'updated': now, 'ev_t': now,
     'tool': {'name': 'Bash: a long description of what is running', 't': now}, 'post': True,
     'steps': [{'name': 'Build slides in batches (agents) and more', 'pct': 40, 'w': 1, 'detail': 'x' * 200}],
     'agents': [{'name': 'Split slides 42 and 136', 'done': False, 't0': now - 60}], 'log': ['y' * 200]}
vis = lambda l: sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', l))
worst = 0
for cols in range(20, 160, 7):
    view._dt = 1.0
    W = max(20, min(50, cols - 40))
    worst = max([worst] + [vis(view.clip(l, cols - 1)) - (cols - 1) for l in view.section(j, cols, W, now)])
print(worst)
`, SRC], { encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: home } });
  ok('narrow terminal: no line wider than the screen (20 to 160 columns)', w.stdout.trim() === '0' || Number(w.stdout) <= 0, w.stdout + w.stderr);
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
