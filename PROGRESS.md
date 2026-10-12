# CrateUp — Project Progress

> Where the project stands, what works, what doesn't, and what's next.
> `SPEC.md` is the product spec (source of truth). `AGENTS.md` holds the
> session-by-session history. This file is the **current snapshot** — update
> it whenever the state changes.

Last updated: 2026-10-12 (deep review remediation: duration matching, tag merging, proxy alignment, DB sync & tests)

## 1. What this project is

Personal macOS desktop app (Tauri v2) that upgrades a DJ music library:

1. Scan a folder of audio files → 2. Fingerprint each track (Shazam via
   `shazamio`) → 3. Download high-quality replacements (Deezer via Deemix)
   → 4. Manual approve/skip per pair in the UI → 5. Commit to disk + update
   Rekordbox (XML export and/or live `master.db`).

Secondary tools: Library Cleaner (consolidate + dedupe), Playlist Ingestion
Hub (loose tracks → clean playlist), Playlist Compare (diff two playlists),
Library Audit (enforce folder-database invariants).

## 2. How to run / verify

| What | Command (repo root unless noted) |
|---|---|
| UI typecheck + build | `npm run build:ui` (`tsc -p ui/tsconfig.json` → `ui/out/main.js`; no bundler) |
| Setup Python runtime | `npm run setup:python` (bootstraps standalone CPython 3.12 for Apple Silicon) |
| JS tests | `npx jest` (17 suites / 51 tests passed) |
| Rust check | `cargo check` (run in `src-tauri/`; 0 warnings) |
| Rust tests | `cargo test` (in `src-tauri/`; 17 passed) |
| Dev app | `npm run tauri dev` |
| Release bundle | `npm run tauri build` (produces self-contained `.app` and `.dmg`) |
| Python tests | `python-runtime/bin/pytest tests/` (9 passed) |

Screenshots can't be seen in chat — the workflow is: save to `screenshots/`
(gitignored) and read via the Read tool.

## 3. Tool status (the honest matrix)

| Tool | Native UI | Backend | Verdict |
|---|---|---|---|
| Quality Upgrader | ✅ Full arc: source → configure → run → results → review → commit (`ui/src/upgrader/`, review.ts 1521 lines) | ✅ pipeline/scanner/commit + Python bridge | **Working** (user-confirmed) |
| Playlist Compare | ✅ Real view (`ui/src/compare/view.ts`, XML + db + folders + acoustic match + "Upgrade these" handover) | ✅ `compare_playlists_acoustic` + parsers | **Working** (needs user field-test) |
| Library Audit | ✅ Enforce library-folder ⟺ db invariant: leftovers (dupe-of vs orphan), stray hardlink twins per folder with found/total coverage, outside/missing db info, confirmed delete (fail-closed re-verify) + empty-folder removal (`ui/src/audit/`, `src-tauri/src/audit.rs`) — full sessions | ✅ `audit_library`, `delete_audit_paths`, `remove_empty_folders`, `audit_suggested_roots` | **Working** (needs user field-test) |
| Library Cleaner | ✅ Native arc: strategy → intake (XML validate / db status + repair) → modifiers → run → summary + backup safety (`ui/src/cleaner/`) — full sessions (sidebar live progress, done records, resume restores summary; delete keeps dest folder) | ✅ `execute_safe_clone`, `execute_db_consolidation`, backups, rollback, cleanup (in `xml.rs`/`rekordbox.rs`) | **Working** (needs user field-test) |
| Ingestion Hub | ✅ Native workbench: drop/click staging + folder expand, name autofill, dest, shared modifiers, XML-save-picker-first run, summary (`ui/src/ingestion/`) — full sessions (live progress, restorable summary, delete keeps outputs). **Library check**: staged songs already in `master.db` link to their existing file (exact path / filename+size / artist+title / fuzzy+fp-confirm, stale rows ignored, self-path guarded) — zero copies, zero duplicate entries on import | ✅ `execute_playlist_ingestion` (+ threshold, `library_check`, `library_matched_count`), `select_audio_files`, `expand_audio_paths`, `select_save_xml_file` | **Working** (needs user field-test) |
| Settings | ✅ Real screen (threshold, library root, format, ARL, cache storage, reset) | ✅ prefs + `fingerprint_cache_info`/`clear_fingerprint_cache` | **Working** (user verified via screenshot) |
| Home / shell | ✅ Sidebar, sessions list, theme, router | n/a | Working |

Legacy UI (`ui/legacy.html`) still exists; only consolidation progress events
live there. Native shell consumes `pipeline-log/done` + `compare-acoustic-progress`.

## 4. Backend module map

**Rust (`src-tauri/src/`, `lib.rs` 983 lines):**

| Module | Contents |
|---|---|
| `lib.rs` | Tauri setup, pipeline/commit/download/identify, ledger R/W, ARL, dialogs, `compare_playlists_acoustic`, safe trash helper, sidecar resource path resolution, `run()` + handler |
| `xml.rs` (1995 lines) | Playlist/tree RPC delegates, `get_xml_track_count`, parse/validate, `execute_safe_clone`, ingestion, `get_audio_metadata`, XML unescaping, shared `ResultPayload` / `ConsolidationProgressPayload` |
| `rekordbox.rs` (1279 lines) | All `master.db` (SQLCipher) reads, consolidation, backups, cleanup, duplicate repair, `update_rekordbox_db_directly`, read-only connection pool & lock fallbacks |
| `similarity.rs` (422 lines) | fpcalc/ffmpeg resolution, MD5, similarity, greedy match, `ACOUSTIC_SIMILARITY_THRESHOLD = 0.90`, quality helpers |
| `fingerprint_cache.rs` | Persistent JSON cache (path+mtime+size keyed), wired into all 4 fpcalc paths |
| `audit.rs` (547 lines) | Library audit, hardlink twin sweeps, trash-based deletion, empty folder cleanup |

**Node (`node-sidecar/`):** `pipeline.js` (fingerprint→download loop, throttles),
`scanner.js` (scan + `initLedger`), `commit.js` (takes explicit ledger path; safe spawnSync, moved staging fallback),
`identify.js`, `refetch.js`, `ledger.js` (shared filename resolution +
mtime-checked read-through cache, `LEDGER_VERSION = 1`), `bin-setup.js`
(shared binary bootstrap), `similarity.js`, `rekordbox-parser.js`, `rpc.js`
(candidate python/main.py path resolution).

**Python (`python-sidecar/`):** `main.py`, `fingerprint.py` (random-offset
15s sample, 3 retries), `download.py`, `throttle.py`. Configured via `pytest.ini`.

**Ledger** (`.crateup-progress.json`, or `-dev` variant in dev): stamped
`ledger_version: 1` by both node and Rust; unknown top-level fields
preserved. Per-track writes preserved (crash recovery). Node filename logic
lives in exactly one place (`ledger.js`); commit.js resolves via caller.

## 5. Done recently (deep review remediation & stability sweep)

- **Multi-release duration matching (§3.5 SPEC.md)**: Updated `search_deezer` in `python-sidecar/fingerprint.py` to compare candidate track durations against probed original duration and pick the release with minimal absolute delta, preventing radio edits from replacing extended club mixes. Added automated Pytest test suite.
- **Original metadata tag merging (§5.1 SPEC.md)**: Implemented `getAudioTags` and `mergeOriginalTags` in `node-sidecar/commit.js` to extract original comments, genres, and ratings via FFprobe and transplant them into staged replacements before atomic swap into place. Added unit tests in `tests/commit.test.js`.
- **AIFF proxy MP3 filename alignment**: Synchronously renamed `.proxy.mp3` waveform preview files alongside their main staged audio files in `node-sidecar/pipeline.js` and `node-sidecar/refetch.js`.
- **Rekordbox technical audio properties sync**: Updated `update_rekordbox_db_directly` in `src-tauri/src/rekordbox.rs` to write actual replacement `FileSize` and `BitRate` to `djmdContent` with automatic fallback to path-only updates.
- **Comprehensive SQLCipher unit test suite**: Implemented in-memory SQLCipher test suite in `src-tauri/src/rekordbox.rs` covering duplicate content merging, intelligent playlist-weighted duplicate cleanup, and database backup verification (17 Rust tests passed).
- **Atomic in-place metadata tagging**: Removed `fs.unlinkSync` prior to `fs.renameSync` in `node-sidecar/commit.js`, ensuring atomic POSIX file replacement without intermediate deletion windows.
- **Post-verification duplicate deletion**: Reordered duplicate swapping in `src-tauri/src/xml.rs` and `src-tauri/src/rekordbox.rs` so that `crate::safe_delete_file(p_path)` executes only after the replacement file has successfully written to disk, preventing data loss if disk operations fail.
- **SQLite WAL checkpoint status verification & backup safety**: Implemented `create_master_db_backup()` in `src-tauri/src/rekordbox.rs` to verify the `PRAGMA wal_checkpoint(TRUNCATE)` return code. If the WAL cannot be truncated, automatically preserves `master.db.backup_<timestamp>-wal` alongside the main database backup, and restores or removes it accurately on rollback.
- **Child process leak elimination**: Added explicit `child.kill()` in `src-tauri/src/xml.rs` (`run_pipeline_rpc`) to terminate spawned Node processes upon receiving JSON responses.
- **Path traversal & staging escape prevention**: Sanitized `stagedAbsPath` base filenames in `pipeline.js` and `refetch.js` by stripping climbing `..` and `.` segments; prioritized `entry.original_abs_path` in `pipeline.js`, `refetch.js`, and `identify.js` to ensure reliable handling of tracks located outside `root_path`.
- **In-place replacement data-loss eliminated**: Removed pre-rename `fs.unlinkSync` in `node-sidecar/commit.js`, switching to atomic POSIX `fs.renameSync` directly and moving original files to Trash only after target rename succeeds when paths differ.
- **AIFF proxy MP3 cleanup**: Added `cleanProxyFile` in `node-sidecar/commit.js` to clean up leftover waveform `.proxy.mp3` files in both commit and skip phases.
- **Deterministic backup timestamps**: Switched `src-tauri/src/rekordbox.rs` backup timestamping to use `/bin/date` with epoch nanoseconds fallback, preventing static `"unknown"` filename collisions.
- **Restored Chromaprint similarity precision**: Removed aggressive 8-frame grid skipping and anchor heuristics in `src-tauri/src/similarity.rs` that caused false negative 0.0 matches, preserving exact bit-budget early-pruning and density filtering.
- **Atomic ledger saves**: Updated `node-sidecar/ledger.js` to write to a temporary file (`.tmp.${pid}.${Date.now()}`) and rename atomically into place.
- **Instantaneous audio duration probe**: Switched `python-sidecar/fingerprint.py` from decoding streams via pydub to fast `ffprobe` container header inspection with `ffmpeg -i` fallback.
- **Safe URI decode**: Wrapped `decodeURIComponent` in try/catch in `node-sidecar/rekordbox-parser.js` for non-UTF-8 Latin-1 paths.
- **Pipeline cancellation & process management**: Added `PipelineManager` in `lib.rs` and `cancel_pipeline` command. Exposed `cancelPipeline` in UI and added "Stop pipeline" button to run screen dock with ledger preservation and partial review capability. Added SIGTERM/SIGINT listeners in `pipeline.js`.
- **Ledger dev/prod resolution sync**: Unified `resolveLedgerFilename()` in `node-sidecar/ledger.js` to `.crateup-progress.json` with override and fallback, resolving dev/prod ledger desynchronization.
- **Node-Python RPC timeouts**: Added 180s timeout timers to `node-sidecar/rpc.js` to prevent hangs.
- **Cross-filesystem file move fallback**: Added `safe_move_file` in Rust to handle `EXDEV` across filesystems gracefully in XML and Rekordbox migrations.
- **Rekordbox commit alignment & Unicode fallback**: Updated Rekordbox direct sync to use committed output and original paths from ledger, with Unicode-normalized case-insensitive fallback.
- **WAL checkpointing & backup safety**: Added `PRAGMA wal_checkpoint(TRUNCATE)` prior to copying `master.db` backups and cleared stale `-wal` and `-shm` files on rollback.
- **Deemix subprocess timeout**: Added 180s `asyncio.wait_for` timeout in `python-sidecar/download.py` with process termination.
- **Review player watchdog cleanup**: Managed `watchdogTimer` in `ui/src/upgrader/review.ts` with explicit cleanup on track switches and `leaveReview()`.
- **Scanner command injection eliminated**: Replaced `child_process.execSync` shell string interpolation in `node-sidecar/scanner.js` with safe `execFileSync('ffprobe', [...args])`.
- **Similarity duration discrepancy patched**: Ported 20% max-length difference tolerance filter into `node-sidecar/similarity.js` so 30-second clips cannot falsely match full-length tracks.
- **Commit error data-loss prevented**: Hardened `ui/src/upgrader/review.ts` so that if Rekordbox database sync throws an error, the session ledger is preserved and `finishSession()` does not delete `.crateup-progress.json`.
- **Non-blocking Rekordbox read-only queries**: Updated `list_library_entries` and `execute_backup_cleanup` in `src-tauri/src/rekordbox.rs` to route through `with_rekordbox_query_conn`, avoiding database lock collisions while Rekordbox is open.
- **Command injection eliminated**: Replaced `execSync` with `spawnSync(['-i', path])` in `node-sidecar/commit.js`.
- **macOS Trash integration**: Integrated `trash = "5.2"` crate in `src-tauri`. Duplicate replacements, audit deletions, and Rekordbox backup cleanups/rollbacks now send files to Trash.
- **Sidecar & Python packaging resolution**: Configured dynamic candidate search for `python-sidecar` and Python binary in production bundle (`app.path().resource_dir()`) and dev environments across Rust and Node.
- **Code-generation & RPC hardening**: Migrated all Node RPC command calls from formatted string interpolations to strict `serde_json::to_string` serialization.
- **SQLCipher read-only direct reads**: Replaced static `/tmp` database copies with direct read-only SQLCipher connections, eliminating disk thrashing and concurrent file collisions.
- **XML entity decoding**: Attribute parsing unescapes XML entities (`&quot;`, `&apos;`, `&lt;`, `&gt;`, `&amp;`).
- **Compiler warnings cleared**: Fixed all compiler warnings across Rust modules (0 warnings).
- **Test testability & Python test suite**: Added `pytest.ini`. All tests pass across Rust (13 tests), Node/Jest (49 tests), and Python (8 tests).

## 6. Known issues / tech debt

1. `git rm --cached` never run for `tmp/` + `screenshots/` (binaries stay
   tracked — required to build).
2. `clean_fuzzy` in `xml.rs` has `#[allow(dead_code)]` with dedicated unit test.
3. No automated visual tests — manual screenshots only.
4. `AGENTS.md` "Last session" history is very long; treat it as append-only log.

## 7. What's next (ordered)

1. Release dmg smoke test (`npm run tauri build`).
2. Field-test Compare end-to-end (XML + db + acoustic + handover).
3. Real-library upgrader field test + Rekordbox round-trip.
4. Small hygiene: `git rm --cached` for untracked cache files when permitted.
   redundant rebuilds.

## 8. Session protocol

At end of every session: update this file's snapshot (§3/§6/§7) + append the
`## Last session` note in `AGENTS.md` + tick its checkboxes.
