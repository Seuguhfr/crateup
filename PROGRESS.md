# CrateUp — Project Progress

> Where the project stands, what works, what doesn't, and what's next.
> `SPEC.md` is the product spec (source of truth). `AGENTS.md` holds the
> session-by-session history. This file is the **current snapshot** — update
> it whenever the state changes.

Last updated: 2026-10-12 (comprehensive deep review & full hardening complete)

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
| JS tests | `npx jest` (17 suites / 47 tests passed) |
| Rust check | `cargo check` (run in `src-tauri/`; 0 warnings) |
| Rust tests | `cargo test` (in `src-tauri/`; 13 passed) |
| Dev app | `npm run tauri dev` |
| Release bundle | `npm run tauri build` |
| Python tests | `.venv/bin/pytest tests/` (8 passed) |

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

## 5. Done recently (deep review & hardening sweep)

- **Command injection eliminated**: Replaced `execSync` with `spawnSync(['-i', path])` in `node-sidecar/commit.js`.
- **macOS Trash integration**: Integrated `trash = "5.2"` crate in `src-tauri`. Audit deletions and Rekordbox backup cleanups/rollbacks now send files to Trash rather than unrecoverable deletion.
- **Sidecar & Python packaging resolution**: Configured dynamic candidate search for `python-sidecar` and Python binary in production bundle (`app.path().resource_dir()`) and dev environments across Rust and Node.
- **Code-generation & RPC hardening**: Migrated all Node RPC command calls from formatted string interpolations to strict `serde_json::to_string` serialization.
- **SQLCipher read-only direct reads**: Replaced static `/tmp` database copies with direct read-only SQLCipher connections, eliminating disk thrashing and concurrent file collisions.
- **XML entity decoding**: Attribute parsing unescapes XML entities (`&quot;`, `&apos;`, `&lt;`, `&gt;`, `&amp;`).
- **Compiler warnings cleared**: Fixed all compiler warnings across Rust modules (0 warnings).
- **Test testability & Python test suite**: Added `pytest.ini`. All tests pass across Rust (13 tests), Node/Jest (47 tests), and Python (8 tests).

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
