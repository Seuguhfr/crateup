/* Typed Tauri bridge for CrateUp.
   The ui/ folder is served statically (no bundler), so this module talks
   to the backend through the `window.__TAURI__` globals (withGlobalTauri)
   instead of importing @tauri-apps/api.
   Argument names follow Tauri v2 camelCase conversion of the Rust params. */
export function isTauri() {
    return typeof window.__TAURI__ !== "undefined";
}
export function invoke(cmd, args) {
    if (!window.__TAURI__) {
        return Promise.reject(new Error(`Tauri bridge unavailable for "${cmd}"`));
    }
    return window.__TAURI__.core.invoke(cmd, args);
}
export function listen(event, handler) {
    if (!window.__TAURI__) {
        return Promise.reject(new Error(`Tauri bridge unavailable for event "${event}"`));
    }
    return window.__TAURI__.event.listen(event, (e) => handler(e.payload));
}
export function convertFileSrc(path) {
    if (!window.__TAURI__)
        throw new Error("Tauri bridge unavailable");
    return window.__TAURI__.core.convertFileSrc(path);
}
/* ---- file picking ---- */
export const selectDirectory = (defaultDir) => invoke("select_directory", { defaultDir: defaultDir ?? null });
export const selectOutputDirectory = (defaultDir) => invoke("select_output_directory", { defaultDir });
export const selectXmlFile = () => invoke("select_xml_file");
export const selectAudioFiles = () => invoke("select_audio_files");
export const selectSaveXmlFile = (defaultName) => invoke("select_save_xml_file", { defaultName });
export const expandAudioPaths = (paths) => invoke("expand_audio_paths", { paths });
export const openDirectory = (path) => invoke("open_directory", { path });
/* ---- session / ledger ---- */
export const checkLedgerExists = (rootPath) => invoke("check_ledger_exists", { rootPath });
export const readLedgerFile = (ledgerPath) => invoke("read_ledger_file", { ledgerPath });
export const writeLedgerFile = (ledgerPath, content) => invoke("write_ledger_file", { ledgerPath, content });
export const saveLedgerDecision = (ledgerPath, relativePath, decision) => invoke("save_ledger_decision", { ledgerPath, relativePath, decision });
export const resetSession = (rootPath, isSessionDir) => invoke("reset_session", { rootPath, isSessionDir });
export const getAppDataDir = () => invoke("get_app_data_dir");
export const getNodePath = () => invoke("get_node_path");
/** Fire-and-forget: progress arrives via "pipeline-log" / "pipeline-done". */
export const startPipeline = (opts) => invoke("start_pipeline", {
    rootPath: opts.rootPath,
    outputFormat: opts.outputFormat,
    fileList: opts.fileList ?? null,
    skipHighQuality: opts.skipHighQuality ?? null,
    skipDeezerMax: opts.skipDeezerMax ?? null,
});
export const cancelPipeline = () => invoke("cancel_pipeline");
export const downloadTrackById = (rootPath, outputFormat, relativePath, deezerId, artist, title) => invoke("download_track_by_id", {
    rootPath,
    outputFormat,
    relativePath,
    deezerId,
    artist,
    title,
});
export const identifyTrack = (rootPath, relativePath) => invoke("identify_track", { rootPath, relativePath });
export const commitChanges = (ledgerPath, decisions, outputPath, outputStrategy) => invoke("commit_changes", {
    ledgerPath,
    decisions,
    outputPath,
    outputStrategy,
});
export const getFileSize = (path) => invoke("get_file_size", { path });
export const checkFileExists = (path) => invoke("check_file_exists", { path });
export const showConfirmDialog = (title, message) => invoke("show_confirm_dialog", { title, message });
/* ---- Rekordbox XML ---- */
export const parsePlaylists = (xmlPath) => invoke("parse_playlists", { xmlPath });
export const getPlaylistTracks = (xmlPath, playlistName) => invoke("get_playlist_tracks", { xmlPath, playlistName });
export const getFolderTracks = (xmlPath, folderName) => invoke("get_folder_tracks", { xmlPath, folderName });
export const comparePlaylistsAcoustic = (pathsA, pathsB, threshold) => invoke("compare_playlists_acoustic", {
    pathsA,
    pathsB,
    threshold: threshold ?? null,
});
export const fingerprintCacheInfo = () => invoke("fingerprint_cache_info");
export const clearFingerprintCache = () => invoke("clear_fingerprint_cache");
export const parseAndValidateXml = (xmlPath) => invoke("parse_and_validate_xml", { xmlPath });
export const getXmlTrackCount = (xmlPath) => invoke("get_xml_track_count", { xmlPath });
export const executeSafeClone = (xmlPath, opts) => invoke("execute_safe_clone", { xmlPath, ...opts, threshold: opts.threshold ?? null });
export const executeDbConsolidation = (opts) => invoke("execute_db_consolidation", { ...opts, threshold: opts.threshold ?? null });
/* ---- Rekordbox database ---- */
export const parsePlaylistsFromDb = () => invoke("parse_playlists_from_db");
export const getPlaylistTracksFromDb = (playlistName) => invoke("get_playlist_tracks_from_db", { playlistName });
export const getFolderTracksFromDb = (folderName) => invoke("get_folder_tracks_from_db", { folderName });
export const updateRekordboxDbDirectly = (ledgerPath, decisions, outputPath, outputStrategy) => invoke("update_rekordbox_db_directly", {
    ledgerPath,
    decisions,
    outputPath,
    outputStrategy,
});
export const updateRekordboxXml = (xmlPath, ledgerPath, decisions) => invoke("update_rekordbox_xml", {
    xmlPath,
    ledgerPath,
    decisions,
});
export const checkRekordboxStatus = () => invoke("check_rekordbox_status");
export const getDbBackups = () => invoke("get_db_backups");
export const executeBackupCleanup = (backupFilename) => invoke("execute_backup_cleanup", { backupFilename });
export const rollbackToLatestBackup = () => invoke("rollback_to_latest_backup");
export const fixRekordboxDbDuplicates = () => invoke("fix_rekordbox_db_duplicates");
export const executePlaylistIngestion = (opts) => invoke("execute_playlist_ingestion", {
    ...opts,
    threshold: opts.threshold ?? null,
    libraryCheck: opts.libraryCheck ?? null,
});
export const auditLibrary = (libraryRoot, searchRoots) => invoke("audit_library", { libraryRoot, searchRoots });
export const auditSuggestedRoots = () => invoke("audit_suggested_roots");
export const deleteAuditPaths = (paths) => invoke("delete_audit_paths", { paths });
export const removeEmptyFolders = (folders) => invoke("remove_empty_folders", { folders });
/* ---- settings ---- */
export const getArl = () => invoke("get_arl");
export const saveArl = (arl) => invoke("save_arl", { arl });
