import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
await mkdir('dist/assets', { recursive: true });
await build({ entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', bundle: true, platform: 'node', packages: 'external', format: 'esm', target: 'node22', banner: { js: '#!/usr/bin/env node\nimport {createRequire} from "node:module"; const require = createRequire(import.meta.url);' } });
const common = { bundle: true, platform: 'browser', format: 'iife', target: ['chrome110', 'firefox115', 'safari17'], minify: true, legalComments: 'inline' };
await build({ ...common, entryPoints: ['src/viewer/app.ts'], outfile: 'dist/assets/viewer.js' });
await build({ ...common, entryPoints: ['src/viewer/worker.ts'], outfile: 'dist/assets/worker.js' });
await build({ ...common, entryPoints: ['src/viewer/city/worker.ts'], outfile: 'dist/assets/city-worker.js' });
await build({ entryPoints: ['src/relations/extract-worker.ts'], outfile: 'dist/assets/extract-worker.mjs', bundle: true, platform: 'node', packages: 'external', format: 'esm', target: 'node22' });
await build({ ...common, entryPoints: ['src/viewer/graph-worker.ts'], outfile: 'dist/assets/graph-worker.js' });
let css = await readFile('src/viewer/style.css', 'utf8');
for (const [family, pkg, file] of [['Geist', 'geist', 'geist-latin-wght-normal.woff2'], ['Geist Mono', 'geist-mono', 'geist-mono-latin-wght-normal.woff2']]) {
  const font = await readFile(`node_modules/@fontsource-variable/${pkg}/files/${file}`);
  css = `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${font.toString('base64')}) format('woff2');font-style:normal;font-weight:100 900;font-display:swap}\n${css}`;
}
await writeFile('dist/assets/viewer.css', css);
await copyFile('src/viewer/shell.html', 'dist/assets/shell.html');
const notices = [];
// Include attribution for every shipped runtime dependency, including parser and font licenses.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
for (const [location, info] of Object.entries(lock.packages)) {
  if (!location || info.dev) continue;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'OFL.txt']) {
    try { notices.push(`${location}\n${await readFile(path.join(location, name), 'utf8')}`); break; } catch {}
  }
}
await writeFile('dist/assets/notices.txt', notices.join('\n\n---\n\n'));
console.log('Built CLI and fully embedded viewer assets.');


