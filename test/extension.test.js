// The extension against a stand-in `vscode` module on a throwaway HOME. Run: node test/extension.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ext-'));
process.env.HOME = home;
os.homedir = () => home;
const terminals = [], infos = [], state = new Map();
let answer = 'Set up';
const fake = {
  window: {
    state: { focused: true },
    terminals,
    createTerminal(o) { const t = { opts: o, shown: [], show(p) { this.shown.push(p); }, dispose() {} }; terminals.push(t); return t; },
    showInformationMessage(msg, ...items) { infos.push(msg); return Promise.resolve(items.length ? answer : undefined); },
    showErrorMessage(msg) { infos.push('ERROR ' + msg); return Promise.resolve(); },
    showWarningMessage() { return Promise.resolve('Disconnect'); },
    onDidCloseTerminal() { return { dispose() {} }; },
  },
  commands: { registerCommand(id, fn) { fake.commands[id] = fn; return { dispose() {} }; } },
  ThemeIcon: function ThemeIcon(id) { this.id = id; },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? fake : origLoad.call(this, req, ...rest); };

(async () => {
  const root = path.join(__dirname, '..');
  const ext = require('../extension');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{}\n');
  const ctx = { extensionPath: root, extension: { packageJSON: require('../package.json') }, subscriptions: [],
    globalState: { get: (k) => state.get(k), update: (k, v) => state.set(k, v) } };

  ext.activate(ctx);
  await sleep(300);
  ok('first start: asks once, then sets up on "Set up"', infos[0].startsWith('Show what Claude Code is doing') &&
    fs.readFileSync(settings, 'utf8').includes('progress-terminal/hook.py'));

  const data = path.join(home, '.claude', 'progress-terminal');
  const job = (id, end = null) => fs.writeFileSync(path.join(data, 'jobs', id + '.json'), JSON.stringify({ id, title: id, t0: Date.now() / 1000, end }));
  job('a');
  await sleep(1300);
  ok('new job: opens exactly one Progress terminal', terminals.length === 1 && terminals[0].opts.name === 'Progress');
  ok('it never takes focus: show(true)', terminals[0].shown.length === 1 && terminals[0].shown[0] === true);
  ok('it only ever runs view.py', terminals[0].opts.shellArgs.slice(-1)[0].endsWith(path.join('progress-terminal', 'view.py')) &&
    terminals[0].opts.env.PROGRESS_HOME === data);

  fs.writeFileSync(path.join(data, 'view.lock'), String(process.pid)); // the view is running
  job('b');
  await sleep(1300);
  ok('second job while the view runs: no second terminal', terminals.length === 1);

  fs.unlinkSync(path.join(data, 'view.lock'));                        // the user closed the view
  fs.unlinkSync(path.join(data, 'opening.lock'));
  await sleep(1300);
  ok('closed by the user: stays closed while no new job comes', terminals.length === 1);
  job('c');
  await sleep(1300);
  ok('next new job: opens it again, once', terminals.length === 2);

  fs.mkdirSync(path.join(data, '..', 'progress-terminal', 'requests'), { recursive: true });
  fs.writeFileSync(path.join(data, 'requests', 'x.json'), JSON.stringify({ kind: 'cmd', cmd: 'touch ' + path.join(home, 'PWNED') }));
  await sleep(1300);
  ok('a dropped request file never runs anything', !fs.existsSync(path.join(home, 'PWNED')) && terminals.length === 2);

  const src = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  ok('extension.js has exactly one createTerminal call', (src.match(/createTerminal\(/g) || []).length === 1);

  await fake.commands['progressTerminal.remove']();
  ok('Remove command: hooks taken out', !fs.readFileSync(settings, 'utf8').includes('progress-terminal/hook.py'));
  ext.deactivate();

  // "Not now" is remembered for this version
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ext2-'));
  process.env.HOME = home2; os.homedir = () => home2;
  fs.mkdirSync(path.join(home2, '.claude'), { recursive: true });
  delete require.cache[require.resolve('../extension')]; delete require.cache[require.resolve('../setup')];
  const ext2 = require('../extension');
  answer = 'Not now'; infos.length = 0; state.clear();
  ext2.activate(ctx); await sleep(200);
  infos.length = 0; ext2.activate(ctx); await sleep(200);
  ok('"Not now" is remembered: no second question', infos.length === 0 && state.get('declined-' + require('../package.json').version) === true);
  ext2.deactivate();

  console.log(`--- ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
