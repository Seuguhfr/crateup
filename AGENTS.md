# CrateUp — Agent Briefing

## What this project is
A personal macOS desktop app (Tauri v2) that upgrades a DJ music library by:
1. Scanning a folder of audio files
2. Fingerprinting each track via Shazam (shazamio Python library)
3. Downloading high-quality replacements via Deezer (Deemix Python library)
4. Presenting each original/replacement pair for manual approval in a UI
5. Committing approved replacements to disk and updating a Rekordbox XML file

Full spec is in `SPEC.md`. Read it before touching any module.

## Tech stack
| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 (Rust) |
| UI | HTML + CSS + TypeScript (in Tauri WebView) |
| Backend logic | Node.js sidecar (spawned by Tauri) |
| Python bridge | Python 3.x sidecar (spawned by Node via stdio JSON-RPC) |
| Fingerprinting | shazamio (Python) |
| Downloading | Deemix core (Python) |
| Transcoding | FFmpeg (bundled binary) |
| Waveform UI | WaveSurfer.js |
| State | .crateup-progress.json (flat JSON ledger) |

## Repository structure (target — build toward this)
```
crateup/
├── AGENTS.md              ← this file
├── SPEC.md                ← full product spec (source of truth)
├── src-tauri/             ← Tauri/Rust shell
├── ui/                    ← HTML/CSS/TS frontend
├── node-sidecar/          ← Node.js pipeline orchestrator
│   ├── index.js           ← entry point, spawns Python sidecar
│   ├── scanner.js         ← directory traversal + ledger init
│   ← pipeline.js          ← orchestrates fingerprint → download loop
│   ├── commit.js          ← final file move + XML update
│   └── rpc.js             ← JSON-RPC helpers (Node ↔ Python)
├── python-sidecar/        ← Python fingerprint + download engine
│   ├── main.py            ← entry point, reads JSON-RPC from stdin
│   ├── fingerprint.py     ← shazamio wrapper
│   ├── download.py        ← deemix wrapper
│   └── throttle.py        ← rate limiting queues
├── test-library/          ← small folder of MP3s for manual testing
└── tests/                 ← automated tests
```

## IPC contract (Node ↔ Python) — NEVER change without updating both sides
All messages are newline-delimited JSON on stdio.

**Node → Python requests:**
```json
{ "id": "uuid", "method": "fingerprint", "params": { "path": "/abs/path/to/file.mp3" } }
{ "id": "uuid", "method": "download",    "params": { "deezer_id": 123456789, "output_format": "flac", "staged_path": "/abs/path" } }
{ "id": "uuid", "method": "ping",        "params": {} }
```

**Python → Node responses:**
```json
{ "id": "uuid", "result": { "deezer_id": 123456789, "title": "Track", "artist": "Artist" } }
{ "id": "uuid", "result": { "staged_path": "/abs/path/to/file.flac" } }
{ "id": "uuid", "error": "unidentified" }
{ "id": "uuid", "result": "pong" }
```

## Progress ledger schema (.crateup-progress.json)
```json
{
  "session_id": "<uuid>",
  "root_path": "/path/to/library",
  "output_format": "flac",
  "files": {
    "/relative/path/to/track.mp3": {
      "status": "pending | downloaded | unidentified | not_on_deezer | download_failed | committed | skipped",
      "deezer_id": 123456789,
      "staged_path": "crateup-staging/relative/path/to/track.flac",
      "proxy_path": null
    }
  }
}
```

## Coding rules (follow these in every file)
- Node.js: CommonJS (`require`), no TypeScript, ES2022 features OK
- Python: 3.11+, async/await with asyncio, type hints on all functions
- All file paths in the ledger are relative to `root_path`
- Never hardcode paths — always derive from `root_path`
- Every module must have a corresponding test file in `tests/`
- Tests use: Jest (Node), pytest (Python)
- Log format: `[YYYY-MM-DD HH:MM:SS] [MODULE] message`

## Current build status
<!-- Update this section at the end of every session -->
- [x] Phase 0: Project scaffold (Tauri skeleton + ping/pong IPC)
- [x] Phase 1a: Directory scanner + ledger init
- [x] Phase 1b: Python fingerprinting (single file)
- [x] Phase 1c: Deemix download (single file)
- [x] Phase 1d: Full pipeline loop with throttling
- [x] Phase 2: Verification UI (WaveSurfer players + keyboard shortcuts)
- [x] Phase 3: Commit phase + Rekordbox XML
- [x] Phase 4: Crash recovery + edge cases

## Session handoff protocol
At the END of every session, before quitting:
1. Update the "Current build status" checkboxes above
2. Add a "Last session" note below describing exactly what was done and what the next task is

## Last session
Fixed pipeline log event streaming between Rust Tauri backend and HTML/JS frontend:
- Replaced `.unwrap()` calls in `start_pipeline` in `src-tauri/src/lib.rs` with robust error handling and debug logging to stderr.
- Added explicit validation checks using `.exists()` for resolved pipeline paths (`pipeline_js` and `node_sidecar_dir`) in Rust before attempting to spawn the sidecar.
- Printed the exact command name, arguments, working directory, and environment `PATH` being used to spawn the sidecar to stderr.
- Configured real-time error piping to the frontend UI terminal if the child process fails to spawn, rather than panicking the Tokio worker thread.
- Updated `ui/index.html` to register the `pipeline-log` and `pipeline-done` listeners on page load immediately rather than only inside the button click handler, ensuring they are active before any invokes are executed.
- Added console logging to all incoming events to simplify UI diagnostics and verified correct WebView-to-Rust lifecycle.
- Confirmed that the `pipeline-done` listener successfully triggers UI panel transitions upon zero-exit codes.
- Replaced runtime resource resolution with compile-time `CARGO_MANIFEST_DIR`-based path mapping for `pipeline_js`, `node_sidecar_dir`, and `index.js` across `lib.rs` (`start_pipeline`, `run_node_script`, and `get_node_path`), ensuring the dev server correctly resolves resources outside the target binary folder.
- Fixed WaveSurfer local audio loading in WebView by correcting path conversions and wrapping in try-catch blocks with explicit console.error diagnostics. Configured correct system-wide absolute path glob scopes in `tauri.conf.json` (such as `"$HOME/**/*"` and `"/Users/**/*"`) for the custom `assetProtocol` to prevent Tauri from returning 403 Forbidden blocks.
- Implemented incremental review progress saving: added `save_ledger_decision` command in Rust and integrated `saveDecision()` in JS to update `.crateup-progress.json` incrementally, skipping already-decided tracks on reload and displaying live "X of Y reviewed" progress.
- Changed the commit phase to copy both committed upgrades and skipped/retained originals to a user-chosen output folder via a suggested directory picker, leaving original library files untouched.
- Updated `rekordbox.js` and `update_rekordbox` Rust commands to rewrite Location paths of all tracks (committed + skipped) to point to the output folder copies.
- Added a top completion banner ("All X tracks reviewed — Y approved, Z skipped. Ready to apply changes.") and pulse-glow styling for the "Apply All Changes" button when all tracks have decisions.
- Updated Jest and Pytest unit tests to match new output folder logic, verifying that all tests pass cleanly.

Diagnosed and fixed the staged audio loading 403 Forbidden issue in the WebView:
- Discovered that the `$HOME` variable was not supported in Tauri v2 `assetProtocol` scope configuration patterns, which invalidated the entire scope evaluation and returned 403 Forbidden for all file loading attempts.
- Reverted `tauri.conf.json` asset protocol scope to exactly `["**"]`, resolving all permission issues for the local directory loading.
- Reverted the manual `asset://` path construction back to the correct Tauri v2 `convertFileSrc()` API for both decks, ensuring clean absolute paths are used (`libraryRootPath + '/' + stagedRelPath` for the bottom deck).
- Cleaned up the UI by removing the `<div id="staged-diag">` element from `ui/index.html`, keeping the `check_file_exists` Rust command and redirecting WaveSurfer errors to the console instead of the UI.
- Confirmed that both top and bottom decks successfully load audio files and show waveforms.
- Re-ran Jest and Pytest unit tests, verifying that all tests pass cleanly.

Renamed staging folder from `.crateup-staging` to `crateup-staging` to resolve WKWebView restrictions:
- Renamed the directory to `crateup-staging` (removing the leading dot) globally in scanner, pipeline, commit, spec, and all unit tests.
- Updated directory scanning logic to explicitly ignore `crateup-staging` since it no longer starts with a dot.
- Implemented automatic ledger path migration in the backend `read_ledger_file` command. Any entries containing `.crateup-staging/` are migrated to `crateup-staging/` in memory and on disk upon being loaded.
- Added a temporary log in `ui/index.html` to output the final `asset://` URL for verification.

Fixed four display and pipeline bugs in the review UI and sidecar:
- Staged Filename: Extracted the staged filename from the ledger entry's `staged_path` field using basename logic and displayed it in the right [file] cell.
- Staged File Size: Correctly queried the staged file's size using the backend Tauri command `get_file_size` and displayed the formatted decimal MB value (rounded to 2 decimal places) in the right [size] cell without scope ReferenceErrors.
- Bitrate Row: Added a new `[kbps]` row between `[fmt]` and `[time]` in the metadata comparison grid. Populated it with original and staged bitrates, showing "lossless" for FLAC files and "X kbps" for other formats.
- Playhead Reset: Instantaneously reset both original and staged players' playheads to `0` and time display counters to `"00:00"` as soon as a new track pair starts loading.
- Unit Tests: Adjusted `tests/scanner.test.js` to expect the newly introduced `original_bitrate` field in ledger entries and verified all Jest and pytest tests pass cleanly.

Fixed staged filename naming and metadata bitrate issues:
- Staged Filename: Programmed the download pipeline to retrieve Deezer match metadata (artist and title) from the ledger, sanitize these values for macOS/Windows file paths, truncate combined names to a maximum of 150 characters, rename files to `{artist} - {title}.{ext}`, and record the correct path as `staged_path`.
- Bitrate Reading: Enhanced `getBitrate` inside `scanner.js` to run `ffprobe` with the `-show_format` option and implemented a fallback chain to extract the bitrate from `format.bit_rate` when `streams[0].bit_rate` is missing (as is often the case with MP3 files).
- Unit Tests: Adapted `tests/pipeline.test.js` to expect the updated metadata-based staged path and confirmed that both Jest and pytest suites pass cleanly.

Fixed path construction issues during the commit phase:
- Destination Path: Cleaned `relPath` by stripping leading slashes to prevent destination paths from resolving incorrectly or causing failures.
- Source Path: Modified `commit.js` to build `stagedAbsPath` using `path.join(rootPath, 'crateup-staging', path.basename(staged_path))` consistently across Phase A (standard copy), Phase B (clean up), and duplicate search helper `findStagedFileOnDisk`.
- Unit Tests: Adapted `tests/commit.test.js` to expect the duplicate track's committed name to be correctly placed using the new metadata-based staged basename, verifying all tests pass cleanly.

Added Rekordbox XML entry mode and playlist selection:
- Startup Modes (Phase A): Updated the app start state in `ui/index.html` to present two equally weighted options in the header: "Select Library Folder" and "Load Rekordbox XML". Hitting XML mode opens a native file picker filtered to `.xml` files.
- Playlist Tree Parsing & UI (Phase B & C): Handled parsing XML into a collapsible tree structure. Rendered the tree with customized, animated CSS styling for folders and playlists, track counters, and hover/selection colors matching the cyan theme deck.
- Playlist Path Extraction: Handled querying of absolute file paths using decoded/percent-decoded Collection `Location` URLs.
- Longest Common Ancestor Calculation: Calculated the derived `rootPath` as the longest common ancestor directory for all returned paths in the selected playlist.
- Explicit File List Scanning (Phase D): Configured the pipeline to scan the explicit list of absolute paths when `file_list` / `fileList` is provided, otherwise performing the default folder scan.
- Session Label (Phase E): Updated the header state to display the active playlist name and track count, e.g. `🎛 My Playlist (42 tracks)`, when in XML mode, keeping folder mode label behaviour consistent.
- Unit Testing: Expanded Jest test coverage inside `tests/scanner.test.js` to test the new `scanFileList` logic. All JavaScript and Python tests pass cleanly, and Rust compiles successfully.

UI and Session Management Improvements:
- Collapsed Playlist Tree: Configured folder nodes in the Rekordbox XML playlist picker tree to render collapsed by default, letting users expand them on demand by clicking the toggle arrows.
- Selectable Folders: Updated the tree rendering and `node-sidecar/rekordbox-parser.js` to support selecting folder nodes in addition to playlist nodes. Clicking a folder name processes all tracks recursively across all its descendant playlists. Added a `getFolderTracks` JSON-RPC method, tauri bridge command, and comprehensive unit test coverage.
- Session Reset: Added a "↺ Reset Session" button to the header top bar, visible only when a session is active. Clicking it displays a native Tauri confirm dialog and invokes a new Rust command `reset_session` that recursively cleans up the staging directory, ledger, and logs. It then gracefully restores the UI to the initial startup state.

Folder count, XML session storage, granular failure statuses, and manual Deezer ID entry:
- Folder track counts: Render total unique track counts recursively in the Rekordbox playlist picker tree next to folder nodes.
- Tauri App Data Session Storage for XML mode: Configured XML playlist mode to save session logs, `crateup-staging` files, and `.crateup-progress.json` to a timestamped subdirectory inside `~/Library/Application Support/CrateUp/sessions/...` rather than polluting the music library. Displayed the session directory path below the active playlist name in the header.
- Granular failure reason mapping: Distinguished and logged three failure modes (`unidentified`, `not_on_deezer`, `download_failed`) in the ledger and displayed specific grey, amber, and red badges respectively in the sidebar review queue.
- Manual track identification and refetch: Restored failed/unmatched tracks to the review queue so the user can play their original audio and manually intervene. Exposed a manual Deezer ID entry field and Refetch button for all queue items that fetches track metadata from Deezer's public API, invokes single-track downloading, updates the ledger, and hot-reloads the bottom player. Keyboard shortcuts (Space, Arrow keys, Backspace, Enter) are adjusted to control original audio playback for unmatched tracks, block shortcut operations when typing inside input fields, and disable Enter approval until a successful upgrade refetch.
- Verified that all unit tests (`npx jest` and `pytest`) pass cleanly.

## Previous session - Home screen, entry flow, and UX fixes
Redesigned the CrateUp home screen, entry flow, and layout, and subsequent UX testing fixes:
- **ARL Input Footnote**: Moved the Deezer ARL field to the very bottom of the home screen, directly above the version badge, and adjusted margins (`margin-top: auto; margin-bottom: 24px;` in CSS) so it serves as a settings footnote separate from the card mode flows.
- **Review Transition Fix**: Adjusted `processLedger()` to gather all tracks with resolved status (`downloaded`, `unidentified`, `not_on_deezer`, `download_failed`) or containing a valid decision.
- **Completed/Failed Sessions Handling**: Configured the pipeline completion handler to immediately transition to the review deck workspace on already-complete runs (such as resumes with 0 pending files) or show a prominent warning ("No tracks could be downloaded. Check the logs above.") on the pipeline card if all tracks failed, preventing empty views.
- **Testing & Verification**: Verified code compiles and all unit tests (`npx jest` and `pytest`) pass cleanly.
- **UX Fixes for Empty Placeholder & Completed Reload**: Removed the undefined `emptyPlaceholder` reference that crashed the review transition. Configured folder and playlist loading branches to show a cyan "Session complete" loading card and wrap the subsequent `processLedger()` call in a 50ms `setTimeout` yield to let WebView paint the loading text.

## Previous session - Cleanup and fingerprinting retries
Completed features and cleanup fixes:
- **Cleanups on Commit & Reset**: Programmed `commit.js` to delete `.crateup-progress.json` and `.crateup-log-*.txt` log files from the library/session folder upon successful completion of the commit phase.
- **Fingerprinting with Random Offset & Retries**: Enhanced `python-sidecar/fingerprint.py` to select a random 15-second audio sample starting between 20% and 75% of total track duration for Shazam recognition. Added robust error retry loops up to 3 times total on unidentified responses, updating corresponding pytest assertions to check retry coverage.
- **Manual Identify Button**: Added a "🔍 Identify" button to the manual track match header block in `ui/index.html`. Spawns a dedicated Node-to-Python bridge CLI wrapper (`node-sidecar/identify.js`) called via a new Rust Tauri command `identify_track` to finger-print the current track on-demand, populating the input field and providing visual feedback.
- **Tests & Verification**: Verified that all Jest and Pytest unit tests pass successfully.

## Previous session - Home screen and visual style improvements
Redesigned home screen and visual style improvements in `ui/index.html`:
- **Logo img Tag Swap**: Replaced the CSS-drawn `.logo-icon` box with an actual `<img>` tag pointing to `/icon.png` (using `src-tauri/icons/icon.png`) and removed the obsolete `.logo-icon` CSS styles.
- **Home Screen CTA Button Redesign**: Replaced the dual `.mode-card` cards structure with two large, stacked, direct CTA buttons with `max-width: 500px` and `height: 80px` (Import from Folder & Import from Rekordbox XML). Removed the home tagline paragraph completely and updated the cards container block to use a vertical column layout with `gap: 16px`. Preserved outer/inner element IDs (`folder-mode-card`, `folder-mode-btn`, `rekordbox-mode-card`, `rekordbox-mode-btn`) so JS flows remain fully wired.
- **Workspace Padding & Alignment Fix**: Added `padding-top: 8px;` to `.workspace` class. Updated `#deck-workspace` styles to use `display: flex;` instead of `height: 100%`, and added `padding-top: 16px;` to ensure consistent 24px spacing above the track header card.
- **Verification**: Confirmed all Jest tests pass cleanly and the Rust backend compiles successfully.

## Previous session - Configuration properties and logo src path
Fixed configuration properties and logo src path:
- **Logo Src Path Fix**: Updated the source path of the header logo in `ui/index.html` to point to `./icon.png` instead of the local src-tauri icons path.
- **Tauri Application Config Updates**: Updated `src-tauri/tauri.conf.json` configuration values:
  - Changed `"productName"` from `"tauri-app"` to `"CrateUp"`.
  - Changed `"identifier"` from `"com.hugues.tauri-app"` to `"com.custom.crateup"`.
  - Changed `"version"` from `"0.1.0"` to `"2.0.0"` to match version 2.0 displayed in the UI.
  - Verified `"title"` inside window configurations remains `"CrateUp"`.
- **Verification**: Verified that `ui/icon.png` exists and the Rust backend compiles cleanly.

## Previous session - Node spawn path resolution inside production bundle
Fixed production build: replaced `cp.spawn("node")` with `cp.spawn(process.execPath)` in `download_track_by_id` and `identify_track` inline scripts in lib.rs. Root cause: the stub binary at src-tauri/binaries/node-aarch64-apple-darwin was replaced with the real Node binary (cp $(which node)), and the two inline child_process spawns were updated to use process.execPath so they resolve correctly inside the Tauri bundle where node is not on PATH.

## Previous session
Fixed critical production-only bugs:
- **Statically Linked Node.js Sidecar**: Replaced the dynamically linked system Node binary at `src-tauri/binaries/node-aarch64-apple-darwin` (which crashed on dynamic linking to Homebrew's `libnode.141.dylib`) with an official precompiled static Node.js build (`v20.12.2`) from nodejs.org, resolving the runtime dyld crash.
- **Frontend Asset Pathing (`base: './'`)**: Configured the `base` property to `'./'` in `vite.config.ts` so that assets (fonts, images, scripts) load correctly under Tauri's embedded `tauri://localhost` and `https://tauri.localhost` web protocol.
- **Header Logo Explicit Sizing**: Added `.header-logo` class with explicit dimensions and `!important` declarations to the HTML and CSS blocks in `ui/index.html` to prevent production-only style regressions from blowing up the logo's width and height.
- **Verification**: Verified that all Jest and Pytest unit tests pass successfully, `cargo check` compiles, and `npm run tauri build` successfully builds both release bundles (.app and .dmg).

## Previous session
Fixed production environment bottlenecks and WebKit UI issues:
- **Fixed ffmpeg / ffprobe Environment Pathing**: Prepend the app bundle's Resources directory (`../Resources` relative to the Node executable) to `process.env.PATH` at the top of the entry points: [node-sidecar/pipeline.js](file:///Users/hugues/Code/crateup/node-sidecar/pipeline.js), [node-sidecar/identify.js](file:///Users/hugues/Code/crateup/node-sidecar/identify.js), and [node-sidecar/refetch.js](file:///Users/hugues/Code/crateup/node-sidecar/refetch.js). This ensures child processes (including Python/deemix and ffprobe/ffmpeg invocations) can resolve the bundled binaries in the standalone macOS app.
- **Fixed Environment Path Template Syntax & Triple Suffix Resolution**: Fixed a path template interpolation syntax in `node-sidecar/index.js` (and other node entry points) and added dynamic target-triple suffix identification (e.g., `-aarch64-apple-darwin` or `-x86_64-apple-darwin`) based on `process.arch` and `process.platform`. Programmatically created non-suffixed symlinks for `ffmpeg` and `ffprobe` pointing to the actual suffixed binaries from the Tauri resource path in a temporary folder (`os.tmpdir()/crateup-bin`), prepended it to `process.env.PATH`, and explicitly mapped target-suffixed binary copy directives using wildcards in `src-tauri/tauri.conf.json`.
- **Configured Tailwind CSS Safelist & Content patterns**: Created [ui/tailwind.config.js](file:///Users/hugues/Code/crateup/ui/tailwind.config.js) specifying all HTML/JS components inside the `ui/` folder in the `content` array to prevent aggressive production purging of dynamic styles and button templates.
- **Fixed WebKit Scroll Glitch & UI Sizing**: Configured the Rekordbox XML playlist tree container (`#playlist-tree-container` in [ui/index.html](file:///Users/hugues/Code/crateup/ui/index.html)) with explicit height limits (`flex: 1; min-height: 0; max-height: 450px;`) and forced WebKit touch scroll support (`overflow-y: auto !important; -webkit-overflow-scrolling: touch;`), resolving WebKit scroll lock issues inside the webview.
- **Verification**: Verified that all automated Jest tests and Python pytest test suites run and pass cleanly, the Rust backend compiles successfully via `cargo check`, and `npm run tauri build` successfully compiles and bundles the release versions (`CrateUp.app` and `CrateUp_2.0.0_aarch64.dmg`).
- **Enabled Standalone DevTools**: Added the `"devtools"` feature flags to the `tauri` dependency declaration in [src-tauri/Cargo.toml](file:///Users/hugues/Code/crateup/src-tauri/Cargo.toml#L21) to allow layout tracing in production standalone builds. Verified that the release compilation builds cleanly.
- **Offline-First Asset Localization & Custom CSP**: Downloaded WaveSurfer v7 minified source locally to `ui/wavesurfer.js` and resolved variable fonts (JetBrains Mono & Outfit) locally in `ui/fonts/` via custom `@font-face` rules. Configured a strict Content Security Policy meta-tag inside [ui/index.html](file:///Users/hugues/Code/crateup/ui/index.html) to greenlight Tauri's secure custom protocols, asset paths, and local styles while enforcing an entirely offline execution scope.
- **Isolated Development Ledger & Fixed Asset Style Interception**: Configured the frontend in [ui/index.html](file:///Users/hugues/Code/crateup/ui/index.html) to dynamically isolate its progress ledger by using `.crateup-progress-dev.json` when hosted on localhost or 127.0.0.1, resolving it dynamically using `check_file_exists`. Added `"dangerousDisableAssetCspModification": ["style-src"]` inside the `"security"` block under `"app"` in [src-tauri/tauri.conf.json](file:///Users/hugues/Code/crateup/src-tauri/tauri.conf.json#L21) to prevent style stripping. Added `asset:` to the `connect-src` CSP directives in both `tauri.conf.json` and `ui/index.html` to unblock audio waveform fetching streams. Verified both `npm run tauri dev` and `npm run tauri build` compile cleanly.
- **Port-Based Environment Detection & Backend Ledger Sync**: Refined dev mode detection to use a port evaluation check (`window.location.port !== ''`), preventing false positives in production standalone bundles. Corrected connect-src localhost wildcard syntax to `http://localhost:*` across both files. Updated the `node-sidecar/` pipeline files (`scanner.js`, `pipeline.js`, `refetch.js`) to dynamically resolve the progress ledger name (`.crateup-progress-dev.json` vs `.crateup-progress.json`) based on build environment directory existence, aligning with unit test modes (`process.env.NODE_ENV === 'test'`). Verified all unit tests pass cleanly.
- **Fixed development watcher reload loops and symlink mutations**:
  - Bypassed target file metadata rewriting via `fs.chmodSync` when `activeBinDir` points to `devBinDir` inside [node-sidecar/index.js](file:///Users/hugues/Code/crateup/node-sidecar/index.js), [node-sidecar/pipeline.js](file:///Users/hugues/Code/crateup/node-sidecar/pipeline.js), [node-sidecar/identify.js](file:///Users/hugues/Code/crateup/node-sidecar/identify.js), and [node-sidecar/refetch.js](file:///Users/hugues/Code/crateup/node-sidecar/refetch.js), preventing symlink mutation triggers to the parent binaries directory inside the repository.
  - Introduced a native watcher ignore file [src-tauri/.taurignore](file:///Users/hugues/Code/crateup/src-tauri/.taurignore) to explicitly ignore file attribute/metadata changes inside the `binaries/` directory.
  - Verified compiler integrity with a clean release build.
- **Unified ignore rule configuration and Vite watch list extension**: Updated the root [.gitignore](file:///Users/hugues/Code/crateup/.gitignore) to exclude Python caches, Rust target artifacts, test library structures, and the private credentials file (`.arl`). Extended the watcher ignore array inside [vite.config.ts](file:///Users/hugues/Code/crateup/vite.config.ts) to explicitly skip `src-tauri`, `test-library`, and `node-sidecar/node_modules` subdirectories, neutralizing file-watcher loops during development runtimes.

## Last session
Completely re-skinned the CrateUp application UI to the warm editorial "Early Pressing" look:
- Expanded `theme.extend.colors` inside [ui/tailwind.config.js](file:///Users/hugues/Code/crateup/ui/tailwind.config.js) to include the exact Early Pressing hardware-palette definitions (`paper`, `espresso`, `roast`, `accent`, etc.).
- Re-skinned the application shell and window capsule wrapper to use centered flex layout, `bg-espresso` body background, and `bg-paper` for the `.window` container with clean borders and deep shadow.
- Inverted the review queue sidebar container to run with `bg-espresso`, shifting track list nodes to clean typography, muted status borders, and the prominent orange highlight indicator for the active index track state.
- Re-architected the mid-section metrics panel into a fluid, responsive container using `bg-paper-dark` and a strict 7-column layout mapping comparative metadata fields linearly side-by-side.
- Repositioned the keyboard shortcuts HUD panel, converting it into an isolated card nested squarely underneath the bottom deck (staged upgrade player).
- Polished home screen buttons, warning/results/playlist modals, and loading spinners to use the warm paper theme variables, replacing all old neon blue and green colors.
- Applied layout refinements and Visual Enhancements to the "Early Pressing" look:
  - Maximized the container viewport boundary to occupy 100% of width and height fluidly (`100vw`/`100vh`), removing artificial margins, outer body padding, and hardcoded maximum widths.
  - Aligned and matched the block heights and padding matrices of the Output Format select dropdown and the primary "Start Scan & Download" execution button on the download screen.
  - Normalized waveform opacities to render both original and staged waveforms at full equal brightness, relying strictly on the color tokens to separate them.
  - Elevated the deck focused state by rendering a clear border highlight stroke (`var(--sand)` for original, `var(--accent)` for staged) and a glowing active focus dot indicator when active.
  - Extracted the keyboard shortcuts block into a clean, toggleable header modal with backdrop overlay, and disabled keyboard shortcut handling when the modal is displayed.
- Verified that all automated Jest tests and Python pytest test suites run and pass cleanly, the Rust backend compiles successfully, and `npm run build` compiles without issues.
- Completed final layout calibration and visual refinements for the "Early Pressing" look:
  - Synchronized WaveSurfer unplayed backgrounds (`waveColor`) to look identical using the exact `--border` token (`#C8B89A`), and mapped the active played progress (`progressColor`) to `var(--espresso)` (`#1A0F05`) for the Top Deck and `--accent` (`#B5410E`) for the Bottom Deck.
  - Forced text surrounding the Top Deck (labels, timecodes, format badges, and default play button) to use consistent matching typography (`var(--tan)` / `--mocha`), and forced Bottom Deck text to dynamically match the upgrade accent (`var(--accent)`).
  - Tightened the mid-section metrics comparison section to a maximum width of `480px` (centered) with collapsed empty voids to bring original/upgrade properties closer to their tags.
  - Forced the track metadata box card (`.track-meta-card`) at the top of the review column to stretch to full width (`100%`) with no margin/max-width limits.
  - Redesigned titlebar header buttons to fix contrast blinding on hover: created a prominent high-visibility solid cream background fill (`var(--paper)`) with dark text (`var(--espresso)`) for the Reset Session button, an outlined pill style with high contrast text for the Shortcuts button, and restricted the Shortcuts toggle button visibility to the Review Page section only.
  - Enhanced the Keyboard Shortcuts modal sizing (`max-width: 650px` with deep padding), bumped shortcut typography scales up by 1-2 points, and added explicit empty spacing between the bold key phrases and the descriptive brackets: `Approve Upgrade (Accepts replacement & advances)` and `Keep Original (Skips replacement & advances)`.
  - Expanded the Output Format selector dropdown width to `180px` on the download pipeline card to match next-door action buttons.

