# PassMan

PassMan is a minimal Manifest V3 password manager for Chrome. It stores username/password logins in one locally encrypted vault, provides user-initiated inline autofill, imports Chrome CSV exports, and can sync the same encrypted vault through the user's Google Drive `appDataFolder`.

## Develop and load

Requirements: Node.js 20+ and Chrome 120+.

```sh
npm install
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select either the project directory or its self-contained `dist/` directory.

There is no test framework by design. `npm run build` is the compile/bundle check. Source is plain JavaScript and the UI is plain HTML/CSS.

## Google OAuth development setup

Drive sync needs a Google Cloud OAuth client configured for the unpacked extension:

1. Create/select a Google Cloud project and enable **Google Drive API**.
2. Configure the OAuth consent screen. Add your Google account as a test user while the app is in testing.
3. Build/load PassMan and copy its extension ID from `chrome://extensions`.
4. Create a Chrome Extension OAuth client for that extension ID.
5. Replace the placeholder `oauth2.client_id` in `manifest.json` with the client ID, then rebuild and reload.

Only `https://www.googleapis.com/auth/drive.appdata` is requested. PassMan cannot read normal Drive documents. No PassMan server is involved.

## Architecture

- `src/background/service-worker.js` is the trusted core and the only code allowed to access extension storage.
- `src/crypto/` performs key derivation and authenticated encryption.
- `src/vault/` contains the small login model and persistent/session storage operations.
- `src/sync/` directly synchronizes one `passman.pm` file with Drive and performs a small three-way merge.
- `src/content/autofill.js` runs in Chrome's isolated world. It receives matching names/usernames only; it requests one password only after a user chooses it.
- `src/popup/` and `src/app/` provide the toolbar and management/onboarding UI.

Service-worker globals are not used for unlock state. The wrapped encrypted vault is in `chrome.storage.local`; the temporary vault key and timestamps are in `chrome.storage.session`. Both stores are immediately restricted to trusted extension contexts.

## Encryption

A new vault gets a random 256-bit vault key. The master password is processed with packaged `@noble/hashes` Argon2id (64 MiB, three iterations), and the result wraps the vault key using AES-256-GCM. The complete JSON payload is separately encrypted with that random key and a fresh 96-bit nonce on every write. Changing the master password only re-wraps the vault key. The master password and plaintext vault are never uploaded.

The encrypted envelope contains its format version, Argon2id parameters/salt, wrapped vault key, and encrypted payload. Manual `.pm` backups and Drive use this same authenticated encrypted envelope.

## Drive sync

The extension stores exactly one `passman.pm` in Drive's hidden `appDataFolder`. Local writes complete first, so Drive outages do not prevent password access. Before upload, PassMan reads the current Drive version. Divergent snapshots are merged by stable item ID against encrypted baseline fingerprints. Unrelated changes survive; simultaneous edits of one credential retain a visible `(sync conflict)` copy. Deletes are represented by encrypted tombstones. Conditional Drive writes are retried after downloading and merging a racing version.

## Permissions

- `storage`: encrypted persistent vault/settings and temporary unlock key.
- `activeTab`: show/fill passwords relevant to the tab where the toolbar was invoked.
- `favicon`: display Chrome's cached site icons beside saved logins without contacting arbitrary sites.
- `identity`: Chrome-managed Google OAuth.
- `alarms`: enforce inactivity locking despite service-worker suspension.
- `http://*/*`, `https://*/*` content-script matches: detect login fields and offer inline controls. The script cannot access extension storage and does not receive the full vault.
- `https://www.googleapis.com/*`: call Drive directly. OAuth limits access to this app's private Drive data.

## Known MVP limitations

- Inline detection intentionally handles conventional login/signup forms and top-level pages only; unusual shadow-DOM forms, cross-origin frames, and complex multi-page flows may need toolbar fill or manual management.
- Save/update prompts are based on form submission and cannot reliably determine whether every site accepted the login.
- Public-suffix-aware matching is not included; matching is conservative exact-host/subdomain matching and never downgrades an HTTPS credential onto HTTP.
- Drive conflict copies are resolved by editing/deleting the visible copy; there is no dedicated conflict wizard.
- Google OAuth must be configured per development extension ID. Chrome Web Store publication requires the corresponding production OAuth client and consent configuration.
- JavaScript cannot guarantee secure-memory zeroization; PassMan clears session key material on lock and avoids long-lived worker globals.
