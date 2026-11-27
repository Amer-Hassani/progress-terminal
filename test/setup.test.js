// Set up / remove / uninstall against a throwaway HOME. Run: node test/setup.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const setup = require('../setup');

const SRC = path.join(__dirname, '..', 'python');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pt-home-'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

const ORIGINAL = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/python3 /somewhere/gate.py', timeout: 10 }] }],
    SubagentStart: [{ hooks: [{ type: 'command', command: '/usr/bin/python3 /somewhere/start.py' }] }],
  },
};
const RAW = JSON.stringify(ORIGINAL, null, 2) + '\n';

// 1. set up next to existing hooks
{
  const home = tmpHome(); const env = {};
  const p = setup.paths(env, home);
  fs.mkdirSync(p.config, { recursive: true }); fs.writeFileSync(p.settings, RAW);
  const r = setup.install({ srcDir: SRC, version: '0.1.0', env, home });
  const s = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
  ok('set up: reports a change and a backup', r.changed && r.backup && fs.readFileSync(r.backup, 'utf8') === RAW);
  ok('set up: existing hooks kept first and unchanged', JSON.stringify(s.hooks.PreToolUse[0]) === JSON.stringify(ORIGINAL.hooks.PreToolUse[0]) &&
    JSON.stringify(s.hooks.SubagentStart) === JSON.stringify(ORIGINAL.hooks.SubagentStart));
  ok('set up: other settings kept', s.model === 'opus' && s.permissions.allow[0] === 'Bash(ls:*)');
  ok('set up: our 6 hook groups added', setup.EVENTS.every(([ev]) => s.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes(setup.MARK)))));
  ok('set up: data folder 700, scripts 600, launcher 700', mode(p.data) === '700' && mode(path.join(p.data, 'hook.py')) === '600' && mode(path.join(p.data, 'progress')) === '700',
    `${mode(p.data)} ${mode(path.join(p.data, 'hook.py'))} ${mode(path.join(p.data, 'progress'))}`);
  const r2 = setup.install({ srcDir: SRC, version: '0.1.0', env, home });
  const s2 = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
  ok('set up twice: no duplicates', !r2.changed && s2.hooks.Stop.length === 1);
  ok('set up: PostToolUse only for Bash and Monitor', s2.hooks.PostToolUse.length === 1 && s2.hooks.PostToolUse[0].matcher === 'Bash|Monitor');
  const rm = setup.remove({ env, home });
  ok('remove: settings back to the exact original bytes', rm.changed && fs.readFileSync(p.settings, 'utf8') === RAW);
  ok('remove: data folder kept unless asked', fs.existsSync(p.data));
  const rm2 = setup.remove({ env, home });
  ok('remove twice: nothing to do', !rm2.changed);
}

// 1b. an older version connected without PostToolUse: set up adds only that, once, with a backup
{
  const home = tmpHome(); const env = {};
  const p = setup.paths(env, home);
  fs.mkdirSync(p.config, { recursive: true }); fs.writeFileSync(p.settings, RAW);
  setup.install({ srcDir: SRC, version: '0.1.7', env, home });
  const old = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
  delete old.hooks.PostToolUse;
  fs.writeFileSync(p.settings, JSON.stringify(old, null, 2) + '\n');
  const r = setup.install({ srcDir: SRC, version: '0.1.8', env, home });
  const s = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
  ok('upgrade: PostToolUse added, with a backup', r.changed && r.backup && s.hooks.PostToolUse.length === 1 && s.hooks.PostToolUse[0].matcher === 'Bash|Monitor');
  ok('upgrade: nothing else doubled', s.hooks.Stop.length === 1 && s.hooks.PreToolUse.length === 2 && s.hooks.SessionStart.length === 1);
  const r2 = setup.install({ srcDir: SRC, version: '0.1.8', env, home });
  ok('upgrade twice: no change', !r2.changed && JSON.parse(fs.readFileSync(p.settings, 'utf8')).hooks.PostToolUse.length === 1);
  setup.remove({ env, home });
  ok('upgrade then remove: settings back to the original bytes', fs.readFileSync(p.settings, 'utf8') === RAW);
}

// 1c. updates: your local/ folder is never touched; a changed script is saved to backups/ before it is replaced
{
  const home = tmpHome(); const env = {};
  const p = setup.paths(env, home);
  setup.install({ srcDir: SRC, version: '0.1.8', env, home });
  fs.mkdirSync(path.join(p.data, 'local'), { mode: 0o700 });
  const mine = 'def on_event(event, data, job):\n    return None\n';
  fs.writeFileSync(path.join(p.data, 'local', 'hook_local.py'), mine, { mode: 0o600 });
  const edited = fs.readFileSync(path.join(p.data, 'hook.py'), 'utf8') + '\n# edited by hand\n';
  fs.writeFileSync(path.join(p.data, 'hook.py'), edited);
  const r = setup.install({ srcDir: SRC, version: '0.1.9', env, home });
  ok('update: local/ file untouched', fs.readFileSync(path.join(p.data, 'local', 'hook_local.py'), 'utf8') === mine &&
    mode(path.join(p.data, 'local', 'hook_local.py')) === '600');
  ok('update: the edited hook.py saved to backups/ first, then replaced', r.saved && fs.readFileSync(path.join(r.saved, 'hook.py'), 'utf8') === edited &&
    fs.readFileSync(path.join(p.data, 'hook.py'), 'utf8') === fs.readFileSync(path.join(SRC, 'hook.py'), 'utf8'), JSON.stringify(r));
  ok('update: only changed scripts are saved, privately', fs.readdirSync(r.saved).join(',') === 'hook.py' && mode(r.saved) === '700' &&
    mode(path.join(r.saved, 'hook.py')) === '600');
  const r2 = setup.install({ srcDir: SRC, version: '0.1.9', env, home });
  ok('update with nothing changed: no backup folder', r2.saved === null && fs.readdirSync(path.join(p.data, 'backups')).length === 1);
  setup.remove({ env, home, deleteData: true });
  ok('uninstall: everything Set up made is gone, your local/ folder stays', fs.readdirSync(p.data).join(',') === 'local' &&
    fs.readFileSync(path.join(p.data, 'local', 'hook_local.py'), 'utf8') === mine);
}

// 2. broken settings.json is refused and left untouched
{
  const home = tmpHome(); const env = {};
  const p = setup.paths(env, home);
  fs.mkdirSync(p.config, { recursive: true }); fs.writeFileSync(p.settings, '{ "hooks": [oops');
  let msg = '';
  try { setup.install({ srcDir: SRC, env, home }); } catch (e) { msg = e.message; }
  ok('broken JSON: refused with a message', /left untouched/.test(msg));
  ok('broken JSON: file untouched, nothing copied', fs.readFileSync(p.settings, 'utf8') === '{ "hooks": [oops' && !fs.existsSync(p.data));
  let msg2 = '';
  try { setup.remove({ env, home }); } catch (e) { msg2 = e.message; }
  ok('broken JSON: remove refuses too', /left untouched/.test(msg2));
}

// 3. CLAUDE_CONFIG_DIR and a missing settings.json
{
  const home = tmpHome(); const cfg = path.join(home, 'elsewhere');
  const env = { CLAUDE_CONFIG_DIR: cfg };
  setup.install({ srcDir: SRC, env, home });
  ok('CLAUDE_CONFIG_DIR honoured', fs.existsSync(path.join(cfg, 'settings.json')) && fs.existsSync(path.join(cfg, 'progress-terminal', 'hook.py')) &&
    !fs.existsSync(path.join(home, '.claude')));
  setup.remove({ env, home });
  ok('no settings before: remove leaves an empty object', fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8') === '{}\n');
}

// 4. the guarded hook: works when present, silent no-op when the folder is gone
{
  const home = tmpHome(); const env = {};
  const p = setup.paths(env, home);
  setup.install({ srcDir: SRC, env, home });
  const cmd = setup.hookCommand(p.data);
  const start = spawnSync('/bin/sh', ['-c', cmd], { input: '{"hook_event_name":"SessionStart","session_id":"x"}', encoding: 'utf8' });
  ok('hook: SessionStart adds one line of context', start.status === 0 && JSON.parse(start.stdout).hookSpecificOutput.additionalContext.includes('progress'));
  const sid = '12345678-aaaa-bbbb-cccc-1234567890ab';
  spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: 'echo secret-thing', description: 'Say hello' } }), encoding: 'utf8' });
  const jobs = fs.readdirSync(path.join(p.data, 'jobs')).filter((n) => n.endsWith('.json'));
  const jf = path.join(p.data, 'jobs', jobs[0] || 'none');
  ok('hook: first tool call makes a job, 600, no command text', jobs.length === 1 && mode(jf) === '600' && !fs.readFileSync(jf, 'utf8').includes('secret-thing'));
  ok('hook: jobs folder 700', mode(path.join(p.data, 'jobs')) === '700');
  fs.rmSync(p.data, { recursive: true, force: true });
  const gone = spawnSync('/bin/sh', ['-c', cmd], { input: '{"hook_event_name":"PreToolUse","session_id":"x"}', encoding: 'utf8' });
  ok('hook: folder deleted → exit 0, no output', gone.status === 0 && gone.stdout === '' && gone.stderr === '');
}

// 5. uninstall script (plain node, HOME of its own)
{
  const home = tmpHome();
  const p = setup.paths({}, home);
  fs.mkdirSync(p.config, { recursive: true }); fs.writeFileSync(p.settings, RAW);
  setup.install({ srcDir: SRC, env: {}, home });
  execFileSync(process.execPath, [path.join(__dirname, '..', 'uninstall.js')], { env: { HOME: home, PATH: process.env.PATH } });
  ok('uninstall: settings restored and data folder deleted', fs.readFileSync(p.settings, 'utf8') === RAW && !fs.existsSync(p.data));
}

console.log(`--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
