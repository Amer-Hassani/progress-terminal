// Runs once after the extension is uninstalled (VS Code's vscode:uninstall hook, plain Node, no VS Code API).
// Takes Progress Terminal's hooks out of Claude Code's settings and deletes its data folder.
'use strict';
try {
  const r = require('./setup').remove({ deleteData: true });
  console.log(r.message);
} catch (e) {
  console.error(`Progress Terminal: ${e.message}`);
}
