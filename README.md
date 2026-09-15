# PassMan

PassMan is a small encrypted password manager with two clients:

- a Manifest V3 Chrome extension with inline browser autofill
- a static installable PWA for managing, copying, importing, exporting, and syncing the same encrypted vault

Both clients use the same encrypted envelope format, Argon2id/AES-GCM implementation, password generator, CSV importer, and Drive conflict merge logic. The PWA is deployed at `https://farzher.github.io/passman/`.

## Development

Requirements: Node.js 20+ and Chrome 120+.

```sh
npm install
npm run build
```

Useful targets:

```sh
npm run build:extension
npm run build:web
```

`npm run build` is the project compile/bundle check. There is intentionally no test framework.

### Chrome extension

`npm run build:extension` writes `dist/`. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select either the project directory or `dist/`.

The extension remains the only client that can provide browser-page autofill. Its background service worker owns extension storage and content-script requests.

### PWA

`npm run build:web` writes `dist-web/`. Serve that directory over HTTP(S) for local development. The PWA uses relative paths so the same output works at the GitHub Pages `/passman/` base path.

The web version supports:

- encrypted local persistence in IndexedDB
- reload/manual/inactivity locking with vault keys kept only in memory
- search, add, edit, delete, view, and explicit username/password copy
- the existing password generator and Chrome Password Manager CSV import
- encrypted `.pm` import/export
- Google Drive restore/sync through `appDataFolder`
- offline loading of the static application shell
- installation on supported desktop/mobile browsers

A PWA cannot register as a system password provider, so it cannot provide system-wide mobile autofill like a native password-manager app.

## Google OAuth

The extension OAuth client is configured in `manifest.json` and requests only:

`https://www.googleapis.com/auth/drive.appdata`

For the PWA, create a **Web application** OAuth client in the **same Google Cloud project as the extension OAuth client**. This is important because Drive `appDataFolder` is private to the application; using credentials from a different Cloud project can expose a different app-data space instead of the existing `passman.pm`.

PassMan expects OAuth clients from that same Cloud project to reach the same app-data space, but Google's public Drive documentation describes `appDataFolder` isolation at the application level rather than guaranteeing every cross-client/platform combination. Verify **Restore from Google Drive** succeeds in the PWA before relying on web sync. If the Web client is presented with a separate app-data space, the PWA cannot see the extension vault; PassMan will not overwrite an existing vault it can see.

Configure the Web client with this authorized JavaScript origin:

`https://farzher.github.io`

No client secret is used or required.

Set the public client ID as the repository Actions variable:

`PASSMAN_GOOGLE_CLIENT_ID`

The Pages workflow injects that value at build time. A local build can use:

```sh
PASSMAN_GOOGLE_CLIENT_ID="1234567890-example.apps.googleusercontent.com" npm run build:web
```

If the variable is absent, the PWA still builds and works locally with encrypted import/export; Drive buttons show a configuration error instead of risking a new or inaccessible vault.

The browser keeps Google access tokens only in memory. Tokens are never written to IndexedDB, localStorage, logs, backups, or the repository.

## GitHub Pages

`.github/workflows/pages.yml` builds both the extension and web targets on pushes and pull requests. On `main`, it uploads only `dist-web/` and deploys it through GitHub Pages.

If Pages has never been enabled for the repository, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions** once. The expected URL is:

`https://farzher.github.io/passman/`

## Architecture

- `src/background/service-worker.js`: extension-only trusted core and content-script message handling.
- `src/app/app.js`: shared management/onboarding UI. It receives a platform RPC adapter.
- `src/crypto/`: shared Argon2id and AES-GCM envelope implementation.
- `src/vault/`: extension storage/session handling and common model defaults.
- `src/sync/drive-core.js`: shared Drive `passman.pm` sync/restore/conflict logic.
- `src/sync/google-drive.js`: extension `chrome.identity` adapter.
- `src/web/`: IndexedDB/in-memory session adapter, Google Identity Services adapter, PWA shell, manifest, and service worker.
- `src/import/`: shared Chrome Password Manager CSV import.
- `src/shared/`: generator and utility functions.

The PWA intentionally does not use React, Vue, a router, a server, analytics, telemetry, remote fonts, or a third-party UI framework.

### Web origin isolation

GitHub project Pages are path-isolated but **not origin-isolated**: `https://farzher.github.io/passman/` shares the browser origin `https://farzher.github.io` with other repositories published at `farzher.github.io/<project>/`. Browser storage and same-origin page access are protected by origin, not path, so this is weaker isolation than a password manager should ideally use.

For real credentials, prefer deploying PassMan on a dedicated origin such as `https://passman.farzher.com/` and configuring the Web OAuth client for that origin. The GitHub Pages project URL is useful for development and can redirect to the isolated custom domain, but CSP cannot turn sibling paths on the same origin into separate security boundaries.

## Security model

A new vault gets a random 256-bit vault key. The master password is processed with packaged `@noble/hashes` Argon2id using 64 MiB memory and three iterations. That derived key wraps the vault key with AES-256-GCM. The complete JSON vault payload is separately encrypted with the random vault key and a fresh 96-bit nonce on every write.

The encrypted envelope contains its format version, Argon2id parameters/salt, wrapped vault key, and encrypted payload. `.pm` backups and Drive use this exact same authenticated envelope. Plaintext credentials and master passwords are never uploaded.

The extension persists only the encrypted envelope/settings and keeps the temporary unlock key in Chrome session storage. The PWA persists only the encrypted envelope/settings in IndexedDB and keeps the unlock key in JavaScript memory, so a reload locks the vault. Manual lock and inactivity timeout clear key references where JavaScript permits.

JavaScript cannot guarantee physical secure-memory zeroization. PassMan overwrites mutable `Uint8Array` key buffers when practical and avoids persisting decrypted payloads, master passwords, vault keys, or OAuth tokens.

## Drive sync

PassMan stores exactly one `passman.pm` in Drive's hidden `appDataFolder`. Local writes complete first. Before upload, PassMan reads the current Drive version. Divergent snapshots are merged by stable item ID against encrypted baseline fingerprints. Unrelated changes survive, simultaneous edits retain a visible `(sync conflict)` copy, deletes use encrypted tombstones, and conditional writes retry after downloading a racing version.

First-time Drive setup never overwrites a discovered remote vault. If `passman.pm` already exists and the current client has no established Drive version, PassMan requires restoring the existing vault instead.

## Offline behavior

The PWA service worker caches only the static application shell on the same GitHub Pages origin. Google Identity Services and Drive API responses are never put into the service-worker cache. Drive operations naturally require a connection, while an already-created local encrypted vault remains usable offline after the page shell loads.
