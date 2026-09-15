import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const mode = process.argv[2] || 'all';

async function assertPng(path, expectedWidth, expectedHeight) {
  const bytes = await readFile(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) throw new Error(`${path} is not a valid PNG.`);

  let offset = 8, width, height, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > bytes.length) throw new Error(`${path} is truncated.`);
    if (type === 'IHDR') {
      if (length !== 13) throw new Error(`${path} has an invalid PNG header.`);
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
    }
    offset = next;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || offset !== bytes.length) throw new Error(`${path} is truncated or malformed.`);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`${path} must be ${expectedWidth}x${expectedHeight}, got ${width}x${height}.`);
  }
}

async function buildExtension() {
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist', { recursive: true });
  await build({
    entryPoints: ['src/background/service-worker.js', 'src/content/autofill.js', 'src/popup/popup.js', 'src/app/app.js'],
    outdir: 'dist',
    outbase: 'src',
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    minify: false,
    loader: { '.txt': 'text' }
  });

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
  console.log('Built PassMan extension in dist/');
}

async function buildWeb() {
  await rm('dist-web', { recursive: true, force: true });
  await mkdir('dist-web/icons', { recursive: true });
  const clientId = process.env.PASSMAN_GOOGLE_CLIENT_ID || '';
  await assertPng('src/web/icons/icon-192.png', 192, 192);
  await assertPng('src/web/icons/icon-512.png', 512, 512);

  await build({
    entryPoints: { app: 'src/web/web.js' },
    outdir: 'dist-web',
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: false,
    loader: { '.txt': 'text' },
    define: { __PASSMAN_GOOGLE_CLIENT_ID__: JSON.stringify(clientId) }
  });

  await cp('src/web/index.html', 'dist-web/index.html');
  await cp('src/web/manifest.webmanifest', 'dist-web/manifest.webmanifest');
  await cp('src/web/sw.js', 'dist-web/sw.js');
  await cp('src/web/icons', 'dist-web/icons', { recursive: true });
  await cp('src/ui.css', 'dist-web/ui.css');
  await cp('src/app.css', 'dist-web/app.css');

  const output = await readFile('dist-web/app.js', 'utf8');
  if (/\bchrome\.(?:runtime|storage|identity|alarms)\b/.test(output)) {
    throw new Error('Web build contains unresolved chrome.* usage.');
  }
  const html = await readFile('dist-web/index.html', 'utf8');
  if (/href="\/(?!\/)|src="\/(?!\/)/.test(html)) {
    throw new Error('Web output contains root-relative paths that would break under /passman/.');
  }

  console.log(`Built PassMan PWA in dist-web/ (${clientId ? 'Google Drive configured' : 'local-only until PASSMAN_GOOGLE_CLIENT_ID is set'})`);
}

if (mode === 'extension') await buildExtension();
else if (mode === 'web') await buildWeb();
else if (mode === 'all') {
  await buildExtension();
  await buildWeb();
} else {
  throw new Error(`Unknown build target: ${mode}`);
}
