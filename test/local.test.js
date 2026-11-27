// Your own additions in local/hook_local.py: loaded only when safe, never able to break the hook.
// Run: node test/local.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'python');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';

function fresh(code, fileMode = 0o600, dirMode = 0o700) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-local-'));
  // the hook runs from a copy in the data folder, like a real install
  for (const f of ['core.py', 'hook.py']) fs.copyFileSync(path.join(SRC, f), path.join(home, f));
  if (code !== undefined) {
    fs.mkdirSync(path.join(home, 'local'), { mode: dirMode });
    fs.chmodSync(path.join(home, 'local'), dirMode);
    fs.writeFileSync(path.join(home, 'local', 'hook_local.py'), code);
    fs.chmodSync(path.join(home, 'local', 'hook_local.py'), fileMode);
  }
  return { home, sid: 'sess-' + Math.random().toString(36).slice(2) };
}
const hook = (t, ev) => spawnSync(PY, ['-I', path.join(t.home, 'hook.py')],
  { input: JSON.stringify({ session_id: t.sid, ...ev }), encoding: 'utf8', env: { ...process.env, PROGRESS_HOME: t.home, CLAUDE_CONFIG_DIR: path.join(t.home, 'cfg') } });
const ctx = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput; } catch { return null; } };
const errors = (t) => { try { return fs.readFileSync(path.join(t.home, 'hook-errors.log'), 'utf8'); } catch { return ''; } };
const job = (t) => {
  const dir = path.join(t.home, 'jobs');
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))[0];
};
const pre = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/a.txt' } };

const GOOD = `
import core
def on_event(event, data, job):
    if event == 'UserPromptSubmit':
        return 'LOCAL: prompt seen'
    if event == 'SessionStart':
        return 'LOCAL: session'
    if event == 'PreToolUse':
        st = job.setdefault('local', {})
        st['calls'] = st.get('calls', 0) + 1
        if st['calls'] % 2 == 0:
            return 'LOCAL: every second call (%d) in %s' % (st['calls'], core.BASE)
`;

// 1. no file: the hook behaves as before
{
  const t = fresh();
  const r = hook(t, { hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  ok('missing file: no output, exit 0', r.status === 0 && r.stdout === '' && errors(t) === '', r.stdout + errors(t));
  const s = hook(t, { hook_event_name: 'SessionStart' });
  ok('missing file: SessionStart line unchanged', ctx(s) && ctx(s).hookEventName === 'SessionStart' && ctx(s).additionalContext.startsWith('Progress Terminal is on'));
}

// 2. a good file: its text reaches Claude, it can keep state on the task, the stock work still happens
{
  const t = fresh(GOOD);
  const u = hook(t, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' });
  ok('good file: UserPromptSubmit text passed on', ctx(u) && ctx(u).hookEventName === 'UserPromptSubmit' && ctx(u).additionalContext === 'LOCAL: prompt seen', u.stdout);
  const s = hook(t, { hook_event_name: 'SessionStart' });
  ok('good file: SessionStart is one output with both lines', ctx(s) && /^Progress Terminal is on/.test(ctx(s).additionalContext) && /LOCAL: session$/.test(ctx(s).additionalContext));
  const p1 = hook(t, pre);
  const p2 = hook(t, pre);
  ok('good file: PreToolUse gets the task and its state is saved', p1.stdout === '' && ctx(p2) && ctx(p2).hookEventName === 'PreToolUse' &&
    ctx(p2).additionalContext.includes('every second call (2)') && job(t).local.calls === 2, p2.stdout);
  ok('good file: the stock hook still works (task, title, actions)', job(t).actions === 2 && job(t).title === 'do the thing' && errors(t) === '');
}

// 3. unsafe permissions: never loaded, said in the error log, stock hook unaffected
{
  for (const [label, fm, dm] of [['file writable by others', 0o666, 0o700], ['file writable by the group', 0o620, 0o700], ['folder writable by others', 0o600, 0o777]]) {
    const t = fresh(GOOD, fm, dm);
    const r = hook(t, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    const p = hook(t, pre); hook(t, pre);
    ok(`unsafe (${label}): not loaded, logged, hook still works`, r.status === 0 && r.stdout === '' && p.stdout === '' &&
      /not loaded/.test(errors(t)) && job(t).actions === 2 && !job(t).local, r.stdout + errors(t));
  }
  const t = fresh(GOOD);
  fs.renameSync(path.join(t.home, 'local', 'hook_local.py'), path.join(t.home, 'local', 'real.py'));
  fs.symlinkSync(path.join(t.home, 'local', 'real.py'), path.join(t.home, 'local', 'hook_local.py'));
  const r = hook(t, { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  ok('unsafe (a link instead of a file): not loaded', r.stdout === '' && /not loaded/.test(errors(t)));
}

// 4. a file that raises, on load or in on_event: logged, never breaks the hook
{
  const t = fresh('raise RuntimeError("boom on load")\n');
  const r = hook(t, pre);
  ok('raises on load: exit 0, no output, logged, task still made', r.status === 0 && r.stdout === '' && /load failed.*boom on load/.test(errors(t)) && job(t).actions === 1, errors(t));
  const t2 = fresh('def on_event(event, data, job):\n    raise ValueError("boom in call")\n');
  const s = hook(t2, { hook_event_name: 'SessionStart' });
  ok('raises in on_event: stock SessionStart line still printed', ctx(s) && /^Progress Terminal is on/.test(ctx(s).additionalContext) && !/boom/.test(s.stdout));
  const p = hook(t2, pre);
  ok('raises in on_event: logged, task still saved', p.status === 0 && /on_event\(PreToolUse\) failed.*boom in call/.test(errors(t2)) && job(t2).actions === 1);
  const t3 = fresh('def on_event(event, data, job):\n    return 42\n');
  ok('returns something that is not text: ignored', hook(t3, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }).stdout === '');
}

console.log(`--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
