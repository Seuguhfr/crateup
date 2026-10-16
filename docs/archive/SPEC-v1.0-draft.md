# CrateUp — Technical Specification

**Version:** 1.0  
**Status:** Draft  
**Scope:** Personal use only. This application relies on unofficial third-party wrappers (shazamio, Deemix) that likely conflict with Deezer's and Shazam's Terms of Service. It must not be distributed, sold, or monetized in any form. Users assume full legal responsibility for their use.

---

## 1. Overview

CrateUp is a lightweight desktop application for macOS (primary target) and Windows (secondary). Its purpose is to automate the collection-wide replacement of low-quality audio files with high-quality versions — MP3 320 kbps, FLAC, AIFF, or WAV — while preserving the user's folder taxonomy and deep Rekordbox metadata (hot cues, beat grids, and loops).

The application operates in two sequential phases:

- **Phase 1 — Background Engine:** scans the library, fingerprints tracks, downloads high-quality replacements into a local staging cache.
- **Phase 2 — Verification UI:** presents each original/replacement pair for manual review before any file on disk is modified.

Files are only written to disk after the user completes the full review loop and confirms a final commit.

---

## 2. Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Desktop shell | **Tauri** (v2) | Rust core, system WebView, ~10 MB binary |
| UI | TypeScript + HTML5 + CSS | Rendered in system WebView via Tauri |
| Backend logic | Node.js (via Tauri sidecar) | Manages pipeline orchestration |
| Python bridge | Python 3.x (multiprocessed) | Spawned as a sidecar subprocess; communicates with Node via stdio JSON-RPC |
| Fingerprinting | `shazamio` | Unofficial Python wrapper for Shazam audio identification |
| Download engine | Deemix Core (Python) | Powered by user-supplied Deezer ARL credential |
| Transcoding | Embedded FFmpeg binary | Bundled with the application; used for AIFF proxy MP3 extraction |
| State ledger | Flat JSON (`.crateup-progress.json`) | Written to the scanned root directory |

### Node ↔ Python IPC

Node.js spawns the Python process as a long-lived sidecar and communicates via **stdio JSON-RPC**. Each message is a newline-delimited JSON object with a `method`, `id`, and `params` field. Responses include the same `id` for correlation. If the Python process crashes or exits unexpectedly, the Node layer logs the error, surfaces a recoverable error state in the UI, and attempts one automatic restart before requiring the user to restart the session manually.

---

## 3. Operational Pipeline

### Phase 1 — Background Engine

#### 3.1 Directory Discovery

The user selects a root directory. The engine performs a deep recursive traversal, building a memory-mapped list of all audio file paths (`.mp3`, `.flac`, `.aiff`, `.wav`, `.m4a`) and their relative positions within the folder hierarchy. This hierarchy is preserved verbatim throughout the entire pipeline.

#### 3.2 Smart-Slice Fingerprinting

For each file, a 15-second audio sample is extracted and sent to the Shazam fingerprinting pipeline via `shazamio`:

- If the file duration is **greater than 3 minutes**, the sample starts at `02:00`.
- If the file duration is **3 minutes or less**, the sample starts at `00:30`.

The start offset is calculated against the file's actual decoded duration, not its metadata duration field (which may be inaccurate in low-quality files).

#### 3.3 Anti-Ban Throttling

To protect the user's IP address and accounts from automated-request detection, two independent throttle queues are maintained:

- **Shazam queue:** 3–7 second randomized delay between consecutive Shazam calls.
- **Deezer/Deemix queue:** 3–7 second randomized delay between consecutive Deezer calls.

The two queues operate concurrently but independently. Delay values are drawn from a uniform random distribution on each call.

#### 3.4 Deduplication

Before dispatching a Deemix download, the engine checks the current session's lookup table for the resolved Deezer track ID. If a duplicate is found:

- The download is skipped.
- The engine notes that it will clone the already-downloaded staging file to the duplicate's target staging path during the commit phase.
- If the user rejects one instance of a duplicate during the UI review loop, only that instance's commit is cancelled. The other instance is unaffected.

#### 3.5 Multi-Release Duration Matching

When a Deezer search returns multiple releases of the same track, the engine selects the release whose total runtime has the smallest absolute delta (Δ) compared to the original file's duration. This minimizes the risk of selecting an edit, radio mix, or extended version when the original was a standard cut.

#### 3.6 Staging Cache

Matched tracks are downloaded into a staging directory located at:

```
<scanned_root>/crateup-staging/
```

The staging directory mirrors the user's folder hierarchy exactly, so relative paths are preserved. If the user selected **AIFF** as the output format, FFmpeg immediately extracts a lightweight proxy MP3 from the staged AIFF file. This proxy is stored alongside the AIFF file (same name, `.proxy.mp3` suffix) and is used exclusively by the Phase 2 UI player. It is deleted during the commit phase.

#### 3.7 Progress Ledger & Crash Recovery

All pipeline state is written incrementally to `.crateup-progress.json` in the scanned root. The ledger schema is:

```json
{
  "session_id": "<uuid>",
  "root_path": "/path/to/library",
  "output_format": "flac",
  "files": {
    "/relative/path/to/track.mp3": {
      "status": "downloaded | unidentified | not_on_deezer | pending | committed | skipped",
      "deezer_id": 123456789,
      "staged_path": "crateup-staging/relative/path/to/track.flac",
      "proxy_path": null
    }
  }
}
```

If the application crashes mid-batch and is relaunched, it detects the existing `.crateup-progress.json`, reads all entries with `status: downloaded`, and skips re-downloading those files. Fingerprinting and downloading resumes from the first entry with `status: pending`. The user is shown a notification: *"Previous session detected. Resuming from track N of M."*

#### 3.8 Phase 1 Failure Handling

| Scenario | Engine Action | Ledger Entry |
|---|---|---|
| Shazam fingerprint fails | Mark file; copy original to target at commit | `"status": "unidentified"` |
| Track identified but absent on Deezer | Mark file; copy original to target at commit | `"status": "not_on_deezer"` |
| Deemix download times out | Retry once after 10 seconds; if still failing, mark as `not_on_deezer` | `"status": "not_on_deezer"` |
| FFmpeg proxy extraction fails (AIFF only) | Log error; UI player falls back to native AIFF decode | Noted in ledger under `"proxy_path": null` |
| Python sidecar crash | Node surfaces error to UI; attempts one auto-restart | Session paused; user notified |

---

### Phase 2 — Verification UI

Phase 2 activates once Phase 1 completes. The UI presents each track pair sequentially. No files are written to disk until the user completes the full review loop and triggers the final commit.

#### 3.9 Waveform Display

Two independent waveform players are rendered side-by-side using the **WaveSurfer.js** library on an HTML5 Canvas:

- **Top player:** the original low-quality file.
- **Bottom player:** the staged high-quality file (or proxy MP3 if the output format is AIFF).

Waveforms are generated on demand as each track pair loads. Both players start in a paused state.

#### 3.10 Independent Playback & Focus Model

The two players operate completely independently — neither play, pause, nor seek state is linked. **Focus** determines which player responds to keyboard events:

- Focus is assigned to whichever player the user most recently clicked or interacted with via keyboard.
- On initial load of each track pair, focus defaults to the **bottom (new) player**.
- The currently focused player is indicated by a visible highlight border.

#### 3.11 Keyboard Shortcut Matrix

| Key | Action | Scope |
|---|---|---|
| `Space` | Toggle play / pause | Focused player |
| `↑` | Transfer focus to original (top) player | Global |
| `↓` | Transfer focus to new (bottom) player | Global |
| `←` | Seek −15 seconds | Focused player |
| `→` | Seek +15 seconds | Focused player |
| `Enter` | **Approve upgrade** — mark track for replacement, advance to next | Global |
| `Backspace` | **Keep original** — mark track to be skipped, advance to next | Global |

#### 3.12 WAV Format Warning

If the user selected WAV as the output format, a non-blocking warning modal is shown once at the start of Phase 2:

> *"Warning: WAV files do not reliably support custom ID3 tags. Genre, rating, and comment fields may be dropped by your playback software. Consider using FLAC for lossless quality with full tag support."*

The user dismisses this modal manually. It does not appear again in the same session.

#### 3.13 Tracks Unresolved in Phase 1

Tracks flagged `unidentified` or `not_on_deezer` are shown in the review UI with a visual badge indicating their status. No waveform comparison is available for these tracks. The user may press `Enter` to confirm keeping the original (the only available action), or `Backspace` which produces the same result.

---

## 4. Final Commit

The commit phase executes only after the user has reviewed every track in the queue and explicitly triggers *"Apply All Changes"* from the UI.

### 4.1 Commit Sequence

For each track marked **approved**:

1. Read its entry from `.crateup-progress.json`.
2. Delete the original file from disk.
3. Move the staged high-quality file from `crateup-staging/` to the original file's location, with the new file extension.
4. If the output format was AIFF, delete the `.proxy.mp3` sidecar from staging.
5. Update the ledger entry to `"status": "committed"`.

For each track marked **skipped** (Backspace) or unresolved:

1. The original file is left untouched on disk.
2. Any staged file for that track is deleted from `crateup-staging/`.
3. The ledger entry is updated to `"status": "skipped"`.

For duplicate tracks (see §3.4): the first approved instance is moved from staging. Subsequent approved instances are cloned from the first committed file rather than moved.

### 4.2 Post-Commit Cleanup

Once all entries are resolved, the `crateup-staging/` directory is deleted in its entirety. The `.crateup-progress.json` ledger is retained for reference and logging purposes.

### 4.3 Commit Failure Handling

If a file move fails (e.g. permissions error, disk full):

- The error is logged to a visible session log in the UI.
- The commit continues for remaining tracks.
- A summary modal at the end lists all tracks that failed to commit, with their error reasons.
- No automatic retry is attempted; the user must resolve the underlying issue and re-run CrateUp.

---

## 5. Metadata

### 5.1 Tag Merge Rules

When a track is approved for upgrade, tags are merged according to the following priority table:

| Tag Field | Source | Notes |
|---|---|---|
| Title | Deezer | Overwrites original |
| Artist | Deezer | Overwrites original |
| Album | Deezer | Overwrites original |
| Year | Deezer | Overwrites original |
| Cover Art | Deezer | Overwrites original |
| BPM | Deezer | Overwrites original |
| Key | Deezer | Overwrites original |
| Track Number | Deezer | Overwrites original |
| Comments | Original file | Deezer value ignored |
| Genres | Original file | Deezer value ignored |
| Star Rating | Original file | See §5.2 |

If a Deezer-sourced field is absent or empty, the original file's value for that field is retained.

### 5.2 Star Rating Encoding

Star ratings are not a standardized ID3 field. CrateUp reads and writes ratings using the `POPM` (Popularimeter) frame, which is the encoding used by Rekordbox. Ratings from other encodings (iTunes `rtng`, Serato internal tags) are not read or written.

### 5.3 Format-Specific Tag Handling

| Format | Tag Container | Notes |
|---|---|---|
| MP3 | ID3v2.4 | Full tag support |
| FLAC | Vorbis Comments | Full tag support |
| AIFF | ID3v2.4 (embedded) | Full tag support |
| WAV | ID3v2.4 (embedded) | Unreliable; user warned at Phase 2 start |

---

## 6. Rekordbox Integration

### 6.1 Workflow Overview

```
Rekordbox → Export XML → Load into CrateUp → Processing → rekordbox_upgraded_<YYYY-MM-DD>.xml → Import into Rekordbox
```

CrateUp does not interface directly with the Rekordbox application or database. All integration is performed via Rekordbox's XML export/import bridge.

### 6.2 XML Ingestion

The user exports their collection as an XML file from Rekordbox (*File → Export Collection in xml format*) and loads it into CrateUp before the commit phase. CrateUp parses all `<TRACK>` nodes, indexing each by its `Location` attribute (a fully URL-encoded local file path string, e.g. `file://localhost/Users/user/Music/track%20name.mp3`).

### 6.3 Track Matching

Primary matching is performed by direct comparison of the `Location` path against the known original file paths from the scan. If no direct match is found (e.g. the user moved files after their last XML export), a fallback fuzzy match is attempted using all three of the following fields simultaneously:

- `Name` (track title)
- `Artist`
- `TotalTime` (duration in seconds, within a ±3 second tolerance)

If the fuzzy match returns exactly one result, it is used. If it returns zero or multiple results, the track node is left unmodified and logged as `[UNMATCHED]` in the session log.

### 6.4 Path Rewriting

For each approved and committed track, CrateUp updates the matched `<TRACK>` node's `Location` attribute:

1. Constructs the new absolute file path (same directory, new filename extension).
2. URL-encodes the full path (spaces → `%20`, preserving `file://localhost/` prefix).
3. Writes the encoded string to the `Location` attribute.

No other attributes within the `<TRACK>` node are modified. Hot cues, beat grids, loops, play counts, and memory cues are preserved verbatim.

Playlists, playlist folders, and play history nodes in the XML are passed through unchanged.

### 6.5 Output File

CrateUp writes the updated XML to the same directory as the original exported file, with a timestamped filename:

```
rekordbox_upgraded_YYYY-MM-DD.xml
```

If a file with that name already exists (e.g. the user runs CrateUp twice on the same day), it is overwritten without prompting.

### 6.6 Re-Import

The user imports `rekordbox_upgraded_YYYY-MM-DD.xml` into Rekordbox via *File → Import Collection* using the XML bridge. Existing cue points, grids, and loops are automatically reassociated with the new high-quality files.

---

## 7. Session Log

CrateUp maintains a human-readable session log file alongside `.crateup-progress.json`:

```
<scanned_root>/.crateup-log-<YYYY-MM-DD>.txt
```

Each line is a timestamped entry. Example entries:

```
[2024-06-07 14:02:31] [IDENTIFIED]     Artist - Track Title  →  Deezer ID 123456789
[2024-06-07 14:03:15] [UNIDENTIFIED]   /Folder/Subfolder/mystery_track.mp3
[2024-06-07 14:04:02] [NOT ON DEEZER]  Artist - Track Title
[2024-06-07 14:05:44] [DUPLICATE]      Artist - Track Title  →  cloned from committed copy
[2024-06-07 14:08:10] [COMMITTED]      Artist - Track Title  →  /Folder/Subfolder/track.flac
[2024-06-07 14:08:11] [SKIPPED]        Artist - Track Title  →  original retained
[2024-06-07 14:08:14] [UNMATCHED XML]  Artist - Track Title  →  no Rekordbox node found
```

---

## 8. Legal Notice

This application is built for **personal, non-commercial use only**.

- `shazamio` is an unofficial, community-maintained wrapper. Its use is not sanctioned by Apple or Shazam.
- Deemix downloads audio using a user-supplied Deezer ARL token. This is likely a violation of Deezer's Terms of Service.
- The application must not be packaged, distributed, sold, or published in any form, including on app stores, GitHub public repositories, or file-sharing platforms.
- The developers of this specification accept no liability for any account suspension, legal action, or data loss arising from use of this application.

Users are reminded that upgrading a file they do not own the rights to may constitute copyright infringement in their jurisdiction, regardless of the tooling used.
