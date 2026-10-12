/* Shared preferences: match policy, library root, output default.
 * Versioned, validated, persisted to localStorage.
 *
 * Precedence, stated once: global default (here) → per-run override →
 * stored result. Runs default FROM this object; they never mutate it.
 *
 * Deliberately small: only prefs with a real consumer live here.
 * (Dedup-depth defaults and identification ordering are per-tool run
 * options, not global policy.) */

export interface MatchPolicy {
  /** Acoustic similarity floor for "same song" (0..1). Applies to
   *  duplicate detection and Playlist Compare sound matching. */
  acousticThreshold: number;
}

export interface AppPrefs {
  outputFormat: string;
  libraryRoot: string | null;
  match: MatchPolicy;
}

export const PREFS_KEY = "crateup_prefs_v1";

export const DEFAULT_PREFS: AppPrefs = {
  outputFormat: "flac",
  libraryRoot: null,
  match: {
    acousticThreshold: 0.9,
  },
};

export function sanitizeMatch(raw: unknown): MatchPolicy {
  const m = (raw ?? {}) as Partial<MatchPolicy>;
  const t = typeof m.acousticThreshold === "number" ? m.acousticThreshold : NaN;
  return {
    acousticThreshold:
      Number.isFinite(t) && t >= 0.5 && t <= 1 ? t : DEFAULT_PREFS.match.acousticThreshold,
  };
}

export function loadPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return structuredClone(DEFAULT_PREFS);
    const saved = JSON.parse(raw) as Partial<AppPrefs>;
    return {
      outputFormat:
        typeof saved.outputFormat === "string" && saved.outputFormat
          ? saved.outputFormat
          : DEFAULT_PREFS.outputFormat,
      libraryRoot:
        typeof saved.libraryRoot === "string" && saved.libraryRoot
          ? saved.libraryRoot
          : null,
      match: sanitizeMatch(saved.match),
    };
  } catch {
    return structuredClone(DEFAULT_PREFS);
  }
}

export function savePrefs(prefs: AppPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // quota/unavailable — prefs apply for this run only
  }
}

export function resetPrefs(): AppPrefs {
  const fresh = structuredClone(DEFAULT_PREFS);
  savePrefs(fresh);
  return fresh;
}

/** Whole-percent rendering of the threshold, e.g. 90 → "≥90%". */
export function thresholdLabel(threshold: number): string {
  return `≥${Math.round(threshold * 100)}%`;
}
