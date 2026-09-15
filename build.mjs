import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/background/service-worker.js', 'src/content/autofill.js', 'src/popup/popup.js', 'src/app/app.js'],
  outdir: 'dist', outbase: 'src', bundle: true, format: 'esm', target: 'chrome120', minify: false,
  loader: { '.txt': 'text' }
});
// The root manifest loads the built files from dist/. A self-contained copy of
// dist/ can also be loaded directly in Chrome.
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
manifest.background.service_worker = manifest.background.service_worker.replace(/^dist\//, '');
manifest.action.default_popup = manifest.action.default_popup.replace(/^dist\//, '');
for (const size of Object.keys(manifest.icons || {})) manifest.icons[size] = manifest.icons[size].replace(/^dist\//, '');
for (const size of Object.keys(manifest.action.default_icon || {})) manifest.action.default_icon[size] = manifest.action.default_icon[size].replace(/^dist\//, '');
manifest.options_page = manifest.options_page.replace(/^dist\//, '');
for (const script of manifest.content_scripts) script.js = script.js.map(path => path.replace(/^dist\//, ''));
await writeFile('dist/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
await cp('src/popup/popup.html', 'dist/popup/popup.html');
await cp('src/app/app.html', 'dist/app/app.html');
await cp('src/ui.css', 'dist/ui.css');
await cp('src/app.css', 'dist/app.css');
await cp('src/icons', 'dist/icons', { recursive: true });
console.log('Built PassMan in dist/');
