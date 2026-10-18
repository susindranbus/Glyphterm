// `npm start`: launch Electron with ELECTRON_RUN_AS_NODE cleared (VS Code terminals set it).
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron'); // resolves to the electron.exe path when run under Node
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false })
  .on('exit', (code) => process.exit(code ?? 0));
