// Dev harness: launches Glyphterm with a throwaway profile, exercises the UI, saves screenshots.
// Usage: npm run shot   (writes PNGs to ./shots or $SHOT_DIR; set GLYPHTERM_NO_PRO=1 to test the core alone)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = process.env.SHOT_DIR || path.join(__dirname, '..', 'shots');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'glyphterm-test-')));
const sample = '\r\n' + fs.readFileSync(path.join(__dirname, 'sample.txt'), 'utf8').replace(/\r?\n/g, '\r\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  if (BrowserWindow.getAllWindows().length > 1) return;
  const wc = win.webContents;
  const js = (s) => wc.executeJavaScript(`try { ${s} } catch (e) { 'ERR ' + String(e.stack) }`).then((r) => { if (typeof r === 'string' && r.startsWith('ERR')) console.log('[js]', r); return r; });
  const shot = async (name) => { wc.invalidate(); await wait(300); fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG()); };
  const type = async (text) => { await js(`activeTab.focused.term.input(${JSON.stringify(text)}); 0`); await wait(1000); };
  wc.on('did-finish-load', async () => {
    await wait(3500);
    await js(`activeTab.focused.term.write(${JSON.stringify(sample)}); 0`);
    await shot('1-tamil.png');

    // Commands typed straight into the terminal should land in history.
    await type("echo 'வணக்கம் உலகம்'\r");
    await type('Get-Date\r');
    await type('git --version\r');
    await type('dir C:\\Windows | select -first 3\r');
    await js(`api.saveSet({ name: 'Morning check', profile: 'cmd', commands: ['ver', 'echo %USERNAME%', 'dir /b %USERPROFILE%'] }); 0`);
    await js(`api.saveSet({ name: 'Git status everywhere', profile: '', commands: ['git status', 'git log --oneline -5'] }); 0`);
    await wait(500);

    await js(`cmdPanel.open('history'); 0`);
    await shot('7-history.png');
    await js(`cmdPanel.open('sets'); 0`);
    await shot('8-sets.png');
    await js(`cmdPanel.el.querySelector('.cmdp-set-acts button:nth-child(3)').click(); 0`);
    await shot('9-editor.png');
    await js(`cmdPanel.close(); 0`);

    // Run a saved set in a new tab (uses the set's cmd profile).
    await js(`api.getCommands().then((s) => runSet(s.sets[0], { newTab: true })); 0`);
    await wait(4000);
    await shot('10-set-ran.png');

    // With the Pro package present, also capture its access dialog.
    if (await js(`!!document.querySelector('#web-dialog')`)) {
      await js(`document.querySelector('#profile-menu-btn').click(); 0`);
      await wait(300);
      await shot('11-menu-with-pro.png');
      await js(`document.querySelector('#profile-menu').classList.add('hidden'); [...document.querySelectorAll('#profile-menu button')].find((b) => /Remote terminal access/.test(b.textContent))?.click(); 0`);
      await wait(1200);
      await shot('12-web-dialog.png');
      const info = await js(`GlyphtermExt.api.ext.invoke('web:start')`);
      console.log('pro web server with token:', (await fetch(info.localUrl)).status, '| without token:', (await fetch(info.localUrl.split('?')[0])).status);
      await js(`GlyphtermExt.api.ext.invoke('web:stop')`);
    } else {
      console.log('core only (no Pro package loaded)');
    }
    console.log('done', out);
    app.quit();
  });
});
require('../main.js');
