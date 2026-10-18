// Build a portable Windows folder containing Glyphterm.exe. Nothing needs to be installed on the target PC:
// copy the folder (or zip it) and run Glyphterm.exe.
//
//   npm run package            ->  dist\Glyphterm-win32-x64\Glyphterm.exe   (the free core)
//
// The paid build that also contains Glyphterm Pro is made by the Pro repository's own build script.
const path = require('path');
const { packager } = require('@electron/packager');

async function buildCore(outDir) {
  const root = path.join(__dirname, '..');
  const out = path.resolve(outDir || path.join(root, 'dist'));
  const [appPath] = await packager({
    dir: root,
    out,
    name: 'Glyphterm',
    executableName: 'Glyphterm',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    prune: true, // production dependencies only (no Electron copy inside the app, no packager)
    // Keep the files plain: the terminal backend ships helper programs (conpty.dll, OpenConsole.exe) that must sit
    // on disk rather than inside an archive.
    asar: false,
    ignore: [/^\/dist($|\/)/, /^\/shots($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/, /^\/\.playwright-mcp($|\/)/, /^\/\.gitignore$/, /^\/package-lock\.json$/],
  });
  return appPath;
}

module.exports = { buildCore };

if (require.main === module) {
  buildCore(process.argv[2]).then((p) => console.log('Built:', p)).catch((e) => { console.error('Build failed:', e.message); process.exit(1); });
}
