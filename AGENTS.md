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
- Never run Git/GitHub commands (add, commit, checkout, merge, tag, push, etc.) without the user's explicit approval.

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
Implemented Raw Audio MD5 & Acoustic Fingerprinting Similarity Comparison with Collapsible Accordion Sidebar Grouping & Category Batch Actions:
- **Packaged AcoustID Chromaprint fpcalc**: Downloaded the universal macOS `fpcalc` binary, placed it in `src-tauri/binaries/fpcalc-aarch64-apple-darwin`, registered it in `src-tauri/tauri.conf.json` resources, and configured Node sidecar entry points to symlink/copy and place it on the system PATH.
- **Developed Audio Similarity Module**: Created `node-sidecar/similarity.js` containing:
  - Raw audio stream MD5 checksum generation via `ffmpeg` (mapping stream 0:a and output format md5) to detect bit-identical audio files.
  - Acoustic fingerprint extraction via `fpcalc -raw`.
  - A sliding popcount alignment algorithm that calculates a 0.0 - 1.0 (0% - 100%) bitwise similarity match score.
- **Integrated Similarity checks in Background Pipeline**: Updated `node-sidecar/pipeline.js` to calculate and store similarity properties (`similarity_score` and `audio_bit_identical`) for all fresh downloads and backfill missing data for previously downloaded files on pipeline reload.
- **Redesigned Sidebar Review list**: Grouped tracks into collapsible accordion categories based on similarity scores in `ui/index.html`:
  - **Identical Audio** (100% bit-identical PCM)
  - **Almost Identical** (95% - 99% match)
  - **Close Enough** (75% - 94% match)
  - **Potential Mismatch** (<75% match)
  - **Unresolved / No Upgrade** (unidentified/missing files)
- **Interactive Sidebar Accordion Features**:
  - Toggles collapse states on header clicks.
  - Renders color-coded similarity badges next to each track.
  - Implemented tiny high-contrast "Approve Remaining" / "Skip Remaining" batch buttons that execute decision updates only on pending tracks.
  - Programmed active track auto-expansion to expand the category accordion automatically if the loaded track is in a collapsed category.
- **Session Reset Dev Ledger Deletion Fix**: Updated the `reset_session` Rust backend command in `src-tauri/src/lib.rs` to check for and delete `.crateup-progress-dev.json` if it exists, ensuring both production and development ledgers are completely cleaned during session reset.
- **Resizable Review Sidebar Column**:
  - Increased default sidebar width from 340px to 400px.
  - Inserted a drag splitter element (`.sidebar-resizer`) between the left workspace and the right sidebar.
  - Bound mouse events to dynamically adjust the grid columns layout inline, clamping the width between 280px and 700px.
  - Ensured correct rendering behavior when moving between screens by clearing and restoring inline styles dynamically.
- **Verification**: Verified that Vite production build (`npm run build`), Jest tests (`npx jest`), and Tauri Rust compilation (`cargo test`) compile and pass 100%.

## Previous session
Mitigated File-System Limits & Naming Conflicts & Added Tier 3 Fuzzy Deduplication:

## Previous session
Fixed Multiline XML Track Element Ingestion & Consolidation & Added Duplicates Metric Card:
- **Fixed Multiline XML Track Element Ingestion & Consolidation**: Resolved the bug where Rekordbox library collections containing wrapped/multiline `<TRACK ...>` elements resulted in `0` successfully cloned tracks and `0` missing tracks.
- **Track Accumulator Stream Pattern**: Programmed both `parse_and_validate_xml_inner` (pre-scan verification) and `execute_safe_clone` (consolidation runner) in Rust to enter an accumulator mode upon encountering `<TRACK` and accumulate lines until the tag terminates with `>`.
- **Robust XML Parsing & Reconstruction**: Enabled extraction of track attributes (`Location`, `Artist`, `Name`, etc.) from the multiline accumulated tag string, and ensured the generated `crateup_collection.xml` preserves the original file structure, indentations, and format exactly byte-for-byte.
- **Added Duplicates Count Tracking**: Appended a `duplicate_count` property to `ResultPayload` returned by `execute_safe_clone` and updated the physical copy loop to increment the count when deduplication settings filter a track as a duplicate.
- **Updated Post-Flight Summary UI**: Integrated a third orange/accent metric card (`rebuilder-summary-duplicates`) in the metrics flex row on the summary screen to display exactly how many duplicate tracks were found and remapped.
- **Added Cargo Integration Unit Test**: Created `test_multiline_track_parsing` in the tests module in `src-tauri/src/lib.rs` verifying that multiline tags are correctly ingested.
- **Verification**: Verified that the entire project passes both Rust automated unit tests (`cargo test`), Node/JS Jest test suites (`npx jest`), compiles cleanly via `cargo check`, and bundles Vite successfully (`npm run build`).

## Previous session
Fixed Path Parsing, Physical File I/O, and Counter States in execute_safe_clone (Step 2.9):
- **XML Tag Attribute Parsing Fix**: Resolved the `0/0` progress counter display by extracting both `Entries` and `Total` attributes from the `<COLLECTION>` node.
- **Track Local Path & Existence Validation**: Implemented clean isolated prefix stripping (`file://localhost` and `file://`) and percent-decoding before conducting track file existence checks. Missing tracks correctly write the original line back untouched, increment `missing_count`, and skip the physical operations.
- **Directory Creation & I/O Loop Fix**: Ensured target subdirectories are created dynamically on demand via `std::fs::create_dir_all` before physical operations copy/rename/hardlink the files.
- **Remapped Database Locations**: Remapped the absolute path of successfully copied healthy tracks to a valid URL prefix format and wrote the modified `<TRACK Location="..." />` line into `crateup_collection.xml`.
- **Verification**: Verified that Vite production build (`npm run build`), Jest tests (`npx jest`), and Tauri Rust backend compilation (`cargo check`) compile and pass successfully.

## Previous session
Completed Final Feature Assembly for Library Cleaner (Dropdown Logic & XML Generation):
- **Upgraded execute_safe_clone Command Signature**: Expanded the Rust Tauri command to accept all configuration values (File Mode, Folder Architecture, Deduplication Depth, and Renaming Rules).
- **Implemented Renaming & Folder Architecture Rules**: Added metadata extraction (`Artist`, `Name`, `Tonality`, `AverageBpm`, `Year`), folder structures (`flat`, `key`, `bpm`, `year`), file modes (Copy, Move, Hardlink), and renaming rules (`preserve`, `clean`, `performance`).
- **Enforced Tier 1 Deduplication**: Checked track duplicates by file size/name combinations in a `HashSet` to skip redundant filesystem copies while keeping remapped XML indexes.
- **Created Updated Rekordbox Collection XML**: Generated a fully remapped `crateup_collection.xml` collection inside the output destination folder containing updated `<TRACK Location="..." />` paths.
- **Frontend Dropdown Binding**: Configured the frontend cloner invocation to pull selected option values from all 4 configuration dropdown inputs and invoke the cloner with them.
- **Verification**: Verified that Vite production build (`npm run build`), Jest tests (`npx jest`), and Tauri Rust backend compilation (`cargo check`) compile and pass successfully.

## Previous session
Implemented Post-Flight Summary Screen and Completed Rebuilder Loop (Step 2.8):

## Previous session
Implemented Core File Copying Loop for Safe Clone Mode (Step 2.7):
- **Tauri command registration**: Registered the `execute_safe_clone` asynchronous command in the invoke handler in `src-tauri/src/lib.rs`.
- **Copy Progress Events & Logging**: The safe clone command extracts track paths, checks existence, copies tracks to the target destination, and streams `consolidation-progress` events with file name, processed count, total count, and percentage.
- **Frontend IPC Integration**: Updated the click handler for the `CONSOLIDATE LIBRARY` button in `ui/index.html` to invoke the `execute_safe_clone` command with the selected XML and destination directory.
- **Real-Time Progress UI Rendering**: Added a frontend event listener for `consolidation-progress` to dynamically scale the progress modal percentage, horizon fill bar, processed/total counter, and the copying file status label in real-time.
- **Verification**: Verified that Vite production build (`npm run build`), Jest tests (`npx jest`), and Tauri Rust backend compilation (`cargo check`) compile and pass successfully.

## Previous session
Implemented checkbox and track count status indicator, progress overlay, and Rust stream parser for the Library Cleaner Rekordbox XML loader:
- **Clean Ingestion Feedback Loop (Step 2.6)**: Updated the XML loaded checkbox text format to display exactly `✅ Loaded Rekordbox [filename] ([total_tracks] tracks)` immediately after loading. Removed any intermediate loading status texts.
- **Under the Hood Quiet Pre-Scan**: Kicked off the backend XML parsing validation quietly in the background immediately upon loading/dropping the collection file, storing the resulting track list tallies safely in a global cache variable `rebuilderScanResult` and silencing console outputs / missing tallies until consolidation execution.
- **Consolidation Overlay Trigger**: Locked the `#rebuilder-progress-overlay` trigger exclusively to the `CONSOLIDATE LIBRARY` execution button, initializing the modal with `0%` progress bar, a monospace track count, and the status text `Preparing file pipeline...`.
- **Rust XML Stream Parser & Validation Command (Step 2.4)**: Developed a thread-safe `parse_and_validate_xml` Tauri command in Rust that opens the target Rekordbox XML with a buffered reader, extracts `<COLLECTION Total="X">` and `<TRACK ...>` location attributes, strips file protocols, decodes URL characters to check physical path existence, and aggregates healthy vs missing tallies.
- **Real-Time Progress Event Emissions**: Configured the validation loop to emit `xml-scan-progress` events containing live processed track tallies, track name, and percentage values back to the webview.
- **Frontend IPC Integration & Progress Binding**: Connected the `CONSOLIDATE LIBRARY` button to invoke `parse_and_validate_xml` and added a frontend event listener for `xml-scan-progress` to dynamically scale the progress overlay percentage, horizon filling track, counter lines, and current scanning file label in real-time.
- **Cleaner Progress Overlay UI (Step 2.3)**: Programmed and styled the `#rebuilder-progress-overlay` element with absolute positioning, a semi-transparent dark espresso tint, and backdrop-filter blurs. Perfect-centered a floating box holding a large numerical percent text, a progress bar track styled with `--paper-dark`, live tracking status subtext, and a cancellation trigger button.
- **Wider Progress Modal & Track Counter**: Increased the progress box `max-width` to `600px` to make the layout wider, and integrated a live track counter display (`id="rebuilder-progress-counter"`) styled in monospace `JetBrains Mono` rendering `0 / [total_loaded_tracks] tracks` upon starting consolidation.
- **Interactivity State Event Handlers**: Connected event listeners to toggle visibility: clicking `CONSOLIDATE LIBRARY` shows the overlay, and clicking `CANCEL CONSOLIDATION` immediately hides and resets the overlay elements back to initial defaults without clearing the user's selected configuration options and folder/file paths.
- **XML Track Counting Backend Command**: Created a fast `get_xml_track_count` command in `src-tauri/src/lib.rs` that reads the selected XML file and counts the occurrences of `<TRACK ` nodes.
- **Frontend Track Count API Integration**: Integrated a `getXmlTrackCount` helper in the UI to fetch the track count using the new Tauri command for file paths or standard HTML5 `File.text()` matching for dropped files.
- **Custom Checked Status Indicator & UI Reset**: Swapped the text-only loaded indicator with a custom checked status checkbox inside `#rebuilder-xml-drop-zone`. Style rules are fully compliant with the "Early Pressing" cream/espresso/orange color palette. Unchecking this status checkbox unloads the current XML, hides the checkbox status, restores the default drop-zone text prompt, and disables the execution trigger validation. The square checkbox input is styled with `display: none` to keep only the green checkmark emoji visible while preserving toggle clickability on the text label.
- **Navigation and Reset Sync**: Ensured `resetSessionUI()` clears the checkbox status container, restores the default zone text prompt, and resets the target file paths.
- **Verification**: Verified that Vite production build (`npm run build`), Jest tests (`npx jest`), and Tauri Rust backend compilation (`cargo check`) compile and pass successfully.

## Previous session - Hybrid Configuration Layout
Implemented Hybrid Configuration Layout for Library Cleaner Panel:
- **Library Cleaner View State & Layout (`#rebuilder-panel`)**: Created the full-width drag-and-drop zone container for collection XML files and the balanced two-column settings grid beneath it.
- **Top Section XML Drop Zone**: Programmed HTML5 drag-and-drop handlers (`dragover`, `dragleave`, `drop`) on the drop zone, and bound zone click triggers to invoke the custom backend file-picker Tauri command `select_xml_file`. Displays the selected filename inside the zone using the format `📂 Loaded [filename]`.
- **Left Column Configuration Selects**: Configured dropdown options for File Operation Mode, Target Folder Architecture, Deduplication Scan Depth, and Physical File Renaming Rules styled with high-contrast uppercase labels.
- **Right Column Destination & Action Hub**: Integrated the "Target Destination Folder" selector invoking Tauri's `select_directory` command and the path label displaying the chosen path.
- **Safety Switch Validation**: Configured the execution trigger button `CONSOLIDATE LIBRARY` to initialize completely disabled (styled as a muted grey block). Enabled the button automatically once both `selectedXmlPath` and `selectedDestinationPath` are populated, transforming its appearance to a high-contrast clickable button.
- **Home Reset Sync**: Configured the Home button navigation handler and `resetSessionUI()` function to clear all local cleaner variables and reset all HTML drop-zone and destination paths to their initial clean defaults.
- **Verification**: Verified that all Jest tests pass successfully, the frontend compiles cleanly under Vite (`npm run build`), and the Tauri Rust backend compiles successfully.

## Previous session - Home screen, launcher hub, navigation and styling
Implemented Modular App Launcher Hub and Isolated Quality Upgrader View:
- **Global Header & Navigation Re-engineering**: Introduced a transparent home navigation button (`⌂`) with a rounded border inside the logo container, displaying only when inside sub-module views, allowing navigation back to the app launcher dashboard view. Removed the global bottom footer area completely.
- **Modular App Launcher Hub (`#home-screen`)**: Created a side-by-side two-column card grid layout for Card 1 (Quality Upgrader) and Card 2 (Library Cleaner) styled with the "Early Pressing" background palette. Clicking Card 1 routes to the Quality Upgrader sub-module view, and clicking Card 2 routes to the Library Cleaner panel view. Both cards feature solid gold buttons (`var(--gold)`) with dark espresso text (`var(--espresso)`) and smooth brightness hover shifts.
- **Deezer ARL Isolation**: Relocated the Deezer ARL Token input, Toggle button, and Save button from the main landing page directly inside the Quality Upgrader landing screen (`#upgrader-landing-panel`), preserving all original DOM IDs so the underlying controllers remain intact.
- **Module Card Hover**: Removed the hover lift (`transform: translateY(-2px)`) from module launcher cards.
- **Typography**: Set up local "Playfair Display" font-family for the module titles (`.launcher-card h2`).
- **Handoff Exit Sync**: Programmed the Home button click to call `resetSessionUI()` to unload all active session variables and reset players when returning to the launcher hub.

## Previous session - WebAudio and WebKit fixes
Fixed WebAudio loading and WebKit blob fetch issues:
- Patched [ui/wavesurfer.js](file:///Users/hugues/Code/crateup/ui/wavesurfer.js) to fix the WebAudio player (class `E`) so that it doesn't fetch the blob URL a second time. Instead, it accepts the pre-fetched `Blob` from WaveSurfer, reads its arrayBuffer directly, and decodes it, preventing the 403/network block in WebKit/WKWebView.
- Reused the decoded player buffer (`this.media.buffer`) in `loadAudio` of WaveSurfer, completely eliminating double-decoding overhead.
- Added proactive `AudioContext` resumption inside the `play()` method in [ui/wavesurfer.js](file:///Users/hugues/Code/crateup/ui/wavesurfer.js) to resolve suspended state audio playback blockages under Safari/WebKit autoplay restrictions. Fixed a JS syntax error in the play method where `yield` was used inside a logical AND expression (`a && yield b`), which is invalid under WebKit because of operator precedence. We converted this expression to a clean `if` block, allowing the script to parse and initialize correctly.
- Reset the player's internal buffer (`this.buffer = null`) at the start of `setSrc` in [ui/wavesurfer.js](file:///Users/hugues/Code/crateup/ui/wavesurfer.js) so that the previous track's waveform does not linger or get reused when switching to the next track.
- Fixed a layout spacing bug in the keyboard shortcuts modal grid (`.help-grid`) where inline spaces next to `<strong>` tags collapsed inside WebKit flex containers. Resolved it by vertically aligning items at the grid level and restoring default block layout for individual cells.
- Modified standard Arrow Left / Right key seek intervals from 10 seconds to 5 seconds, and added Command / Control modifier combinations to allow high-speed seeks of 20 seconds. Updated the Keyboard Shortcuts help modal UI to display the new options.
- Configured the player focus to default to the Original (Top) Deck on track load rather than the Staged Upgrade (Bottom) Deck, ensuring a consistent starting deck for review.
- Verified that both the original library tracks and downloaded upgrades load, render, play, and seek in perfect sample-accurate synchronization.
- Confirmed all Jest and pytest automated test suites pass successfully.

## Previous session - Log event streaming and UI features
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

## Previous session
Completed final micro-layout refinements on the `style/early-pressing` branch:
- **Calibrated Text Colors & Focus Indicators Around Waveforms**: Forced all informational text, timestamps, format labels, loaders, spans, paragraphs, focus outline, focus dot, and play button borders/text for the Top Deck to strictly use the played progress color `var(--espresso)`. Mapped all corresponding typography, timers, unresolved error messages, loader tags, focus dot, and focus outline for the Bottom (Staged) Deck to explicitly use the vivid upgrade identity color `var(--accent)` (#B5410E).
- **Normalized Play/Pause Button Dimensions**: Locked `.deck-play-btn` bounds to a fixed width of `90px` and height of `28px` (using `padding: 0` and flex centering) to completely eliminate dimension adjustments from font bounding box differences between `▶ PLAY` and `⏸ PAUSE` symbols.
- **Calibrated Waveform Unplayed Background Color**: Swapped the unplayed waveform background color (`waveColor`) from the low-contrast `#c8b89a` (`var(--border-color)`) to a darker, highly visible `#8b6a45` (`var(--tan)`), providing sharp contrast against the `#DDD0B5` (`var(--paper-3)`) player canvas.
- **Enforced Full-Width Metadata Container**: Integrated `box-sizing: border-box` into the top `.track-meta-card` panel and verified it stretches to full horizontal width (`100%`) without container width constraints.
- **Compressed Central Comparison Matrix**: Transitioned the middle metadata comparison panel to a strict 3-column layout (`1fr auto 1fr`) with columns hugging text/split symmetrically. Tightened gap and padding values, and set its max-width footprint to none (with 100% width) to position keys and values tightly alongside their center bracket headers.
- **Calibrated Titlebar Buttons**: Programmed the **Reset Session** button with an imposing solid cream filled style (`var(--paper)`) and crisp dark text (`var(--espresso)`), and styled the **Shortcuts** toggle as a clean outlined pill shape (`var(--paper-3)` text, transparent background) with distinct hover states resolving text blinding. Verified that Shortcuts toggle visibility is correctly isolated to the Review screen.
- **Formatted Keyboard Shortcuts Modal & Replaced Missing Icons**: Expanded the Shortcuts modal container layout with `max-width: 650px`, padded bounds, scaled up typography size by 2 points (to 15px), and verified clean string spacing for descriptive phrases. Replaced the missing keyboard emoji icon `⌨` with the universally supported Option key glyph `⌥` to resolve tofu box rendering errors in standard WebKit WebViews.
- **Widened Download Page Format Selector**: Scaled the width of the Output Format drop-down menu on the download dashboard to `240px` to visually balance with the adjacent execution buttons.
- **Verification**: Verified that all backend/frontend packages compile cleanly and automated pytest and Jest test suites pass 100%.

## Previous session - Metadata leak and manual fetch fixes
Fixed a metadata display leak in the review screen when a track is not found:
- Reset the staged metadata comparison fields (`meta-staged-file`, `meta-staged-size`, `meta-staged-format`, `meta-staged-bitrate`, and `meta-staged-time`) to `'-'` at the beginning of `loadTrack` to ensure no metadata from the previously viewed track is displayed.
- Invoked `waveSurferStaged.empty()` at the start of `loadTrack` so that the bottom player's loaded audio and waveform canvas are cleared when switching to an unresolved track.
- Implemented backend Deezer metadata fetching in `node-sidecar/refetch.js` to bypass frontend WebView CORS limitations and correctly rename manually refetched files.
- Implemented original track filename fallback in both `node-sidecar/refetch.js` and `node-sidecar/pipeline.js` when track artist and title metadata cannot be resolved.
- Guarded `waveSurferStaged` event listeners (`ready`, `timeupdate`, and `decode`) in `ui/index.html` to return early if the track status is not downloaded. This keeps the staged duration display (`staged-time` and `meta-staged-time`) as `--:--` and `'-'` respectively, preventing the asynchronous `.empty()` loader from overwriting them with `00:00`.
- Updated manual track identification in `node-sidecar/identify.js` and `ui/index.html` to persist Shazam match results directly to the ledger on disk.
- Enhanced manual identify feedback to distinguish between `"✓ Found on Deezer"`, `"⚠ Identified, not on Deezer"`, and `"✗ Not identified"` statuses.
- Configured track review headers in `ui/index.html` to display the Shazam-identified song title and artist for unresolved/failed tracks if they exist in the ledger.
- Verified that all unit tests (Jest & Pytest) pass cleanly.

## Previous session
Implemented manual approval for unresolved tracks that have Shazam metadata:
- Updated `approveCurrent()` in [ui/index.html](file:///Users/hugues/Code/crateup/ui/index.html) to set `ledgerFile.decision = 'approved'` instead of falling back to `'skipped'` when the track status is not downloaded but valid Shazam metadata is present.
- Updated the keydown listener to allow using `Enter` to approve tracks that are not downloaded but possess Shazam metadata.
- Added a `#staged-unresolved-subtext` element inside the unresolved bottom deck placeholder to display the action instruction:
  - If Shazam metadata is present: `Press Enter to copy original file to output and write Shazam metadata ("Artist - Title"), or Backspace to skip metadata updates.`
  - If Shazam metadata is absent: `Press Backspace to skip (original file is still copied to output as-is)`
- Added a `keydown` handler on the `#manual-deezer-id-input` field so that pressing `Enter` inside it automatically unfocuses (blurs) the input field, stops keydown event propagation (preventing window-level shortcut triggers like auto-approval), and triggers the "Refetch" action by programmatically clicking `#refetch-deezer-id-btn`.
- Verified that all Node/JS Jest test suites and Python pytest test suites run and pass cleanly, and the Tauri Rust backend compiles successfully.



