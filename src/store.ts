import fs from "node:fs";
import path from "node:path";
import type { State } from "./types.ts";

export function emptyState(): State {
  return {
    version: 1,
    items: [],
    sides: {},
    submissions: [],
    watches: [],
    feedback: [],
    lessons: { updatedAt: null, domains: {}, tags: {}, forceFallbackDomains: [], avoidDomains: [], processed: [] },
  };
}

export function statePath(dataDir: string): string {
  return path.join(dataDir, "state.json");
}

export function loadState(dataDir: string): State {
  const p = statePath(dataDir);
  if (!fs.existsSync(p)) return emptyState();
  let s: State;
  try {
    s = JSON.parse(fs.readFileSync(p, "utf8")) as State;
  } catch (e) {
    throw new Error(`${p} is not valid JSON (${(e as Error).message}); restore it from ${p}.bak or move it aside`);
  }
  if (!s || typeof s !== "object" || !Array.isArray(s.items)) throw new Error(`${p} is not a FirstSource state file`);
  return { ...emptyState(), ...s, lessons: { ...emptyState().lessons, ...s.lessons } };
}

/** Atomic write: tmp file + rename, so a crash never leaves half a state file. */
export function saveState(dataDir: string, s: State): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = statePath(dataDir);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak`);
  fs.renameSync(tmp, p);
}

/**
 * One FirstSource process per data dir. Two concurrent runs (e.g. `scan` while `submit` runs) would
 * each load state.json and the last save would silently drop the other's changes, including a
 * "submitted" mark. The lock is a file created with O_EXCL; a lock left by a dead process is reclaimed.
 */
export function acquireLock(dataDir: string, pid = process.pid): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = path.join(dataDir, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, "wx");
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (fs.readFileSync(p, "utf8").trim() === String(pid)) fs.unlinkSync(p); } catch { /* already gone */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number(fs.readFileSync(p, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
        throw new Error(`another FirstSource run (pid ${holder}) is using ${dataDir}; wait for it to finish`);
      }
      fs.rmSync(p, { force: true }); // stale lock from a crashed run
    }
  }
  throw new Error(`could not lock ${dataDir}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
