@echo off
rem Launch Glyphterm. ELECTRON_RUN_AS_NODE (set by VS Code terminals) would make Electron run as plain Node.
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
