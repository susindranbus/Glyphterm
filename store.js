// Command history + saved command sets, persisted to userData/commands.json.
// Shared by every window and every web client; onChange fires after each mutation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HISTORY_LIMIT = 5000;

module.exports = function createStore(file) {
  let data = { history: [], sets: [] };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const listeners = new Set();
  let saveTimer = null;

  const newId = () => crypto.randomBytes(6).toString('hex');
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 1));
    }, 300);
  };
  const changed = (what) => { save(); for (const fn of listeners) fn(what); };

  return {
    onChange: (fn) => listeners.add(fn),
    snapshot: () => ({ history: data.history, sets: data.sets }),

    addHistory({ cmd, profile, source }) {
      cmd = String(cmd || '').replace(/\r/g, '').trim();
      if (!cmd || cmd.length > 8000) return;
      const last = data.history[data.history.length - 1];
      if (last && last.cmd === cmd) { last.ts = Date.now(); last.count = (last.count || 1) + 1; }
      else data.history.push({ id: newId(), cmd, ts: Date.now(), profile: profile || '', source: source || 'terminal' });
      if (data.history.length > HISTORY_LIMIT) data.history.splice(0, data.history.length - HISTORY_LIMIT);
      changed('history');
    },
    deleteHistory(ids) {
      const set = new Set([].concat(ids));
      data.history = data.history.filter((h) => !set.has(h.id));
      changed('history');
    },
    clearHistory() { data.history = []; changed('history'); },

    saveSet({ id, name, profile, commands }) {
      const cmds = [].concat(commands || []).map((c) => String(c).replace(/\r/g, '')).filter((c) => c.trim());
      name = String(name || '').trim() || 'Untitled';
      const existing = id && data.sets.find((s) => s.id === id);
      if (existing) Object.assign(existing, { name, profile: profile || '', commands: cmds, updated: Date.now() });
      else data.sets.push({ id: newId(), name, profile: profile || '', commands: cmds, created: Date.now() });
      changed('sets');
    },
    deleteSet(id) { data.sets = data.sets.filter((s) => s.id !== id); changed('sets'); },
  };
};
