/* Typed Tauri bridge for CrateUp.
   The ui/ folder is served statically (no bundler), so this module talks
   to the backend through the `window.__TAURI__` globals (withGlobalTauri)
   instead of importing @tauri-apps/api.
   Argument names follow Tauri v2 camelCase conversion of the Rust params. */

interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  convertFileSrc(path: string): string;
}

interface TauriEventApi {
  listen<T>(
    event: string,
    handler: (e: { payload: T }) => void,
  ): Promise<() => void>;
}

declare global {
  interface Window {
    __TAURI__?: { core: TauriCore; event: TauriEventApi };
  }
}

export function isTauri(): boolean {
  return typeof window.__TAURI__ !== "undefined";
}

export function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!window.__TAURI__) {
    return Promise.reject(new Error(`Tauri bridge unavailable for "${cmd}"`));
  }
  return window.__TAURI__.core.invoke<T>(cmd, args);
}

export function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!window.__TAURI__) {
    return Promise.reject(
      new Error(`Tauri bridge unavailable for event "${event}"`),
    );
  }
  return window.__TAURI__.event.listen<T>(event, (e) => handler(e.payload));
}

export function convertFileSrc(path: string): string {
  if (!window.__TAURI__) throw new Error("Tauri bridge unavailable");
  return window.__TAURI__.core.convertFileSrc(path);
}

/* ---- shared shapes ---- */

export interface CommitFailure {
  relPath: string;
  error: string;
}

export interface CommitResult {
  committed: number;
  skipped: number;
  failed: CommitFailure[];
}

export interface ExpandedPaths {
  files: string[];
  suggested_playlist_name: string;
}

/** Backend payloads whose exact fields get nailed down when each workflow
 *  slice is wired (cleaner / ingestion). Deliberately loose for now. */
export type OpaqueResult = Record<string, unknown>;

/* ---- file picking ---- */

export const selectDirectory = (defaultDir?: string) =>
  invoke<string | null>("select_directory", { defaultDir: defaultDir ?? null });

export const selectOutputDirectory = (defaultDir?: string) =>
  invoke<string | null>("select_output_directory", { defaultDir });

export const selectXmlFile = () => invoke<string | null>("select_xml_file");

export const selectAudioFiles = () =>
  invoke<string[]>("select_audio_files");

export const selectSaveXmlFile = (defaultName: string) =>
  invoke<string | null>("select_save_xml_file", { defaultName });

export const expandAudioPaths = (paths: string[]) =>
  invoke<ExpandedPaths>("expand_audio_paths", { paths });

export const openDirectory = (path: string) =>
  invoke<void>("open_directory", { path });

/* ---- session / ledger ---- */

export const checkLedgerExists = (rootPath: string) =>
  invoke<boolean>("check_ledger_exists", { rootPath });

export const readLedgerFile = (ledgerPath: string) =>
  invoke<string>("read_ledger_file", { ledgerPath });

export const writeLedgerFile = (ledgerPath: string, content: string) =>
  invoke<void>("write_ledger_file", { ledgerPath, content });

export const saveLedgerDecision = (
  ledgerPath: string,
  relativePath: string,
  decision: string,
) => invoke<void>("save_ledger_decision", { ledgerPath, relativePath, decision });

export const resetSession = (rootPath: string, isSessionDir: boolean) =>
  invoke<void>("reset_session", { rootPath, isSessionDir });

export const getAppDataDir = () => invoke<string>("get_app_data_dir");

export const getNodePath = () => invoke<string>("get_node_path");

/* ---- quality upgrader pipeline ---- */

export interface StartPipelineOptions {
  rootPath: string;
  outputFormat: string;
  fileList?: string[];
  skipHighQuality?: boolean;
  skipDeezerMax?: boolean;
}

/** Fire-and-forget: progress arrives via "pipeline-log" / "pipeline-done". */
export const startPipeline = (opts: StartPipelineOptions) =>
  invoke<void>("start_pipeline", {
    rootPath: opts.rootPath,
    outputFormat: opts.outputFormat,
    fileList: opts.fileList ?? null,
    skipHighQuality: opts.skipHighQuality ?? null,
    skipDeezerMax: opts.skipDeezerMax ?? null,
  });

export const cancelPipeline = () => invoke<boolean>("cancel_pipeline");

export const downloadTrackById = (
  rootPath: string,
  outputFormat: string,
  relativePath: string,
  deezerId: number,
  artist: string,
  title: string,
) =>
  invoke<string>("download_track_by_id", {
    rootPath,
    outputFormat,
    relativePath,
    deezerId,
    artist,
    title,
  });

export const identifyTrack = (rootPath: string, relativePath: string) =>
  invoke<string>("identify_track", { rootPath, relativePath });

export const commitChanges = (
  ledgerPath: string,
  decisions: Record<string, string>,
  outputPath: string,
  outputStrategy: string,
) =>
  invoke<CommitResult>("commit_changes", {
    ledgerPath,
    decisions,
    outputPath,
    outputStrategy,
  });

export const getFileSize = (path: string) =>
  invoke<number | null>("get_file_size", { path });

export const checkFileExists = (path: string) =>
  invoke<boolean>("check_file_exists", { path });

export const showConfirmDialog = (title: string, message: string) =>
  invoke<boolean>("show_confirm_dialog", { title, message });

/* ---- Rekordbox XML ---- */

export const parsePlaylists = (xmlPath: string) =>
  invoke<string>("parse_playlists", { xmlPath });

export const getPlaylistTracks = (xmlPath: string, playlistName: string) =>
  invoke<string[]>("get_playlist_tracks", { xmlPath, playlistName });

export const getFolderTracks = (xmlPath: string, folderName: string) =>
  invoke<string[]>("get_folder_tracks", { xmlPath, folderName });

/* ---- playlist compare ---- */

export interface AcousticPair {
  a: string;
  b: string;
  score: number;
}

export interface AcousticCompareResult {
  pairs: AcousticPair[];
  only_a: string[];
  only_b: string[];
  skipped: string[];
}

export interface CompareAcousticProgress {
  processed: number;
  total: number;
}

export const comparePlaylistsAcoustic = (
  pathsA: string[],
  pathsB: string[],
  threshold?: number,
) =>
  invoke<AcousticCompareResult>("compare_playlists_acoustic", {
    pathsA,
    pathsB,
    threshold: threshold ?? null,
  });

/* ---- fingerprint cache (Settings → Storage) ---- */

export interface FingerprintCacheInfo {
  entries: number;
  bytes: number;
}

export const fingerprintCacheInfo = () =>
  invoke<FingerprintCacheInfo>("fingerprint_cache_info");

export const clearFingerprintCache = () =>
  invoke<number>("clear_fingerprint_cache");

export const parseAndValidateXml = (xmlPath: string) =>
  invoke<OpaqueResult>("parse_and_validate_xml", { xmlPath });

export const getXmlTrackCount = (xmlPath: string) =>
  invoke<number>("get_xml_track_count", { xmlPath });

/* ---- library cleaner ---- */

export interface ConsolidationOptions {
  destinationPath: string;
  fileMode: string;
  crossFormat: string;
  dedupDepth: string;
  renamingRule: string;
  /** Same-song threshold 0..1; null/omitted → backend default. */
  threshold?: number | null;
}

export const executeSafeClone = (xmlPath: string, opts: ConsolidationOptions) =>
  invoke<OpaqueResult>("execute_safe_clone", { xmlPath, ...opts, threshold: opts.threshold ?? null });

export const executeDbConsolidation = (opts: ConsolidationOptions) =>
  invoke<OpaqueResult>("execute_db_consolidation", { ...opts, threshold: opts.threshold ?? null });

/* ---- Rekordbox database ---- */

export const parsePlaylistsFromDb = () =>
  invoke<string>("parse_playlists_from_db");

export const getPlaylistTracksFromDb = (playlistName: string) =>
  invoke<string[]>("get_playlist_tracks_from_db", { playlistName });

export const getFolderTracksFromDb = (folderName: string) =>
  invoke<string[]>("get_folder_tracks_from_db", { folderName });

export const updateRekordboxDbDirectly = (
  ledgerPath: string,
  decisions: Record<string, string>,
  outputPath: string,
  outputStrategy: string,
  autoShiftCues?: boolean,
) =>
  invoke<void>("update_rekordbox_db_directly", {
    ledgerPath,
    decisions,
    outputPath,
    outputStrategy,
    autoShiftCues,
  });

export const updateRekordboxXml = (
  xmlPath: string,
  ledgerPath: string,
  decisions: Record<string, string>,
  autoShiftCues?: boolean,
) =>
  invoke<string>("update_rekordbox_xml", {
    xmlPath,
    ledgerPath,
    decisions,
    autoShiftCues,
  });

export interface RekordboxBackup {
  filename: string;
  created_at: string;
  size_bytes: number;
  is_active: boolean;
  is_newer_than_active: boolean;
  total_tracks: number;
  intact_tracks: number;
  missing_tracks: number;
}

export interface RollbackResult {
  restored_filename: string;
  created_safety_backup: string | null;
  total_tracks: number;
  intact_tracks: number;
  missing_tracks: number;
  healed_paths_count: number;
}

export interface EngineHealth {
  fpcalc_ok: boolean;
  fpcalc_version?: string | null;
  ffmpeg_ok: boolean;
  ffmpeg_version?: string | null;
  python_ok: boolean;
  python_version?: string | null;
  rekordbox_db_exists: boolean;
  rekordbox_running: boolean;
  rekordbox_db_path: string;
}

export const checkRekordboxStatus = () =>
  invoke<OpaqueResult>("check_rekordbox_status");

export const checkEngineHealth = () =>
  invoke<EngineHealth>("check_engine_health");

export const getDbBackups = () => invoke<string[]>("get_db_backups");

export const listRekordboxBackups = () =>
  invoke<RekordboxBackup[]>("list_rekordbox_backups");

export const executeBackupCleanup = (backupFilename: string) =>
  invoke<OpaqueResult>("execute_backup_cleanup", { backupFilename });

export const rollbackToLatestBackup = () =>
  invoke<RollbackResult>("rollback_to_latest_backup");

export const rollbackToBackup = (backupFilename: string, keepValidPaths?: boolean) =>
  invoke<RollbackResult>("rollback_to_backup", { backupFilename, keepValidPaths });

export const deleteDbBackup = (backupFilename: string) =>
  invoke<string>("delete_db_backup", { backupFilename });

export const trashSupersededFiles = (paths: string[]) =>
  invoke<number>("trash_superseded_files", { paths });

export const fixRekordboxDbDuplicates = () =>
  invoke<number>("fix_rekordbox_db_duplicates");

/* ---- playlist ingestion ---- */

export interface IngestionOptions {
  stagedFiles: string[];
  playlistName: string;
  destinationPath: string;
  fileMode: string;
  crossFormat: string;
  dedupDepth: string;
  renamingRule: string;
  xmlSavePath: string;
  /** Same-song threshold 0..1; null/omitted → backend default. */
  threshold?: number | null;
  /** Link songs already in master.db instead of copying; default on. */
  libraryCheck?: boolean | null;
}

export const executePlaylistIngestion = (opts: IngestionOptions) =>
  invoke<OpaqueResult>("execute_playlist_ingestion", {
    ...opts,
    threshold: opts.threshold ?? null,
    libraryCheck: opts.libraryCheck ?? null,
  });

/* ---- library audit ---- */

export interface AuditLeftover {
  path: string;
  size: number;
  kind: string;
  dupe_of: string | null;
}

export interface StrayGroup {
  folder: string;
  files: string[];
}

export interface AuditReport {
  library_root: string;
  audio_file_count: number;
  referenced_count: number;
  leftovers: AuditLeftover[];
  stray_groups: StrayGroup[];
  twins_found_extra: number;
  twins_total_extra: number;
  outside_db: string[];
  missing_db: string[];
  streaming_db?: string[];
  skipped_dirs: string[];
  bytes_wasted: number;
  fake_lossless?: string[];
}

export interface AuditProgress {
  phase: string;
  processed: number;
  total: number;
}

export interface AuditDeleteResult {
  path: string;
  status: string;
}

export const auditLibrary = (libraryRoot: string, searchRoots: string[]) =>
  invoke<AuditReport>("audit_library", { libraryRoot, searchRoots });

export const auditSuggestedRoots = () => invoke<string[]>("audit_suggested_roots");

export const deleteAuditPaths = (paths: string[]) =>
  invoke<AuditDeleteResult[]>("delete_audit_paths", { paths });

export const removeEmptyFolders = (folders: string[]) =>
  invoke<AuditDeleteResult[]>("remove_empty_folders", { folders });

/* ---- settings ---- */

export const getArl = () => invoke<string>("get_arl");

export const saveArl = (arl: string) => invoke<void>("save_arl", { arl });

export interface ArlStatusResult {
  valid: boolean;
  status: "valid" | "expired" | "missing" | "network_error" | "timeout" | "error";
  message: string;
  user_id?: number;
  user_name?: string;
  is_lossless?: boolean;
}

export const checkArlStatus = (token?: string) =>
  invoke<ArlStatusResult>("check_arl_status", { token: token ?? null });

export interface ResolvedDeezerTrack {
  original_url: string;
  resolved_url: string | null;
  track_id: number | null;
  error?: string | null;
}

export const resolveDeezerLink = (url: string) =>
  invoke<ResolvedDeezerTrack>("resolve_deezer_link", { url });

