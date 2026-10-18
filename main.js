// Glyphterm main process: windows, PTY sessions (ConPTY), settings.
const { app, BrowserWindow, ipcMain, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const pty = require('@lydell/node-pty');
const { EventEmitter } = require('events');

// One-time import of settings/history saved under the earlier working name ("UniTerm").
(function importOldData() {
  try {
    const dest = app.getPath('userData');
    if (dest.toLowerCase() !== path.join(app.getPath('appData'), app.getName()).toLowerCase()) return; // overridden (tests)
    const old = path.join(app.getPath('appData'), 'UniTerm');
    if (!fs.existsSync(old) || fs.existsSync(path.join(dest, 'settings.json'))) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ['settings.json', 'commands.json']) {
      if (fs.existsSync(path.join(old, f))) fs.copyFileSync(path.join(old, f), path.join(dest, f));
    }
  } catch {}
})();

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
// Latin first (fixed width), then one font per script family. Chromium also falls back to any other installed font on its own.
const OLD_DEFAULT_FONT = '"Cascadia Mono", "Cascadia Code", Consolas, "Nirmala UI", "Latha", monospace';
const DEFAULT_FONT = '"Cascadia Mono", "Cascadia Code", Consolas, "Nirmala UI", "Latha", "Leelawadee UI", "Myanmar Text", "Khmer UI", "Lao UI", "Microsoft YaHei UI", "Yu Gothic UI", "Malgun Gothic", "Segoe UI Emoji", "Segoe UI Symbol", monospace';
const DEFAULT_SETTINGS = {
  fontFamily: DEFAULT_FONT,
  letterSpacing: 0, // extra pixels added to every character cell; 2-4 gives Tamil/Indic more room (see Ctrl+Shift+P → "Character spacing")
  fontSize: 15,
  lineHeight: 1.25,
  defaultProfile: 'powershell',
  copyOnSelect: false,
  scrollback: 10000,
  theme: 'dark',
  // Extra shells: [{ "name": "My Tool", "commandline": "C:\path\tool.exe --flag", "startingDirectory": "%USERPROFILE%" }]
  profiles: [],
  inputBar: false,
};

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (saved.fontFamily === OLD_DEFAULT_FONT) delete saved.fontFamily; // saved from an old default: take the new one
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

let settings = loadSettings();

// ---------- shell profiles ----------
function which(exe) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

const expandEnv = (s) => s.replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m);

// Split a Windows command line into [file, rest-of-args-string] (args passed verbatim to ConPTY).
function splitCommandLine(cmdline) {
  const s = expandEnv(cmdline.trim());
  const m = s.startsWith('"') ? /^"([^"]+)"\s*(.*)$/s.exec(s) : /^(\S+)\s*(.*)$/s.exec(s);
  if (!m) return null;
  let file = m[1];
  if (!path.isAbsolute(file)) file = which(file) || which(file + '.exe') || file;
  return { file, args: m[2] };
}

function windowsTerminalProfiles() {
  const pkgs = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  const candidates = [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows Terminal', 'settings.json')];
  try {
    for (const d of fs.readdirSync(pkgs)) if (d.startsWith('Microsoft.WindowsTerminal')) candidates.push(path.join(pkgs, d, 'LocalState', 'settings.json'));
  } catch {}
  const out = [];
  for (const f of candidates) {
    try {
      const json = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
      const list = Array.isArray(json.profiles) ? json.profiles : json.profiles?.list || [];
      for (const p of list) if (p.commandline && !p.hidden) out.push(p);
    } catch {}
  }
  return out;
}

function visualStudioInstances() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return [];
  try {
    const json = execFileSync(vswhere, ['-all', '-prerelease', '-format', 'json', '-utf8'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(json);
  } catch { return []; }
}

function wslDistros() {
  try {
    const raw = execFileSync('wsl.exe', ['-l', '-q'], { timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return raw.toString('utf16le').split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()).filter(Boolean);
  } catch { return []; }
}

function detectProfiles() {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const profiles = [];
  const seen = new Set();
  const add = (p) => {
    const key = p.name.toLowerCase();
    if (seen.has(key) || (p.file && path.isAbsolute(p.file) && !fs.existsSync(p.file))) return;
    seen.add(key);
    profiles.push(p);
  };
  const utf8Ps = '[Console]::InputEncoding=[Console]::OutputEncoding=$OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' +
    "@('Get-Content','Select-String','Import-Csv') | ForEach-Object { $PSDefaultParameterValues[$_ + ':Encoding'] = 'utf8' }";
  const winPs = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = path.join(sys, 'System32', 'cmd.exe');

  add({ id: 'powershell', name: 'Windows PowerShell', file: winPs, args: ['-NoLogo', '-NoExit', '-Command', utf8Ps] });
  add({ id: 'cmd', name: 'Command Prompt', file: cmd, args: ['/K', 'chcp 65001 >nul'] });
  const pwsh = which('pwsh.exe') || ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find((p) => fs.existsSync(p));
  if (pwsh) add({ id: 'pwsh', name: 'PowerShell 7', file: pwsh, args: ['-NoLogo', '-NoExit', '-Command', utf8Ps] });

  // Visual Studio developer shells — same command lines Windows Terminal generates.
  for (const vs of visualStudioInstances()) {
    const major = (vs.installationVersion || '').split('.')[0];
    const tools = path.join(vs.installationPath, 'Common7', 'Tools');
    const devCmd = path.join(tools, 'VsDevCmd.bat');
    const devDll = path.join(tools, 'Microsoft.VisualStudio.DevShell.dll');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    if (fs.existsSync(devCmd)) add({
      id: `vscmd-${vs.instanceId}`, name: `Developer Command Prompt for VS ${major}`, file: cmd, icon: cmd,
      args: `/k "chcp 65001 >nul && "${devCmd}" -startdir=none -arch=${arch} -host_arch=${arch}"`,
    });
    if (fs.existsSync(devDll)) add({
      id: `vsps-${vs.instanceId}`, name: `Developer PowerShell for VS ${major}`, file: winPs, icon: winPs,
      args: `-NoExit -Command "&{${utf8Ps}; Import-Module """${devDll}"""; Enter-VsDevShell ${vs.instanceId} -SkipAutomaticLocation -DevCmdArguments """-arch=${arch} -host_arch=${arch}"""}"`,
    });
  }

  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p));
  if (gitBash) add({
    id: 'gitbash', name: 'Git Bash', file: gitBash, args: ['--login', '-i'],
    icon: [path.join(path.dirname(gitBash), '..', 'git-bash.exe')].find((p) => fs.existsSync(p)) || gitBash,
  });

  const wsl = path.join(sys, 'System32', 'wsl.exe');
  for (const d of wslDistros()) add({ id: `wsl-${d}`, name: d, file: wsl, args: ['-d', d, '--cd', '~'], icon: wsl });

  // Any other (non-generated) profiles from Windows Terminal's settings.json.
  for (const p of windowsTerminalProfiles()) {
    const c = splitCommandLine(p.commandline);
    if (!c) continue;
    add({ id: `wt-${p.guid || p.name}`, name: p.name, file: c.file, args: c.args, cwd: p.startingDirectory && expandEnv(p.startingDirectory) });
  }

  const py = which('py.exe') || which('python.exe');
  if (py && !/WindowsApps/i.test(py)) add({ id: 'python', name: 'Python', file: py, args: [], group: 'tools' });
  const node = which('node.exe');
  if (node) add({ id: 'node', name: 'Node.js', file: node, args: [], group: 'tools' });

  // User-defined profiles in Glyphterm's settings.json: { "name", "commandline", "startingDirectory" }
  for (const p of settings.profiles || []) {
    const c = p.commandline && splitCommandLine(p.commandline);
    if (c) add({ id: `user-${p.name}`, name: p.name, file: c.file, args: c.args, cwd: p.startingDirectory && expandEnv(p.startingDirectory) });
  }

  return profiles;
}

async function profileIcon(p) {
  try {
    const img = await app.getFileIcon(p.icon || p.file, { size: 'small' });
    return img.isEmpty() ? null : img.toDataURL();
  } catch { return null; }
}

const profiles = detectProfiles();

// ---------- PTY sessions ----------
// Extension hook for the optional Pro package: 'data' (id, chunk), 'exit' (id, code), 'sessions' (list changed).
const bus = new EventEmitter();
// id -> { proc, webContents (desktop owner, or null when a plugin created it), buf, timer, replay, title, profile, cols, rows }
const sessions = new Map();
let nextId = 1;
const REPLAY_LIMIT = 512 * 1024;

function flush(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.timer = null;
  if (!s.buf) return;
  if (s.webContents && !s.webContents.isDestroyed()) s.webContents.send('pty:data', id, s.buf);
  bus.emit('data', id, s.buf);
  s.buf = '';
}

function spawnPty(webContents, { profileId, cols, rows, cwd }) {
  const profile = profiles.find((p) => p.id === profileId) || profiles.find((p) => p.id === settings.defaultProfile) || profiles[0];
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Glyphterm', LANG: process.env.LANG || 'en_US.UTF-8' };
  const opts = {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd: [cwd, profile.cwd].find((d) => d && fs.existsSync(d)) || os.homedir(),
    env,
    useConpty: true,
    useConptyDll: true, // bundled modern ConPTY: far better redraw + Unicode than the in-box conhost
  };
  let proc;
  try {
    proc = pty.spawn(profile.file, profile.args, opts);
  } catch (e) {
    proc = pty.spawn(profile.file, profile.args, { ...opts, useConptyDll: false });
  }

  const id = nextId++;
  const s = { proc, webContents, buf: '', timer: null, replay: '', title: '', profile, cols: opts.cols, rows: opts.rows };
  sessions.set(id, s);

  // Coalesce output into ~1 frame batches: fewer IPC hops, no partial-frame tearing in TUIs.
  proc.onData((data) => {
    s.buf += data;
    s.replay += data;
    if (s.replay.length > REPLAY_LIMIT) s.replay = s.replay.slice(-REPLAY_LIMIT * 0.75);
    if (s.buf.length > 256 * 1024) flush(id);
    else if (!s.timer) s.timer = setTimeout(() => flush(id), 8);
  });
  proc.onExit(({ exitCode }) => {
    flush(id);
    sessions.delete(id);
    if (webContents && !webContents.isDestroyed()) webContents.send('pty:exit', id, exitCode);
    bus.emit('exit', id, exitCode);
    bus.emit('sessions');
  });

  bus.emit('sessions');
  return { id, profile: { id: profile.id, name: profile.name } };
}

function resizeSession(id, cols, rows) {
  const s = sessions.get(id);
  if (!s || !(cols > 0 && rows > 0)) return;
  s.cols = cols;
  s.rows = rows;
  try { s.proc.resize(cols, rows); } catch {}
}

function killSession(id) {
  const s = sessions.get(id);
  if (s) { try { s.proc.kill(); } catch {} sessions.delete(id); bus.emit('sessions'); }
}

function killSessionsFor(webContents) {
  for (const [id, s] of sessions) if (s.webContents === webContents) killSession(id);
}

// ---------- command history + saved command sets ----------
const store = require('./store')(path.join(app.getPath('userData'), 'commands.json'));
store.onChange(() => {
  const snap = store.snapshot();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('commands:changed', snap);
});

// ---------- optional Pro plugin ----------
// The core is complete on its own. If a "Pro" package is found (see findPlugin), it is given this host API at startup
// and can add main-process features, IPC handlers and UI (menu items, palette commands, dialogs) to every window.
const plugin = { name: null, dir: null, scripts: [], css: [], error: null };
const host = {
  apiVersion: 1,
  app, shell, clipboard, bus, sessions, store,
  rootDir: __dirname,
  getSettings: () => settings,
  saveSettings: (patch) => { settings = { ...settings, ...patch }; saveSettings(settings); return settings; },
  getProfiles: () => profiles.map(({ id, name, group }) => ({ id, name, group: group || 'shells' })),
  spawn: (opts) => spawnPty(null, opts || {}),
  resize: resizeSession,
  kill: killSession,
  handle: (channel, fn) => ipcMain.handle('ext:' + channel, (_e, ...args) => fn(...args)),
  on: (channel, fn) => ipcMain.on('ext:' + channel, (_e, ...args) => fn(...args)),
  addRendererScript: (file) => plugin.scripts.push(file),
  addRendererCss: (file) => plugin.css.push(file),
};

function findPlugin() {
  if (process.env.GLYPHTERM_NO_PRO) return null;
  const candidates = [process.env.GLYPHTERM_PRO, settings.proPath];
  // Packaged builds ship it in resources/pro; in development the two repos sit side by side.
  candidates.push(app.isPackaged ? path.join(process.resourcesPath, 'pro') : path.join(__dirname, '..', 'Glyphterm-Pro'));
  return candidates.filter(Boolean).find((dir) => fs.existsSync(path.join(dir, 'index.js'))) || null;
}

function loadPlugin() {
  const dir = findPlugin();
  if (!dir) return;
  try {
    const mod = require(path.join(dir, 'index.js'));
    plugin.dir = dir;
    plugin.name = mod.name || path.basename(dir);
    mod.activate(host);
  } catch (e) {
    plugin.error = e && e.message ? e.message : String(e);
    console.error('Glyphterm Pro failed to load:', e);
  }
}

function injectPlugin(wc) {
  for (const file of plugin.css) {
    try { wc.insertCSS(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(e); }
  }
  for (const file of plugin.scripts) {
    try { wc.executeJavaScript(fs.readFileSync(file, 'utf8')).catch((e) => console.error('Pro script error:', e)); } catch (e) { console.error(e); }
  }
}

ipcMain.handle('pty:create', (e, opts) => spawnPty(e.sender, opts || {}));
ipcMain.on('pty:write', (_e, id, data) => sessions.get(id)?.proc.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => resizeSession(id, cols, rows));
ipcMain.on('pty:kill', (_e, id) => killSession(id));
ipcMain.on('pty:title', (_e, id, title) => {
  const s = sessions.get(id);
  if (s && s.title !== title) { s.title = title; bus.emit('sessions'); }
});
ipcMain.handle('commands:get', () => store.snapshot());
ipcMain.on('history:add', (_e, entry) => store.addHistory(entry || {}));
ipcMain.on('history:delete', (_e, ids) => store.deleteHistory(ids));
ipcMain.on('history:clear', () => store.clearHistory());
ipcMain.on('set:save', (_e, set) => store.saveSet(set || {}));
ipcMain.on('set:delete', (_e, id) => store.deleteSet(id));

let profileInfo = null;
ipcMain.handle('app:init', async () => ({
  settings,
  profiles: (profileInfo ||= await Promise.all(profiles.map(async (p) => ({ id: p.id, name: p.name, group: p.group || 'shells', icon: await profileIcon(p) })))),
  windowsBuild: Number(os.release().split('.')[2]) || 0,
  pro: plugin.name,
}));
ipcMain.handle('settings:save', (_e, patch) => { settings = { ...settings, ...patch }; saveSettings(settings); return settings; });
ipcMain.on('app:newWindow', () => createWindow());
ipcMain.on('app:openExternal', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
ipcMain.on('app:openSettingsFile', () => { saveSettings(settings); shell.openPath(SETTINGS_FILE); });
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text));
ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

// ---------- windows ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 480,
    minHeight: 300,
    backgroundColor: '#111318',
    title: 'Glyphterm',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  const wc = win.webContents;
  wc.on('did-finish-load', () => injectPlugin(wc));
  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Right-click in text boxes / on selected text (the terminal handles its own right-click).
  wc.on('context-menu', (_e, params) => {
    const items = [];
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.on('closed', () => killSessionsFor(wc));
  return win;
}

// One running copy per profile: launching Glyphterm again opens a new window in the copy that is already running,
// instead of starting a second app that would fight over the remote terminal's port.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => createWindow());

// A stray error in a side feature must not take down every open terminal: log it instead of showing a crash dialog.
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), `${new Date().toISOString()} ${err && err.stack || err}\n`); } catch {}
  console.error('Uncaught:', err);
});

Menu.setApplicationMenu(null);
app.whenReady().then(() => {
  if (!gotLock) return;
  loadPlugin();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
