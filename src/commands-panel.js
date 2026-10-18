// Command history + saved command sets panel, shared by the desktop app and the web client.
// Also exports CommandCapture, which records commands typed directly into a terminal.
'use strict';

(function () {
  // ---------- capture commands typed in the terminal ----------
  const PROMPTS = [
    /^PS [^>]*>\s?/,                 // PowerShell
    /^[A-Za-z]:\\[^>]*>/,            // cmd
    /^\S+@\S+[^$#\n]*[$#]\s/,        // bash user@host:~$
    /^[$#%]\s/,                      // bash / zsh second-line prompt
    /^>>>\s|^\.\.\.\s/,              // Python
    /^>\s/,                          // Node REPL
  ];

  // Text of the logical line under the cursor, stopping at dim/italic cells (PSReadLine's grey predictions).
  function lineAtCursor(term) {
    const buf = term.buffer.active;
    let y = buf.baseY + buf.cursorY;
    const rows = [];
    let line = buf.getLine(y);
    if (!line) return '';
    rows.unshift(line);
    while (line.isWrapped && y > 0) { y--; line = buf.getLine(y); rows.unshift(line); }
    let text = '';
    const cell = buf.getNullCell();
    for (const l of rows) {
      for (let x = 0; x < l.length; x++) {
        l.getCell(x, cell);
        if (cell.isDim() || cell.isItalic()) return text.trimEnd();
        text += cell.getChars() || (cell.getWidth() ? ' ' : '');
      }
    }
    return text.trimEnd();
  }

  function stripPrompt(text) {
    for (const re of PROMPTS) {
      const m = re.exec(text);
      if (m) return text.slice(m[0].length);
    }
    return null;
  }

  const CommandCapture = {
    create: () => ({ typed: '', dirty: false }),
    // Feed every chunk the user sends to the shell; returns a command string when Enter is pressed.
    onData(term, st, data) {
      if (term.buffer.active.type !== 'normal') { st.typed = ''; st.dirty = false; return null; } // TUI apps
      let d = data;
      const pasted = d.startsWith('\x1b[200~');
      if (pasted) d = d.replace(/\x1b\[20[01]~/g, '');
      else if (d.startsWith('\x1b')) { st.dirty = true; return null; } // arrows, history recall, etc.
      // Multi-line paste: keep it whole as one multi-line command instead of recording each fragment.
      const body = d.replace(/[\r\n]+$/, '');
      if (/[\r\n]/.test(body)) {
        const whole = body.replace(/\r\n?|\n/g, '\n').trim();
        st.dirty = false;
        if (/[\r\n]$/.test(d)) { st.typed = ''; return whole || null; } // pasted and already executed
        st.typed = whole;                                                   // waiting for Enter
        return null;
      }
      let result = null;
      const chunkTextBeforeEnter = d.split('\r')[0];
      for (const ch of d) {
        if (ch === '\r') {
          const fromScreen = stripPrompt(lineAtCursor(term));
          // A plain Enter after typing: trust the screen (covers tab-completion and ↑ recall).
          // Text + Enter in one chunk (paste/automation): the screen hasn't echoed yet, so use what was sent.
          if (chunkTextBeforeEnter && chunkTextBeforeEnter.length > 1) result = st.typed;
          else if (fromScreen !== null) result = fromScreen;
          else if (!st.dirty) result = st.typed;
          st.typed = '';
          st.dirty = false;
        } else if (ch === '\x7f' || ch === '\b') st.typed = st.typed.slice(0, -1);
        else if (ch === '\x03' || ch === '\x15') { st.typed = ''; st.dirty = false; }
        else if (ch === '\n') st.typed += '\n';
        else if (ch < ' ') st.dirty = true;
        else st.typed += ch;
      }
      return result && result.trim() ? result.trim() : null;
    },
  };

  // ---------- ↑/↓ recall for the text boxes (shared history, keeps your unfinished draft) ----------
  function createHistoryNav(getEntries) {
    let idx = -1;
    let draft = '';
    return {
      reset() { idx = -1; },
      active: () => idx >= 0,
      up(current) {
        const list = getEntries();
        if (!list.length) return null;
        if (idx < 0) { draft = current; idx = list.length; }
        if (idx > 0) idx--;
        return list[idx];
      },
      down() {
        if (idx < 0) return null;
        const list = getEntries();
        idx++;
        if (idx >= list.length) { idx = -1; return draft; }
        return list[idx];
      },
    };
  }

  // ---------- panel ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * adapter: {
   *   insert(text), run(text), runSet(set, { newTab }), profiles(): [{id,name}],
   *   deleteHistory(ids), clearHistory(), saveSet(set), deleteSet(id), onClose()
   * }
   */
  function createCommandsPanel(adapter) {
    let snap = { history: [], sets: [] };
    let tab = 'history';
    const selected = new Set();

    const root = el('aside', 'cmdp hidden');
    root.innerHTML = `
      <div class="cmdp-head">
        <button class="cmdp-tab" data-tab="history">History</button>
        <button class="cmdp-tab" data-tab="sets">Saved sets</button>
        <span class="cmdp-spacer"></span>
        <button class="cmdp-x" title="Close (Esc)">&#10005;</button>
      </div>
      <div class="cmdp-search"><input placeholder="Search…" spellcheck="false" /></div>
      <div class="cmdp-tools"></div>
      <div class="cmdp-list"></div>
      <div class="cmdp-hint"></div>
      <div class="cmdp-editor hidden">
        <h3></h3>
        <label>Name<input class="ed-name" spellcheck="false" placeholder="e.g. Build &amp; test" /></label>
        <label>Shell for "Run in new tab"<select class="ed-profile"></select></label>
        <label>Commands <small>(one per line, run in order)</small><textarea class="ed-cmds" spellcheck="false" rows="9" placeholder="git pull&#10;npm install&#10;npm test"></textarea></label>
        <div class="ed-buttons"><button class="ed-cancel">Cancel</button><button class="ed-save primary">Save</button></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const search = $('.cmdp-search input');
    const list = $('.cmdp-list');
    const tools = $('.cmdp-tools');
    const hint = $('.cmdp-hint');
    const editor = $('.cmdp-editor');
    let editing = null;
    let rows = []; // rendered items: { el, enter, run }
    let cur = 0;

    root.querySelectorAll('.cmdp-tab').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; selected.clear(); render(); search.focus(); }));
    $('.cmdp-x').onclick = () => close();
    search.addEventListener('input', () => { cur = 0; render(); });
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); if (!editor.classList.contains('hidden')) closeEditor(); else close(); return; }
      if (!editor.classList.contains('hidden') || e.target !== search) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        cur += e.key === 'ArrowDown' ? 1 : -1;
        markCur();
      } else if (e.key === 'Enter' && rows[cur]) {
        e.preventDefault();
        (e.ctrlKey || e.shiftKey ? rows[cur].run : rows[cur].enter)();
      }
    });

    function markCur() {
      cur = Math.max(0, Math.min(cur, rows.length - 1));
      rows.forEach((r, i) => r.el.classList.toggle('cur', i === cur));
      rows[cur]?.el.scrollIntoView({ block: 'nearest' });
    }

    function button(label, cls, onClick, title) {
      const b = el('button', cls, label);
      if (title) b.title = title;
      b.onclick = (e) => { e.stopPropagation(); onClick(e); };
      return b;
    }

    function matches(text, q) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const t = text.toLowerCase();
      return words.every((w) => t.includes(w));
    }

    function render() {
      root.querySelectorAll('.cmdp-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      tools.textContent = '';
      list.textContent = '';
      rows = [];
      const q = search.value.trim();
      if (tab === 'history') renderHistory(q); else renderSets(q);
      markCur();
    }

    function renderHistory(q) {
      const items = snap.history.filter((h) => !q || matches(h.cmd, q)).slice().reverse();
      for (const id of [...selected]) if (!snap.history.some((h) => h.id === id)) selected.delete(id);

      tools.append(
        el('span', 'cmdp-count', `${items.length}${q ? ' found' : ''} · ${selected.size} selected`),
        button('Save as set', 'small', () => {
          const chosen = snap.history.filter((h) => selected.has(h.id)).map((h) => h.cmd);
          openEditor(null, chosen);
        }, 'Create a saved set from the selected commands (in run order)'),
        button('Delete', 'small', () => { if (selected.size) { adapter.deleteHistory([...selected]); selected.clear(); } }, 'Delete selected'),
        button('Clear all', 'small danger', () => {
          if (snap.history.length && confirm(`Delete all ${snap.history.length} history entries? This cannot be undone.`)) { adapter.clearHistory(); selected.clear(); }
        }),
      );
      for (const b of tools.querySelectorAll('button')) if (b.textContent !== 'Clear all') b.disabled = !selected.size;

      if (!items.length) { list.appendChild(el('div', 'cmdp-empty', q ? 'No matching commands.' : 'No commands yet. Commands you run show up here.')); }
      for (const h of items.slice(0, 1000)) {
        const row = el('div', 'cmdp-row' + (selected.has(h.id) ? ' sel' : ''));
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(h.id);
        cb.onclick = (e) => { e.stopPropagation(); cb.checked ? selected.add(h.id) : selected.delete(h.id); render(); };
        const body = el('div', 'cmdp-body');
        body.append(el('div', 'cmdp-cmd', h.cmd), el('div', 'cmdp-meta', [timeAgo(h.ts), h.profile, h.count > 1 ? `×${h.count}` : '', h.source === 'web' ? 'web' : h.source === 'input' ? 'input box' : ''].filter(Boolean).join(' · ')));
        const acts = el('div', 'cmdp-acts');
        acts.append(
          button('▶', 'icon', () => adapter.run(h.cmd), 'Run now'),
          button('⎘', 'icon', () => navigator.clipboard?.writeText(h.cmd), 'Copy'),
          button('✕', 'icon', () => adapter.deleteHistory([h.id]), 'Delete'),
        );
        row.append(cb, body, acts);
        row.title = 'Click: put on the command line · Double-click: run';
        row.onclick = () => adapter.insert(h.cmd);
        row.ondblclick = () => adapter.run(h.cmd);
        list.appendChild(row);
        rows.push({ el: row, enter: () => adapter.insert(h.cmd), run: () => adapter.run(h.cmd) });
      }
      hint.textContent = '↑/↓ move · Enter inserts · Ctrl+Enter runs · double-click runs · tick commands then "Save as set"';
    }

    function renderSets(q) {
      const items = snap.sets.filter((s) => !q || matches(s.name + '\n' + s.commands.join('\n'), q));
      tools.append(el('span', 'cmdp-count', `${items.length} set${items.length === 1 ? '' : 's'}`), button('+ New set', 'small primary', () => openEditor(null, [])));
      if (!items.length) list.appendChild(el('div', 'cmdp-empty', q ? 'No matching sets.' : 'No saved sets yet. Click "+ New set", or tick commands in History and "Save as set".'));
      const profiles = adapter.profiles();
      for (const s of items) {
        const card = el('div', 'cmdp-set');
        const head = el('div', 'cmdp-set-head');
        head.append(el('div', 'cmdp-set-name', s.name), el('div', 'cmdp-meta', `${s.commands.length} command${s.commands.length === 1 ? '' : 's'}${s.profile ? ' · ' + (profiles.find((p) => p.id === s.profile)?.name || s.profile) : ''}`));
        const pre = el('div', 'cmdp-set-cmds');
        for (const c of s.commands.slice(0, 6)) pre.appendChild(el('div', 'cmdp-cmd', c));
        if (s.commands.length > 6) pre.appendChild(el('div', 'cmdp-meta', `+ ${s.commands.length - 6} more`));
        const acts = el('div', 'cmdp-set-acts');
        acts.append(
          button('▶ Run', 'small primary', () => adapter.runSet(s, { newTab: false }), 'Run all commands in the current terminal'),
          button('Run in new tab', 'small', () => adapter.runSet(s, { newTab: true }), 'Open a new tab (using the set\'s shell) and run'),
          button('Edit', 'small', () => openEditor(s)),
          button('Delete', 'small danger', () => { if (confirm(`Delete saved set "${s.name}"?`)) adapter.deleteSet(s.id); }),
        );
        card.append(head, pre, acts);
        card.ondblclick = () => adapter.runSet(s, { newTab: false });
        list.appendChild(card);
        rows.push({ el: card, enter: () => adapter.runSet(s, { newTab: false }), run: () => adapter.runSet(s, { newTab: true }) });
      }
      hint.textContent = '↑/↓ move · Enter runs the set · Ctrl+Enter runs it in a new tab';
    }

    function openEditor(set, commands) {
      editing = set;
      editor.querySelector('h3').textContent = set ? 'Edit set' : 'New set';
      editor.querySelector('.ed-name').value = set ? set.name : '';
      const sel = editor.querySelector('.ed-profile');
      sel.textContent = '';
      const any = el('option', null, 'Default shell');
      any.value = '';
      sel.appendChild(any);
      for (const p of adapter.profiles()) { const o = el('option', null, p.name); o.value = p.id; sel.appendChild(o); }
      sel.value = set ? set.profile || '' : '';
      editor.querySelector('.ed-cmds').value = (set ? set.commands : commands || []).join('\n');
      editor.classList.remove('hidden');
      editor.querySelector('.ed-name').focus();
    }
    function closeEditor() { editor.classList.add('hidden'); editing = null; }
    editor.querySelector('.ed-cancel').onclick = closeEditor;
    editor.querySelector('.ed-save').onclick = () => {
      const name = editor.querySelector('.ed-name').value.trim();
      const commands = editor.querySelector('.ed-cmds').value.split('\n').map((c) => c.trimEnd()).filter((c) => c.trim());
      if (!name) { editor.querySelector('.ed-name').focus(); return; }
      if (!commands.length) { editor.querySelector('.ed-cmds').focus(); return; }
      adapter.saveSet({ id: editing?.id, name, profile: editor.querySelector('.ed-profile').value, commands });
      closeEditor();
      tab = 'sets';
      selected.clear();
      render();
    };

    function open(which) {
      if (which) tab = which;
      root.classList.remove('hidden');
      render();
      search.focus();
      search.select();
    }
    function close() { root.classList.add('hidden'); closeEditor(); adapter.onClose?.(); }

    return {
      el: root,
      update(s) { snap = s; if (!root.classList.contains('hidden')) render(); },
      open,
      close,
      toggle(which) { if (root.classList.contains('hidden') || (which && which !== tab)) open(which); else close(); },
      get isOpen() { return !root.classList.contains('hidden'); },
    };
  }

  window.CommandCapture = CommandCapture;
  window.createCommandsPanel = createCommandsPanel;
  window.createHistoryNav = createHistoryNav;
})();
