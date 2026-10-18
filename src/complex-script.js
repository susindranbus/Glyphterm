// Complex-script (Tamil / Indic / SE-Asian) rendering fix for xterm.js's DOM renderer.
//
// xterm.js gives every grapheme cluster a fixed number of cells and forces it to fit with
// negative letter-spacing, so wide scripts like Tamil overlap and conjuncts get split.
// After each row renders, we merge consecutive complex-script spans into one span (so the
// browser shapes the whole run with HarfBuzz) and scale it horizontally to occupy exactly
// the same cells. Grid geometry is unchanged, so TUIs (OpenCode, vim, etc.) stay aligned.
'use strict';

const COMPLEX_RE = /[ऀ-෿฀-໿က-႟ក-៿꣠-ꣿ𑀀-𑁿]/u;

function styleKey(span) {
  // Everything that would change appearance except the letter-spacing xterm computed per cluster.
  const s = span.style;
  return `${span.className}|${s.color}|${s.backgroundColor}|${s.fontWeight}|${s.fontStyle}|${s.textDecoration}`;
}

function fixRow(row) {
  const spans = Array.from(row.children);
  let i = 0;
  while (i < spans.length) {
    const first = spans[i];
    if (first.dataset.cx || !COMPLEX_RE.test(first.textContent)) { i++; continue; }
    const key = styleKey(first);
    const group = [first];
    let j = i + 1;
    while (j < spans.length && !spans[j].dataset.cx && styleKey(spans[j]) === key && COMPLEX_RE.test(spans[j].textContent)) {
      group.push(spans[j]);
      j++;
    }
    applyGroup(group);
    i = j;
  }
}

function applyGroup(group) {
  let target = 0;
  for (const s of group) target += s.getBoundingClientRect().width;
  const first = group[0];
  if (group.length > 1) {
    first.textContent = group.map((s) => s.textContent).join('');
    for (let k = 1; k < group.length; k++) group[k].remove();
  }
  first.dataset.cx = '1';
  first.style.letterSpacing = '0px';
  first.style.display = 'inline-block';
  first.style.width = '';
  first.style.transform = '';
  const natural = first.getBoundingClientRect().width;
  first.style.width = `${target}px`;
  first.style.overflow = 'visible';
  first.style.verticalAlign = 'top';
  // natural vs target width, handy for judging how hard a font has to be squeezed
  first.dataset.nat = natural.toFixed(1);
  first.dataset.tgt = target.toFixed(1);
  if (natural > target + 0.5) {
    first.style.transformOrigin = '0 50%';
    first.style.transform = `scaleX(${target / natural})`;
  }
}

/** Attach the fix to a terminal whose DOM renderer lives under `container`. Returns a disposer. */
function attachComplexScriptFix(container) {
  const pending = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    for (const row of pending) if (row.isConnected) fixRow(row);
    pending.clear();
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      const row = r.target.parentElement?.classList.contains('xterm-rows') ? r.target
        : r.target.classList?.contains('xterm-rows') ? null : r.target.closest?.('.xterm-rows > div');
      if (row) pending.add(row);
      if (r.target.classList?.contains('xterm-rows')) for (const n of r.addedNodes) pending.add(n);
    }
    // Run synchronously-ish before paint: microtask keeps the overlap from ever flashing.
    if (!scheduled && pending.size) { scheduled = true; queueMicrotask(flush); }
  });
  const start = () => {
    const rows = container.querySelector('.xterm-rows');
    if (!rows) { requestAnimationFrame(start); return; }
    mo.observe(rows, { childList: true, subtree: true, characterData: true });
    for (const row of rows.children) pending.add(row);
    flush();
  };
  start();
  return () => mo.disconnect();
}

window.attachComplexScriptFix = attachComplexScriptFix;
