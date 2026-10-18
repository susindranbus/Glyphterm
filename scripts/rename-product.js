// Rename the product everywhere in this repo (text only; rename the folder yourself afterwards).
// Usage: node scripts/rename-product.js <OldName> <NewName>     e.g.  node scripts/rename-product.js Glyphterm Acme
// Handles Capitalized, lowercase and UPPER forms, and collapses "<Old> Terminal" to "<New>".
const fs = require('fs');
const path = require('path');

const [oldName, newName] = process.argv.slice(2);
if (!oldName || !newName || !/^[A-Za-z][A-Za-z0-9]*$/.test(oldName) || !/^[A-Za-z][A-Za-z0-9]*$/.test(newName)) {
  console.error('Usage: node scripts/rename-product.js <OldName> <NewName>   (letters/digits only)');
  process.exit(1);
}
const cap = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', '.git', 'shots', '.playwright-mcp', 'dist', 'out']);
const pairs = [
  [`${cap(oldName)} Terminal`, cap(newName)],
  [cap(oldName), cap(newName)],
  [oldName.toLowerCase(), newName.toLowerCase()],
  [oldName.toUpperCase(), newName.toUpperCase()],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|css|md|cmd|json)$/i.test(e.name)) out.push(p);
  }
  return out;
}

let changed = 0;
for (const f of walk(root)) {
  if (path.basename(f) === 'rename-product.js') continue;
  const before = fs.readFileSync(f, 'utf8');
  let s = before;
  for (const [a, b] of pairs) s = s.split(a).join(b);
  if (s !== before) { fs.writeFileSync(f, s); changed++; }
}

const oldCmd = path.join(root, `${cap(oldName)}.cmd`);
if (fs.existsSync(oldCmd)) fs.renameSync(oldCmd, path.join(root, `${cap(newName)}.cmd`));
console.log(`Renamed ${cap(oldName)} -> ${cap(newName)} in ${changed} files. Now rename the project folder (and the repo on GitHub).`);
