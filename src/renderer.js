// Glyphterm renderer: tabs, split panes, xterm.js terminals.
'use strict';

const api = window.glyphterm;
const $ = (sel) => document.querySelector(sel);

const THEME = {
  background: '#111318', foreground: '#d4d9e1', cursor: '#4ea1ff', cursorAccent: '#111318',
  selectionBackground: '#2f4a6e', selectionInactiveBackground: '#26354a',
  black: '#1c1f26', red: '#ff6b6b', green: '#7ee787', yellow: '#e3b341', blue: '#58a6ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#c9d1d9',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#a5f3a1', brightYellow: '#f2cc60', brightBlue: '#79c0ff', brightMagenta: '#e2c5ff', brightCyan: '#87e8ef', brightWhite: '#f0f6fc',
};

let settings = {};
let commandsSnap = { history: [], sets: [] }; // shared command history + saved sets
let profiles = [];
let windowsBuild = 0;
const tabs = [];
let activeTab = null;
const panesByPty = new Map();

// ---------- extension points ----------
// The optional Pro package (separate repository) plugs into these; the core works without it.
const ext = { menuItems: [], commands: [], shortcuts: new Map() };
window.GlyphtermExt = {
  version: 1,
  api,
  toast: (text) => toast(text),
  focusTerminal: () => activeTab?.focused?.focus(),
  registerMenuItem(item) { ext.menuItems.push(item); if (profiles.length) buildProfileMenu(); }, // { label, glyph, key, onClick }
  registerCommand(cmd) { ext.commands.push(cmd); }, // { label, key, run } (shown in the command palette)
  registerShortcut(code, fn) { ext.shortcuts.set(code, fn); }, // Ctrl+Shift+<KeyCode>, e.g. 'KeyB'
  addHelpRow(keys, text) {
    const row = document.createElement('tr');
    const k = document.createElement('td');
    const d = document.createElement('td');
    k.textContent = keys;
    d.textContent = text;
    row.append(k, d);
    document.querySelector('#help table')?.appendChild(row);
  },
};

// ---------- Pane ----------
class Pane {
  constructor(tab, profileId, cwd) {
    this.tab = tab;
    this.ptyId = null;
    this.exited = false;
    this.title = '';
    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.host = document.createElement('div');
    this.host.className = 'term-host';
    this.el.appendChild(this.host);
    this.composer = new Composer(this);
    this.el.appendChild(this.composer.el);

    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing || 0,
      scrollback: settings.scrollback,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: THEME,
      allowTransparency: false,
      macOptionIsMeta: false,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      windowsPty: { backend: 'conpty', buildNumber: windowsBuild },
    });

    this.fit = new FitAddon.FitAddon();
    this.search = new SearchAddon.SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => api.openExternal(url)));
    // Grapheme-cluster widths (Unicode 15): Tamil/Indic clusters, emoji ZWJ sequences, combining marks.
    this.term.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
    this.term.unicode.activeVersion = '15-graphemes';

    this.term.open(this.host);
    this.disposeComplexFix = attachComplexScriptFix(this.host);
    this.term.attachCustomKeyEventHandler((e) => handleTermKey(e, this));
    this.capture = CommandCapture.create();
    this.term.onData((d) => {
      if (this.exited) { closePane(this); return; }
      const cmd = this.muteCapture ? null : CommandCapture.onData(this.term, this.capture, d);
      if (cmd) api.addHistory({ cmd, profile: this.profileName, source: 'terminal' });
      if (this.ptyId) api.write(this.ptyId, d);
    });
    this.term.onBinary((d) => this.ptyId && api.write(this.ptyId, d));
    this.term.onResize(({ cols, rows }) => this.ptyId && api.resize(this.ptyId, cols, rows));
    this.term.onTitleChange((t) => { this.title = t; if (this.ptyId) api.setTitle(this.ptyId, t); renderTabs(); });
    // Remember the shell's working directory when it reports it (OSC 9;9 = Windows Terminal style, OSC 7 = file URL), so a cloned tab can start there.
    this.cwd = null;
    this.term.parser.registerOscHandler(9, (d) => {
      const m = /^9;"?(.+?)"?$/.exec(d);
      if (m) this.cwd = m[1];
      return !!m;
    });
    this.term.parser.registerOscHandler(7, (d) => {
      try { const u = new URL(d); if (u.protocol === 'file:') this.cwd = decodeURIComponent(u.pathname).replace(/^\/([a-z]:)/i, '$1').replace(/\//g, '\\'); } catch { /* ignore */ }
      return true;
    });
    this.term.onBell(() => { if (this.tab !== activeTab) { this.tab.bell = true; renderTabs(); } });
    this.term.onSelectionChange(() => {
      if (settings.copyOnSelect && this.term.hasSelection()) api.writeClipboard(this.term.getSelection());
    });
    this.term.textarea?.addEventListener('focus', () => setFocused(this));

    this.host.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (this.term.hasSelection()) { api.writeClipboard(this.term.getSelection()); this.term.clearSelection(); }
      else this.paste();
    });

    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(this.host);
    this.scheduleFit();
    this.start(profileId, cwd);
  }

  async start(profileId, cwd) {
    const dims = this.fit.proposeDimensions() || { cols: 100, rows: 30 };
    const { id, profile } = await api.createPty({ profileId, cols: dims.cols, rows: dims.rows, cwd });
    this.ptyId = id;
    this.profileName = profile.name;
    this.profileId = profile.id;
    panesByPty.set(id, this);
    renderTabs();
    this.scheduleFit(true);
  }

  // Send text once the shell has printed its first output (prompt), so typeahead isn't lost.
  runWhenReady(text) {
    const t0 = Date.now();
    const tick = () => {
      if (this.ptyId && this.gotOutput && Date.now() - t0 > 400) api.write(this.ptyId, text);
      else if (Date.now() - t0 < 8000) setTimeout(tick, 150);
    };
    tick();
  }

  scheduleFit(forceResize) {
    if (this.fitPending) return;
    this.fitPending = true;
    requestAnimationFrame(() => {
      this.fitPending = false;
      if (!this.el.isConnected || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
      const d = this.fit.proposeDimensions();
      if (!d || !isFinite(d.cols) || !isFinite(d.rows)) return;
      if (d.cols !== this.term.cols || d.rows !== this.term.rows) this.fit.fit();
      else if (forceResize && this.ptyId) api.resize(this.ptyId, this.term.cols, this.term.rows);
    });
  }

  async paste() {
    const text = await api.readClipboard();
    if (text) this.term.paste(text);
  }

  focus() { if (settings.inputBar) this.composer.focus(); else this.term.focus(); }

  dispose() {
    this.ro.disconnect();
    this.disposeComplexFix();
    if (this.ptyId) { panesByPty.delete(this.ptyId); if (!this.exited) api.kill(this.ptyId); }
    this.term.dispose();
    this.el.remove();
  }
}

// ---------- Composer: native text box that types into the terminal ----------
// Real OS text editing (mouse caret, selection, IME, shaped Tamil) — the text is sent to the
// shell on Enter and the result renders in the terminal above.
class Composer {
  constructor(pane) {
    this.pane = pane;
    this.nav = createHistoryNav(() => commandsSnap.history.map((h) => h.cmd));
    this.el = document.createElement('div');
    this.el.className = 'composer';
    this.prompt = document.createElement('span');
    this.prompt.className = 'composer-prompt';
    this.prompt.textContent = '❯';
    this.input = document.createElement('textarea');
    this.input.rows = 1;
    this.input.spellcheck = false;
    this.input.placeholder = 'Type here — Enter to run · Shift+Enter new line · ↑/↓ history · Ctrl+C interrupt · Tab sends to shell';
    this.el.append(this.prompt, this.input);
    this.input.addEventListener('input', () => this.autosize());
    this.input.addEventListener('focus', () => setFocused(pane));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
  }

  focus() { this.input.focus(); }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(this.input.scrollHeight, 160) + 'px';
  }

  send(text, enter) {
    const p = this.pane;
    if (!p.ptyId) return;
    if (text) {
      if (text.includes('\n')) {
        // Bracketed paste when the app supports it. The input box already recorded this command itself.
        p.muteCapture = true;
        try { p.term.paste(text); } finally { p.muteCapture = false; }
      }
      else api.write(p.ptyId, text);
    }
    if (enter) api.write(p.ptyId, '\r');
  }

  setValue(v) {
    this.input.value = v;
    this.autosize();
    this.input.selectionStart = this.input.selectionEnd = v.length;
  }

  onKey(e) {
    const ta = this.input;
    const p = this.pane;
    // Copy / paste act on the text box here (not the terminal behind it).
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
      e.preventDefault();
      if (e.code === 'KeyC') {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || (p.term.hasSelection() ? p.term.getSelection() : '');
        if (sel) api.writeClipboard(sel);
      } else {
        api.readClipboard().then((text) => {
          if (!text) return;
          ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
          this.autosize();
        });
      }
      return;
    }
    // Global shortcuts (tabs, splits, palette…) still work from here.
    if ((e.ctrlKey && (e.shiftKey || ['Tab', '=', '-', '0', ','].includes(e.key) || /^Digit/.test(e.code))) || (e.altKey && e.key.startsWith('Arrow')) || e.key === 'F1') {
      if (handleTermKey(e, p) === false) return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = ta.value;
      if (text.trim() && p.term.buffer.active.type === 'normal') api.addHistory({ cmd: text, profile: p.profileName, source: 'input' });
      this.nav.reset();
      this.send(text, true);
      this.setValue('');
      p.term.scrollToBottom();
    } else if (e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault();
      if (p.term.hasSelection()) { api.writeClipboard(p.term.getSelection()); p.term.clearSelection(); return; }
      this.setValue('');
      api.write(p.ptyId, '\x03');
    } else if (e.ctrlKey && !e.shiftKey && e.code === 'KeyD' && !ta.value) {
      e.preventDefault();
      api.write(p.ptyId, '\x04');
    } else if (e.ctrlKey && !e.shiftKey && e.code === 'KeyL') {
      e.preventDefault();
      p.term.clear();
    } else if (e.key === 'Tab' && !e.ctrlKey) {
      // Hand the line to the shell for completion, then continue in the terminal itself.
      e.preventDefault();
      this.send(ta.value, false);
      api.write(p.ptyId, '\t');
      this.setValue('');
      p.term.focus();
    } else if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !ta.value.slice(0, ta.selectionStart).includes('\n')) {
      const v = this.nav.up(ta.value);
      if (v !== null) { e.preventDefault(); this.setValue(v); }
    } else if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && this.nav.active() && !ta.value.slice(ta.selectionEnd).includes('\n')) {
      const v = this.nav.down();
      if (v !== null) { e.preventDefault(); this.setValue(v); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      p.term.focus();
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      p.term.scrollPages(e.key === 'PageUp' ? -1 : 1);
    }
  }
}

function toggleInputBar() {
  settings.inputBar = !settings.inputBar;
  document.body.classList.toggle('input-bar', settings.inputBar);
  api.saveSettings({ inputBar: settings.inputBar });
  $('#input-btn').classList.toggle('on', settings.inputBar);
  for (const t of tabs) for (const p of t.panes) p.scheduleFit();
  activeTab?.focused?.focus();
}

// ---------- Tab ----------
class Tab {
  constructor(profileId, cwd) {
    this.customTitle = null;
    this.bell = false;
    this.root = document.createElement('div');
    this.root.className = 'tab-root';
    $('#workspace').appendChild(this.root);
    const pane = new Pane(this, profileId, cwd);
    this.panes = [pane];
    this.focused = pane;
    this.root.appendChild(pane.el);
  }
  get title() {
    if (this.customTitle) return this.customTitle;
    const p = this.focused;
    if (!p) return 'Terminal';
    // Shells that just report their own exe path get the friendlier profile name.
    const exeOnly = /^[a-z]:.*\.exe$/i.test(p.title || '') || /^Administrator: /.test(p.title || '');
    return (!exeOnly && p.title) || p.profileName || 'Terminal';
  }
}

function newTab(profileId, cwd) {
  const tab = new Tab(profileId || settings.defaultProfile, cwd);
  tabs.push(tab);
  activateTab(tab);
  return tab;
}

// Clone a tab: same shell and working directory (when the shell reports it), same custom name. A fresh session, not a copy of the output.
function duplicateTab(tab) {
  const src = tab.focused;
  const t = newTab(src?.profileId, src?.cwd || undefined);
  t.customTitle = tab.customTitle;
  renderTabs();
  return t;
}

function activateTab(tab) {
  activeTab = tab;
  tab.bell = false;
  for (const t of tabs) t.root.classList.toggle('hidden', t !== tab);
  renderTabs();
  requestAnimationFrame(() => {
    for (const p of tab.panes) p.scheduleFit(true);
    tab.focused?.focus();
  });
}

function closeTab(tab) {
  for (const p of [...tab.panes]) p.dispose();
  tab.root.remove();
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  if (!tabs.length) { api.closeWindow(); return; }
  if (activeTab === tab) activateTab(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
}

function renderTabs() {
  const box = $('#tabs');
  box.textContent = '';
  tabs.forEach((tab, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === activeTab ? ' active' : '');
    const icon = profiles.find((p) => p.id === tab.focused?.profileId)?.icon;
    if (icon) { const img = document.createElement('img'); img.className = 'tab-icon'; img.src = icon; el.appendChild(img); }
    else if (i < 9) { const n = document.createElement('span'); n.className = 'num'; n.textContent = i + 1; el.appendChild(n); }
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title;
    el.title = tab.title;
    el.appendChild(title);
    if (tab.bell) { const b = document.createElement('span'); b.className = 'bell'; el.appendChild(b); }
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.onclick = (e) => { e.stopPropagation(); closeTab(tab); };
    el.appendChild(close);
    el.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab); } };
    el.onclick = () => activateTab(tab);
    el.oncontextmenu = (e) => { e.preventDefault(); showTabMenu(e, tab, title); };
    el.ondblclick = () => renameTab(tab, title);
    box.appendChild(el);
  });
  document.title = activeTab ? `${activeTab.title} — Glyphterm` : 'Glyphterm';
}

function showTabMenu(e, tab, titleEl) {
  const menu = $('#tab-menu');
  const hide = () => menu.classList.add('hidden');
  menu.textContent = '';
  menu.appendChild(menuItem('Duplicate tab', { glyph: '⧉', key: 'Ctrl+Shift+K', onClick: () => { hide(); duplicateTab(tab); } }));
  menu.appendChild(menuItem('Rename tab', { glyph: '✎', onClick: () => { hide(); activateTab(tab); renameTab(tab, $('#tabs .tab.active .title') || titleEl); } }));
  menu.appendChild(document.createElement('hr'));
  menu.appendChild(menuItem('Close tab', { glyph: '×', onClick: () => { hide(); closeTab(tab); } }));
  menu.style.left = Math.min(e.clientX, window.innerWidth - 240) + 'px';
  menu.classList.remove('hidden');
}

function renameTab(tab, titleEl) {
  const input = document.createElement('input');
  input.value = tab.title;
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();
  const done = (commit) => {
    if (commit) tab.customTitle = input.value.trim() || null;
    renderTabs();
    tab.focused?.focus();
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  input.onblur = () => done(true);
}

// ---------- split panes ----------
function setFocused(pane) {
  const tab = pane.tab;
  tab.focused = pane;
  for (const p of tab.panes) {
    p.el.classList.toggle('focused', p === pane);
    p.el.classList.toggle('dim', tab.panes.length > 1 && p !== pane);
  }
  if (tab === activeTab) renderTabs();
}

function splitPane(pane, dir /* 'row' | 'col' */, profileId) {
  const tab = pane.tab;
  if (tab.root.classList.contains('zoomed')) toggleZoom(pane);
  const parent = pane.el.parentElement;
  const split = document.createElement('div');
  split.className = 'split ' + dir;
  split.style.flex = pane.el.style.flex;
  pane.el.style.flex = '1 1 0';
  parent.replaceChild(split, pane.el);

  const divider = makeDivider(split);
  const fresh = new Pane(tab, profileId || currentProfileOf(pane), null);
  fresh.el.style.flex = '1 1 0';
  split.append(pane.el, divider, fresh.el);
  tab.panes.push(fresh);
  tab.root.classList.add('multi');
  setFocused(fresh);
  requestAnimationFrame(() => fresh.focus());
}

function currentProfileOf(pane) {
  return pane.profileId || settings.defaultProfile;
}

function makeDivider(split) {
  const d = document.createElement('div');
  d.className = 'divider';
  d.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const a = d.previousElementSibling, b = d.nextElementSibling;
    const horiz = split.classList.contains('row');
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const total = horiz ? ra.width + rb.width : ra.height + rb.height;
    const start = horiz ? e.clientX : e.clientY;
    const sizeA = horiz ? ra.width : ra.height;
    const ga = parseFloat(a.style.flexGrow || 1), gb = parseFloat(b.style.flexGrow || 1);
    const gsum = ga + gb;
    d.classList.add('dragging');
    const move = (ev) => {
      const pos = horiz ? ev.clientX : ev.clientY;
      const na = Math.max(60, Math.min(total - 60, sizeA + pos - start));
      a.style.flex = `${(na / total) * gsum} 1 0`;
      b.style.flex = `${(1 - na / total) * gsum} 1 0`;
    };
    const up = () => {
      d.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      activeTab?.focused?.focus();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return d;
}

function closePane(pane) {
  const tab = pane.tab;
  if (tab.panes.length === 1) { closeTab(tab); return; }
  if (tab.root.classList.contains('zoomed')) toggleZoom(pane);
  const split = pane.el.parentElement;
  const idx = tab.panes.indexOf(pane);
  tab.panes.splice(idx, 1);
  // remove the adjoining divider
  const div = pane.el.previousElementSibling?.classList.contains('divider') ? pane.el.previousElementSibling : pane.el.nextElementSibling;
  div?.remove();
  pane.dispose();
  // collapse a split that now holds a single child
  if (split.classList.contains('split') && split.children.length === 1) {
    const only = split.firstElementChild;
    only.style.flex = split.style.flex || '1 1 0';
    split.parentElement.replaceChild(only, split);
  }
  if (tab.panes.length === 1) tab.root.classList.remove('multi');
  const next = tab.panes[Math.max(0, idx - 1)];
  setFocused(next);
  next.focus();
  renderTabs();
}

function toggleZoom(pane) {
  const tab = pane.tab;
  if (tab.panes.length < 2) return;
  const on = !tab.root.classList.contains('zoomed');
  tab.root.classList.toggle('zoomed', on);
  for (const p of tab.panes) p.el.classList.toggle('zoomed-pane', on && p === pane);
  pane.focus();
}

function movePaneFocus(dir) {
  const tab = activeTab;
  if (!tab || tab.panes.length < 2) return;
  const cur = tab.focused.el.getBoundingClientRect();
  const cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
  let best = null, bestScore = Infinity;
  for (const p of tab.panes) {
    if (p === tab.focused) continue;
    const r = p.el.getBoundingClientRect();
    const px = r.left + r.width / 2, py = r.top + r.height / 2;
    const ok = (dir === 'left' && r.right <= cur.left + 4) || (dir === 'right' && r.left >= cur.right - 4) ||
               (dir === 'up' && r.bottom <= cur.top + 4) || (dir === 'down' && r.top >= cur.bottom - 4);
    if (!ok) continue;
    const score = (dir === 'left' || dir === 'right') ? Math.abs(px - cx) + Math.abs(py - cy) * 2 : Math.abs(py - cy) + Math.abs(px - cx) * 2;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  if (best) { setFocused(best); best.focus(); }
}

// ---------- font size ----------
function setFontSize(size) {
  settings.fontSize = Math.max(8, Math.min(40, size));
  for (const t of tabs) for (const p of t.panes) { p.term.options.fontSize = settings.fontSize; p.scheduleFit(); }
  api.saveSettings({ fontSize: settings.fontSize });
}

// Extra pixels per character cell. Tamil/Indic clusters are about twice as wide as a Latin letter, so a wider
// cell makes them look less squeezed (Windows Terminal calls this "cell width").
function setCellSpacing(px) {
  settings.letterSpacing = px;
  for (const t of tabs) for (const p of t.panes) { p.term.options.letterSpacing = px; p.scheduleFit(); }
  api.saveSettings({ letterSpacing: px });
  toast(px ? `Character spacing +${px}px` : 'Character spacing: normal');
}

function repaint(pane) {
  pane.term.clearTextureAtlas?.();
  pane.term.refresh(0, pane.term.rows - 1);
  pane.scheduleFit(true);
}

// ---------- search ----------
const searchBox = $('#search'), searchInput = $('#search-input');
const SEARCH_OPTS = { decorations: { matchOverviewRuler: '#e3b341', activeMatchColorOverviewRuler: '#4ea1ff', matchBackground: '#5a4a1a', activeMatchBackground: '#2f4a6e' } };
function openSearch() { searchBox.classList.remove('hidden'); searchInput.focus(); searchInput.select(); }
function closeSearch() { searchBox.classList.add('hidden'); activeTab?.focused?.search.clearDecorations(); activeTab?.focused?.focus(); }
function doSearch(back) {
  const p = activeTab?.focused; if (!p || !searchInput.value) return;
  back ? p.search.findPrevious(searchInput.value, SEARCH_OPTS) : p.search.findNext(searchInput.value, SEARCH_OPTS);
}
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey); }
  if (e.key === 'Escape') closeSearch();
});
searchInput.addEventListener('input', () => doSearch(false));
$('#search-next').onclick = () => doSearch(false);
$('#search-prev').onclick = () => doSearch(true);
$('#search-close').onclick = closeSearch;

// ---------- keyboard ----------
// Returns false to stop xterm from handling the key.
function handleTermKey(e, pane) {
  if (e.type !== 'keydown') return true;
  const ctrl = e.ctrlKey, shift = e.shiftKey, alt = e.altKey;
  const k = e.key, code = e.code;
  const act = (fn) => { e.preventDefault(); fn(); return false; };

  if (ctrl && shift && !alt) {
    const extFn = ext.shortcuts.get(code);
    if (extFn) return act(extFn);
    switch (code) {
      case 'KeyC': return act(() => { if (pane.term.hasSelection()) api.writeClipboard(pane.term.getSelection()); });
      case 'KeyV': return act(() => pane.paste());
      case 'KeyD': return act(() => splitPane(pane, 'row'));
      case 'KeyE': return act(() => splitPane(pane, 'col'));
      case 'KeyW': return act(() => closePane(pane));
      case 'KeyN': return act(() => api.newWindow());
      case 'KeyF': return act(openSearch);
      case 'KeyP': return act(openPalette);
      case 'KeyR': return act(() => repaint(pane));
      case 'KeyI': return act(toggleInputBar);
      case 'KeyH': return act(() => cmdPanel.toggle('history'));
      case 'KeyT': return act(() => newTab());
      case 'KeyK': return act(() => activeTab && duplicateTab(activeTab));
      case 'Enter': return act(() => toggleZoom(pane));
      case 'Tab': return act(() => cycleTab(-1));
    }
    const m = /^Digit([1-9])$/.exec(code);
    if (m) return act(() => { const p = profiles[+m[1] - 1]; if (p) newTab(p.id); });
  }
  if (ctrl && !shift && !alt) {
    if (code === 'KeyT') return act(() => newTab());
    if (k === 'Tab') return act(() => cycleTab(1));
    if (k === '=' || k === '+') return act(() => setFontSize(settings.fontSize + 1));
    if (k === '-') return act(() => setFontSize(settings.fontSize - 1));
    if (k === '0') return act(() => setFontSize(15));
    if (k === ',') return act(() => api.openSettingsFile());
    const m = /^Digit([1-9])$/.exec(code);
    if (m) return act(() => { const t = +m[1] === 9 ? tabs[tabs.length - 1] : tabs[+m[1] - 1]; if (t) activateTab(t); });
    // Ctrl+C copies when there's a selection, otherwise it's SIGINT as usual.
    if (code === 'KeyC' && pane.term.hasSelection()) return act(() => { api.writeClipboard(pane.term.getSelection()); pane.term.clearSelection(); });
    if (code === 'KeyV') return act(() => pane.paste());
  }
  if (alt && !ctrl && !shift) {
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];
    if (dir) return act(() => movePaneFocus(dir));
  }
  if (k === 'F1') return act(toggleHelp);
  return true;
}

function cycleTab(step) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(activeTab);
  activateTab(tabs[(i + step + tabs.length) % tabs.length]);
}

function toggleHelp() { $('#help').classList.toggle('hidden'); }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#help').classList.contains('hidden')) { toggleHelp(); activeTab?.focused?.focus(); }
    $('#profile-menu').classList.add('hidden');
    $('#tab-menu').classList.add('hidden');
  }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyP') { e.preventDefault(); openPalette(); }
  if (e.key === 'F1') { e.preventDefault(); toggleHelp(); }
});

// ---------- profile menu ----------
const GLYPHS = { settings: '⚙', palette: 'ϟ', about: '?', window: '❐', keys: '⌨', star: '★' };

function menuItem(label, { icon, glyph, key, bold, onClick }) {
  const b = document.createElement('button');
  const ic = document.createElement('span');
  ic.className = 'mi-icon';
  if (icon) { const img = document.createElement('img'); img.src = icon; ic.appendChild(img); }
  else ic.textContent = glyph || '';
  const text = document.createElement('span');
  text.className = 'mi-label' + (bold ? ' bold' : '');
  text.textContent = label;
  const kbd = document.createElement('kbd');
  kbd.textContent = key || '';
  b.append(ic, text, kbd);
  b.onclick = onClick;
  return b;
}

function buildProfileMenu() {
  const menu = $('#profile-menu');
  menu.textContent = '';
  const hide = () => menu.classList.add('hidden');
  let lastGroup = null;
  profiles.forEach((p, i) => {
    if (lastGroup && p.group !== lastGroup) menu.appendChild(document.createElement('hr'));
    lastGroup = p.group;
    const b = menuItem(p.name, {
      icon: p.icon, glyph: '>_', bold: p.id === settings.defaultProfile, key: i < 9 ? `Ctrl+Shift+${i + 1}` : '',
      // Like Windows Terminal: Alt+click opens the profile in a split pane.
      onClick: (e) => { hide(); if (e.altKey && activeTab) splitPane(activeTab.focused, 'row', p.id); else newTab(p.id); },
    });
    b.title = 'Click: new tab · Alt+Click: split pane';
    menu.appendChild(b);
  });
  menu.appendChild(document.createElement('hr'));
  menu.appendChild(menuItem('Settings', { glyph: GLYPHS.settings, key: 'Ctrl+,', onClick: () => { hide(); api.openSettingsFile(); } }));
  menu.appendChild(menuItem('Command palette', { glyph: GLYPHS.palette, key: 'Ctrl+Shift+P', onClick: () => { hide(); openPalette(); } }));
  menu.appendChild(menuItem('New window', { glyph: GLYPHS.window, key: 'Ctrl+Shift+N', onClick: () => { hide(); api.newWindow(); } }));
  menu.appendChild(menuItem('Direct input box', { glyph: '⌨', key: 'Ctrl+Shift+I', onClick: () => { hide(); toggleInputBar(); } }));
  menu.appendChild(menuItem('History & saved sets', { glyph: '\u{1F552}', key: 'Ctrl+Shift+H', onClick: () => { hide(); cmdPanel.open('history'); } }));
  for (const it of ext.menuItems) menu.appendChild(menuItem(it.label, { glyph: it.glyph, key: it.key, onClick: () => { hide(); it.onClick(); } }));
  menu.appendChild(menuItem('Keyboard shortcuts', { glyph: GLYPHS.keys, key: 'F1', onClick: () => { hide(); toggleHelp(); } }));
  menu.appendChild(menuItem('About', { glyph: GLYPHS.about, onClick: () => { hide(); showAbout(); } }));
}

// ---------- history & saved sets ----------
function insertCommand(text) {
  const p = activeTab?.focused;
  if (!p) return;
  if (settings.inputBar) { p.composer.setValue(text); p.composer.focus(); return; }
  // PowerShell/cmd: Esc clears whatever is on the line first. (In bash Esc is a Meta prefix, so skip it there.)
  if (/powershell|command prompt|developer/i.test(p.profileName || '')) api.write(p.ptyId, '\x1b');
  api.write(p.ptyId, text);
  p.term.focus();
}

function runCommand(text) {
  const p = activeTab?.focused;
  if (!p?.ptyId) return;
  api.addHistory({ cmd: text, profile: p.profileName, source: 'input' });
  api.write(p.ptyId, text.replace(/\n/g, '\r') + '\r');
  p.term.scrollToBottom();
  p.term.focus();
}

function runSet(set, { newTab: inNewTab }) {
  const text = set.commands.map((c) => c + '\r').join('');
  if (inNewTab) {
    const tab = newTab(set.profile || undefined);
    tab.customTitle = set.name;
    renderTabs();
    tab.focused.runWhenReady(text);
  } else {
    const p = activeTab?.focused;
    if (!p?.ptyId) return;
    api.write(p.ptyId, text);
    p.term.scrollToBottom();
    p.term.focus();
  }
  toast(`Running "${set.name}" (${set.commands.length} command${set.commands.length === 1 ? '' : 's'})`);
}

const cmdPanel = createCommandsPanel({
  insert: insertCommand,
  run: runCommand,
  runSet,
  profiles: () => profiles,
  deleteHistory: (ids) => api.deleteHistory(ids),
  clearHistory: () => api.clearHistory(),
  saveSet: (set) => api.saveSet(set),
  deleteSet: (id) => api.deleteSet(id),
  onClose: () => activeTab?.focused?.focus(),
});
$('#workspace').appendChild(cmdPanel.el);
api.onCommandsChanged((snap) => { commandsSnap = snap; cmdPanel.update(snap); });
api.getCommands().then((snap) => { commandsSnap = snap; cmdPanel.update(snap); });

function toast(text) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 4000);
}

function showAbout() {
  const pane = activeTab?.focused;
  pane?.term.write('\r\n\x1b[1;34mGlyphterm\x1b[0m — Unicode-first tabbed terminal · xterm.js + ConPTY · தமிழ் · हिन्दी · 日本語 · 👍\r\n');
}

// ---------- command palette ----------
function paletteCommands() {
  const p = () => activeTab?.focused;
  const cmds = profiles.map((pr) => ({ label: `New tab: ${pr.name}`, icon: pr.icon, run: () => newTab(pr.id) }));
  cmds.push(...profiles.map((pr) => ({ label: `Split pane: ${pr.name}`, icon: pr.icon, run: () => p() && splitPane(p(), 'row', pr.id) })));
  cmds.push(
    { label: 'Split pane right', key: 'Ctrl+Shift+D', run: () => p() && splitPane(p(), 'row') },
    { label: 'Split pane down', key: 'Ctrl+Shift+E', run: () => p() && splitPane(p(), 'col') },
    { label: 'Close pane', key: 'Ctrl+Shift+W', run: () => p() && closePane(p()) },
    { label: 'Toggle pane zoom', key: 'Ctrl+Shift+Enter', run: () => p() && toggleZoom(p()) },
    { label: 'Rename tab', run: () => { const el = $('#tabs .tab.active .title'); if (el && activeTab) renameTab(activeTab, el); } },
    { label: 'Duplicate tab', key: 'Ctrl+Shift+K', run: () => activeTab && duplicateTab(activeTab) },
    { label: 'Close tab', run: () => activeTab && closeTab(activeTab) },
    { label: 'New window', key: 'Ctrl+Shift+N', run: () => api.newWindow() },
    ...ext.commands,
    { label: 'Command history', key: 'Ctrl+Shift+H', run: () => cmdPanel.open('history') },
    { label: 'Saved command sets', run: () => cmdPanel.open('sets') },
    { label: 'New saved command set', run: () => { cmdPanel.open('sets'); setTimeout(() => cmdPanel.el.querySelector('.cmdp-tools .primary')?.click(), 0); } },
    { label: 'Find', key: 'Ctrl+Shift+F', run: openSearch },
    { label: `Toggle direct input box (${settings.inputBar ? 'on' : 'off'})`, key: 'Ctrl+Shift+I', run: toggleInputBar },
    { label: 'Increase font size', key: 'Ctrl+=', run: () => setFontSize(settings.fontSize + 1) },
    { label: 'Decrease font size', key: 'Ctrl+-', run: () => setFontSize(settings.fontSize - 1) },
    { label: 'Reset font size', key: 'Ctrl+0', run: () => setFontSize(15) },
    ...[[0, 'normal'], [2, '+2 (a little wider)'], [4, '+4 (good for Tamil)'], [6, '+6 (widest)']].map(([px, name]) => ({
      label: `Character spacing: ${name}${(settings.letterSpacing || 0) === px ? '  ✓' : ''}`,
      run: () => setCellSpacing(px),
    })),
    { label: 'Clear buffer', run: () => p()?.term.clear() },
    { label: 'Force repaint', key: 'Ctrl+Shift+R', run: () => p() && repaint(p()) },
    { label: `Toggle copy on select (${settings.copyOnSelect ? 'on' : 'off'})`, run: () => { settings.copyOnSelect = !settings.copyOnSelect; api.saveSettings({ copyOnSelect: settings.copyOnSelect }); } },
    { label: 'Set current shell as default', run: setDefaultMenu },
    { label: 'Open settings.json', key: 'Ctrl+,', run: () => api.openSettingsFile() },
    { label: 'Keyboard shortcuts', key: 'F1', run: toggleHelp },
  );
  return cmds;
}

let paletteSel = 0, paletteItems = [];
function openPalette() {
  $('#palette').classList.remove('hidden');
  const input = $('#palette-input');
  input.value = '';
  renderPalette();
  input.focus();
}
function closePalette(refocus = true) {
  $('#palette').classList.add('hidden');
  if (refocus) activeTab?.focused?.focus();
}
function renderPalette() {
  const q = $('#palette-input').value.toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);
  paletteItems = paletteCommands().filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
  paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
  const list = $('#palette-list');
  list.textContent = '';
  paletteItems.forEach((c, i) => {
    const b = menuItem(c.label, { icon: c.icon, key: c.key, onClick: () => runPalette(i) });
    if (i === paletteSel) b.classList.add('sel');
    list.appendChild(b);
  });
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function runPalette(i) {
  const c = paletteItems[i];
  closePalette(false);
  if (c) c.run();
  setTimeout(() => activeTab?.focused?.focus(), 0);
}
$('#palette-input').addEventListener('input', () => { paletteSel = 0; renderPalette(); });
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteSel); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });

function setDefaultMenu() {
  const pane = activeTab?.focused;
  if (!pane) return;
  settings.defaultProfile = currentProfileOf(pane);
  api.saveSettings({ defaultProfile: settings.defaultProfile });
  buildProfileMenu();
}

$('#new-tab').onclick = () => newTab();
$('#help-btn').onclick = toggleHelp;
$('#profile-menu-btn').onclick = (e) => {
  const menu = $('#profile-menu');
  const r = e.currentTarget.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
  menu.classList.toggle('hidden');
};
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#profile-menu, #profile-menu-btn')) $('#profile-menu').classList.add('hidden');
  if (!e.target.closest('#tab-menu')) $('#tab-menu').classList.add('hidden');
});
$('#tabbar').addEventListener('dblclick', (e) => { if (e.target.id === 'tabbar' || e.target.id === 'spacer') newTab(); });

// ---------- PTY events ----------
api.onData((id, data) => {
  const p = panesByPty.get(id);
  if (!p) return;
  p.gotOutput = true;
  p.term.write(data);
});
api.onExit((id, code) => {
  const pane = panesByPty.get(id);
  if (!pane) return;
  pane.exited = true;
  if (code === 0) { closePane(pane); return; }
  pane.term.write(`\r\n\x1b[90m[process exited with code ${code} — press any key to close]\x1b[0m`);
});

window.addEventListener('focus', () => activeTab?.focused?.focus());

// ---------- boot ----------
(async () => {
  const init = await api.init();
  settings = init.settings;
  profiles = init.profiles;
  windowsBuild = init.windowsBuild;
  buildProfileMenu();
  document.body.classList.toggle('input-bar', !!settings.inputBar);
  $('#input-btn').classList.toggle('on', !!settings.inputBar);
  $('#input-btn').onclick = toggleInputBar;
  $('#history-btn').onclick = () => cmdPanel.toggle('history');
  await document.fonts.ready;
  newTab();
})();
