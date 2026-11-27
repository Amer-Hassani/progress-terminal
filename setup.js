// Connects Progress Terminal to Claude Code and disconnects it again.
// Plain Node (no VS Code import), so it is testable on a temporary HOME and usable from the uninstall script.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const EVENTS = [['SessionStart', null], ['UserPromptSubmit', null], ['PreToolUse', '.*'], ['PostToolUse', 'Bash|Monitor'],
  ['SubagentStop', null], ['Stop', null]];
const MARK = 'progress-terminal/hook.py';
const PY_FILES = ['core.py', 'hook.py', 'progress.py', 'view.py', 'progress'];
const PYTHONS = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

function paths(env = process.env, home = os.homedir()) {
  const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return { config, data: path.join(config, 'progress-terminal'), settings: path.join(config, 'settings.json') };
}

function findPython(env = process.env) {
  for (const p of PYTHONS) if (fs.existsSync(p)) return p;
  for (const dir of (env.PATH || '').split(':')) {
    const p = path.join(dir, 'python3');
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Guarded: if the folder is gone (extension removed without "Remove"), the hook quietly does nothing.
function hookCommand(data) {
  const f = path.join(data, 'hook.py');
  return `F=${shq(f)}; [ -f "$F" ] || exit 0; for P in ${PYTHONS.join(' ')}; do [ -x "$P" ] && exec "$P" -I "$F"; done; ` +
    `P=$(command -v python3) && exec "$P" -I "$F"; exit 0`;
}

const ours = (h) => typeof h.command === 'string' && h.command.includes(MARK);

function readSettings(file) {
  if (!fs.existsSync(file)) return { exists: false, raw: '', obj: {} };
  const raw = fs.readFileSync(file, 'utf8');
  let obj;
  try { obj = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
    throw new Error(`Claude Code's settings file can't be read as JSON, so it was left untouched: ${file}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`Claude Code's settings file isn't a JSON object, so it was left untouched: ${file}`);
  }
  return { exists: true, raw, obj };
}

function writeSettings(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  JSON.parse(text);
  const tmp = `${file}.tmp-progress-terminal`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function isInstalled(obj) {
  const h = obj.hooks || {};
  return Object.values(h).some((groups) => Array.isArray(groups) &&
    groups.some((g) => Array.isArray(g.hooks) && g.hooks.some(ours)));
}

function status(opts = {}) {
  const p = paths(opts.env, opts.home);
  let installed = false;
  try { installed = isInstalled(readSettings(p.settings).obj); } catch { /* unreadable */ }
  return { installed, dataExists: fs.existsSync(path.join(p.data, 'hook.py')), ...p };
}

function copyFiles(srcDir, data) {
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.chmodSync(data, 0o700);
  for (const f of PY_FILES) {
    const to = path.join(data, f);
    fs.copyFileSync(path.join(srcDir, f), to);
    fs.chmodSync(to, f === 'progress' ? 0o700 : 0o600);
  }
}

// Set up: copy the scripts, back up settings.json, add our hook groups. Returns a short message.
function install(opts) {
  const { srcDir, version = '' } = opts;
  if (process.platform === 'win32') throw new Error('Progress Terminal needs macOS or Linux. Windows is not supported.');
  if (!findPython(opts.env)) throw new Error('Progress Terminal needs Python 3. Install it, then run "Progress Terminal: Set up Claude Code" again.');
  const p = paths(opts.env, opts.home);
  const s = readSettings(p.settings);            // throws (and touches nothing) if unreadable
  copyFiles(srcDir, p.data);
  fs.writeFileSync(path.join(p.data, 'VERSION'), version, { mode: 0o600 });
  const upgrade = isInstalled(s.obj);
  // an earlier version is connected: add only the hook events it did not have yet (0.1.8: PostToolUse)
  const missing = EVENTS.filter(([ev]) => !(Array.isArray((s.obj.hooks || {})[ev]) &&
    s.obj.hooks[ev].some((g) => Array.isArray(g.hooks) && g.hooks.some(ours))));
  if (upgrade && !missing.length) return { changed: false, backup: null, message: 'Already connected to Claude Code. Scripts updated.' };
  let backup = null;
  if (s.exists) {
    backup = `${p.settings}.backup-progress-terminal-${Date.now()}`;
    fs.writeFileSync(backup, s.raw, { mode: 0o600 });
  }
  const obj = s.obj;
  obj.hooks = obj.hooks || {};
  const entry = { type: 'command', command: hookCommand(p.data), timeout: 5 };
  for (const [ev, matcher] of missing) {
    obj.hooks[ev] = Array.isArray(obj.hooks[ev]) ? obj.hooks[ev] : [];
    obj.hooks[ev].push(matcher ? { matcher, hooks: [{ ...entry }] } : { hooks: [{ ...entry }] });
  }
  writeSettings(p.settings, obj);
  if (upgrade) return { changed: true, backup, message: 'Already connected to Claude Code. Scripts updated, and background jobs are now shown.' };
  return { changed: true, backup, message: 'Connected. New Claude Code sessions will show their progress here.' };
}

// Remove: take out only our hook entries; optionally delete the data folder.
function remove(opts = {}) {
  const p = paths(opts.env, opts.home);
  let changed = false;
  if (fs.existsSync(p.settings)) {
    const s = readSettings(p.settings);
    const h = s.obj.hooks;
    if (h && typeof h === 'object' && isInstalled(s.obj)) {
      for (const ev of Object.keys(h)) {
        if (!Array.isArray(h[ev])) continue;
        const kept = [];
        for (const g of h[ev]) {
          if (!Array.isArray(g.hooks) || !g.hooks.some(ours)) { kept.push(g); continue; }
          const rest = g.hooks.filter((x) => !ours(x));
          if (rest.length) kept.push({ ...g, hooks: rest });
        }
        if (kept.length) h[ev] = kept; else delete h[ev];
      }
      if (!Object.keys(h).length) delete s.obj.hooks;
      writeSettings(p.settings, s.obj);
      changed = true;
    }
  }
  if (opts.deleteData && fs.existsSync(p.data)) fs.rmSync(p.data, { recursive: true, force: true });
  return { changed, message: changed ? 'Disconnected from Claude Code.' : 'It was not connected to Claude Code.' };
}

module.exports = { paths, status, install, remove, hookCommand, findPython, EVENTS, MARK };
