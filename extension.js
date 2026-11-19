// Progress Terminal for Claude Code
// Shows Claude Code's work live in one VS Code terminal called "Progress". It opens with show(true),
// so the keyboard focus stays where you are typing. The only thing this extension ever runs in a terminal
// is its own view.py.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const setup = require('./setup');

let seen = new Set();
let term = null;
let timers = [];
let watcher = null;
let dataDir = '';

const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

function python() {
  return PY.find((p) => fs.existsSync(p)) || setup.findPython() || 'python3';
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function viewRunning() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(dataDir, 'view.lock'), 'utf8'), 10);
    return pid > 0 && alive(pid);
  } catch { return false; }
}

function readJobs() {
  let names = [];
  try { names = fs.readdirSync(path.join(dataDir, 'jobs')); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', n), 'utf8'))); } catch { /* being written */ }
  }
  return out;
}

// Several VS Code windows: only one opens the view (a file created exclusively, valid for 5 s).
function claim() {
  const f = path.join(dataDir, 'opening.lock');
  try {
    if (Date.now() - fs.statSync(f).mtimeMs < 5000) return false;
    fs.unlinkSync(f);
  } catch { /* none yet */ }
  try { fs.writeFileSync(f, String(process.pid), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; }
}

function openView(force) {
  if (!fs.existsSync(path.join(dataDir, 'view.py'))) return;
  if (viewRunning()) { if (force && term) term.show(true); return; }
  if (!force && !claim()) return;
  term = vscode.window.createTerminal({
    name: 'Progress',
    shellPath: python(),
    shellArgs: ['-I', path.join(dataDir, 'view.py')],
    env: { PROGRESS_HOME: dataDir },
    isTransient: true,
    iconPath: new vscode.ThemeIcon('pulse'),
  });
  term.show(true); // preserveFocus: the panel shows, the cursor stays where it was
}

function scan(initial) {
  const jobs = readJobs();
  let fresh = false;
  for (const j of jobs) {
    if (!j || !j.id || seen.has(j.id)) continue;
    seen.add(j.id);
    if (!j.end) fresh = true;
  }
  if (!(fresh || (initial && jobs.some((j) => j && !j.end)))) return;
  if (vscode.window.state.focused) openView(false);
  else setTimeout(() => { if (!viewRunning()) openView(false); }, 1500);
}

function startWatching() {
  stopWatching();
  const jobs = path.join(dataDir, 'jobs');
  try { fs.mkdirSync(jobs, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  scan(true);
  try { watcher = fs.watch(jobs, () => setTimeout(() => scan(false), 150)); } catch { /* the timer still works */ }
  timers.push(setInterval(() => scan(false), 1000));
}

function stopWatching() {
  timers.forEach(clearInterval);
  timers = [];
  if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
}

async function doSetup(context, quiet) {
  try {
    const r = setup.install({ srcDir: path.join(context.extensionPath, 'python'), version: context.extension.packageJSON.version });
    startWatching();
    if (!quiet) {
      const extra = r.backup ? ` A copy of your old settings is saved as ${path.basename(r.backup)}.` : '';
      vscode.window.showInformationMessage(`Progress Terminal: ${r.message}${extra}`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Progress Terminal: ${e.message}`);
  }
}

function activate(context) {
  dataDir = setup.paths().data;
  const st = setup.status();

  context.subscriptions.push(
    vscode.commands.registerCommand('progressTerminal.setup', () => doSetup(context, false)),
    vscode.commands.registerCommand('progressTerminal.remove', async () => {
      const pick = await vscode.window.showWarningMessage(
        'Disconnect Progress Terminal from Claude Code? Your other Claude Code settings stay as they are.', { modal: true }, 'Disconnect');
      if (pick !== 'Disconnect') return;
      try {
        const r = setup.remove({ deleteData: false });
        stopWatching();
        vscode.window.showInformationMessage(`Progress Terminal: ${r.message}`);
      } catch (e) { vscode.window.showErrorMessage(`Progress Terminal: ${e.message}`); }
    }),
    vscode.commands.registerCommand('progressTerminal.show', () => openView(true)),
    vscode.window.onDidCloseTerminal((t) => { if (t === term) term = null; }),
    { dispose: stopWatching },
  );

  if (st.installed) {
    // keep the scripts in step with this version of the extension
    const v = (() => { try { return fs.readFileSync(path.join(dataDir, 'VERSION'), 'utf8'); } catch { return ''; } })();
    if (v !== context.extension.packageJSON.version) doSetup(context, true); else startWatching();
    return;
  }
  if (process.platform === 'win32' || !fs.existsSync(setup.paths().config)) return; // no Claude Code here
  const key = `declined-${context.extension.packageJSON.version}`;
  if (context.globalState.get(key)) return;
  vscode.window.showInformationMessage(
    'Show what Claude Code is doing, live, in a "Progress" terminal? This adds hooks to your Claude Code settings (a backup is kept).',
    'Set up', 'Not now').then((pick) => {
    if (pick === 'Set up') doSetup(context, false);
    else if (pick === 'Not now') context.globalState.update(key, true);
  });
}

function deactivate() { stopWatching(); }

module.exports = { activate, deactivate };
