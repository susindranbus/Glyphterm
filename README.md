# Glyphterm

A Unicode-first, tabbed terminal for Windows with iTerm2-style split panes. It's built to render Tamil and other Indic scripts correctly, along with emoji and CJK.

## Run

- Double-click `Glyphterm.cmd`, or
- `npm start` (works from VS Code terminals too)

**Portable build (no install, no Node needed on the target PC):** `npm run package` creates `dist\Glyphterm-win32-x64\Glyphterm.exe`. Copy that folder anywhere and run the exe. Windows 10 (1809 or later) or Windows 11 is required.

## Why Tamil looks right here

- **Grapheme-aware widths** (xterm.js Unicode 15 graphemes). The terminal counts Tamil clusters the same way modern TUIs (OpenCode, Ink, Bubble Tea) do, so cursor positions stay in sync and you don't get the redraw garbage.
- **Shaped runs.** Each run of Tamil or Indic cells is drawn as one shaped text span using Nirmala UI, then scaled to fit its cells exactly. The grid stays aligned and the glyphs no longer overlap (`src/complex-script.js`).
- **Modern ConPTY.** It uses the bundled `conpty.dll` + `OpenConsole.exe` instead of the older built-in Windows console host, which handles Unicode and repainting much better.
- **UTF-8 shells.** PowerShell and cmd start in UTF-8 mode (code page 65001).

## Languages, fonts and "narrow" Tamil

**Which scripts work.** I tested Tamil, Hindi, Bengali, Telugu, Kannada, Malayalam, Gujarati, Punjabi, Sinhala, Thai, Lao, Khmer, Myanmar, Japanese, Chinese, Korean and emoji. All render with correct letter shapes.

- **Fonts:** the `fontFamily` stack in `settings.json` lists Latin fonts first, then one font per script family (Nirmala UI covers most South Asian scripts, Leelawadee UI covers Thai/Lao, and so on). Chromium also falls back to any other installed font on its own, so a script missing from the list still shows if Windows has a font for it. If you saved the old default stack, Glyphterm replaces it with the new one automatically.
- **Arabic and Hebrew** display, but a terminal grid has no right-to-left layout, so word order is not reversed and Arabic joining is limited.
- **🇮🇳 and other flag emoji** show as letters ("IN"). Windows ships no flag glyphs. This is the same in Windows Terminal.

**Why Tamil looks narrow.** A terminal gives each letter cluster one cell, the same width as an "i". Tamil clusters are about twice as wide as a Latin letter, so Glyphterm squeezes them sideways to fit (to about 54% of natural width at normal spacing). It has to keep one cell per cluster so that apps like OpenCode, PowerShell's line editor and ConPTY agree with the screen about where the cursor is. Giving Tamil two cells would make cursors and borders drift.

**What you can do about it: wider cells.** In the command palette (Ctrl+Shift+P) pick **Character spacing**: normal, +2, +4 or +6. It adds pixels to every cell, so Tamil is squeezed less. I measured how much squeeze remains:

| Spacing | Tamil width kept | Look |
|---|---|---|
| normal | 54% | compact, Latin text tight |
| +3 | 72% | good compromise |
| +6 | 91% | Tamil looks natural, Latin text looks spaced out |

It is saved as `letterSpacing` in `settings.json`, and you can set any number there.

## Shells (▾ menu, like Windows Terminal)

Shells are detected automatically: Windows PowerShell, Command Prompt, PowerShell 7, Developer Command Prompt / PowerShell for each Visual Studio install, Git Bash, WSL distros, Python, Node.js. Any custom profiles in your Windows Terminal `settings.json` are also included.
To add your own, put them in `settings.json` (Ctrl+,):

```json
"profiles": [{ "name": "My Tool", "commandline": "C:\\tools\\tool.exe --flag", "startingDirectory": "%USERPROFILE%" }]
```

Click a shell to open it in a new tab. Alt+Click opens it in a split pane.

## Direct input box (Ctrl+Shift+I)

This adds an optional text box under each pane, while the normal black terminal stays as it is. It gives you native Windows text editing: mouse caret, selection, Tamil IME, and shaped text.
Enter runs the line, Shift+Enter adds a new line, ↑/↓ steps through history, Ctrl+C interrupts, and Tab hands the line to the shell for completion.

**Multi-line:** Shift+Enter adds lines (the box grows to about 7 rows, then scrolls), and Enter runs them all in order. Script blocks such as `foreach (...) { ... }` work as one unit. Pasting several lines into the box keeps them. Multi-line commands are saved in History as one entry, and ↑ recalls the whole block (press ↑ again once the caret is on the first line to go further back).

## Keys: arrows, copy & paste

**Arrows**
- **In the terminal:** ←/→/↑/↓ go straight to the shell (PowerShell, cmd, bash history and line editing) or to the full-screen app.
- **In the input box:** ←/→ move the caret. ↑/↓ recall earlier commands from the shared history and keep your half-typed line. Press ↓ past the newest to get that line back.
- **In the history panel:** ↑/↓ move through the list, Enter inserts the command (or runs a set), and Ctrl+Enter runs it.

**Copy & paste**
- **Copy:** select with the mouse, then Ctrl+C (when text is selected), Ctrl+Shift+C, or right-click.
- **Paste:** Ctrl+V, Ctrl+Shift+V, or right-click (when nothing is selected).
- **No selection + Ctrl+C** interrupts the running command (^C).
- In the input box, Ctrl+Shift+C/V and right-click → Cut / Copy / Paste work on the box itself.

## History & saved command sets (Ctrl+Shift+H, or the 🕘 button)

**History.** Every command you run is recorded, whether you typed it in the terminal or used the input box. Commands typed inside full-screen apps (vim, OpenCode, …) are not recorded.

- Search the list.
- Click a command to put it on the command line. Double-click (or ▶) runs it.
- ⎘ copies a command and ✕ deletes it.
- Tick several and use **Delete** or **Save as set**. **Clear all** empties the list.

**Saved sets** are named groups of commands that run in order.

- **+ New set**, **Edit** and **Delete** manage them.
- **Run** uses the current terminal. **Run in new tab** opens the set's chosen shell first.

History and sets are stored in `%APPDATA%\glyphterm\commands.json`.

## Shortcuts

| Keys | Action |
|---|---|
| Ctrl+T / Ctrl+Shift+1…9 | New tab (default / specific shell) |
| Ctrl+Shift+D / Ctrl+Shift+E | Split side-by-side / top-bottom |
| Ctrl+Shift+W | Close pane |
| Ctrl+Shift+Enter | Maximize / restore pane |
| Alt+Arrows | Move between panes |
| Ctrl+Tab, Ctrl+1…9 | Switch tabs |
| Ctrl+Shift+N | New window |
| Ctrl+Shift+P | Command palette |
| Ctrl+Shift+H | History & saved command sets |
| Ctrl+Shift+F | Find |
| Ctrl+Shift+C / V, right-click | Copy / paste |
| Ctrl+= / - / 0 | Font size |
| Ctrl+Shift+R | Force repaint |
| Ctrl+, | settings.json |
| F1 | Shortcut help |

## Extensions

Glyphterm has a small extension API (see `host` in `main.js` and `window.GlyphtermExt` in `src/renderer.js`). An optional, separately licensed package called **Glyphterm Pro** plugs into it to add remote access (a browser terminal, LAN access). Everything in this repository works fully without it.

## Dev

`npm run shot` runs the app, works through the UI and saves screenshots to `./shots`. Set `GLYPHTERM_NO_PRO=1` to make sure the core runs on its own even if a Pro package sits next to it.
