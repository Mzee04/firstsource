// Part 9: human approval queue. Nothing is submitted unless an item is "approved" here.
import fs from "node:fs";
import path from "node:path";
import type { QueueItem, Side, State } from "./types.ts";
import { MAX_FILES, capCheck, cutoffCheck, lockSide, releaseSideIfUnused, sideCheck } from "./rules.ts";
import { checkNovelty } from "./novelty.ts";
import { screenshotCheck } from "./hardsource.ts";

/** Attachment types the FAQ lists as accepted ("pdf, png, jpg, csv, text"). Anything else is refused. */
export const FILE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".csv": "text/csv",
  ".txt": "text/plain",
};
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);

/** Exact id, else a unique prefix of at least 4 characters. An ambiguous prefix is an error, never a guess. */
export function getItem(state: State, id: string): QueueItem {
  if (!id) throw new Error("missing item id");
  const exact = state.items.find((i) => i.id === id);
  if (exact) return exact;
  if (id.length < 4) throw new Error(`no item ${id} (give at least 4 characters of the id)`);
  const hits = state.items.filter((i) => i.id.startsWith(id));
  if (hits.length > 1) throw new Error(`id prefix ${id} matches ${hits.length} items (${hits.map((i) => i.id).join(", ")}); give more characters`);
  if (!hits.length) throw new Error(`no item ${id}`);
  return hits[0];
}

export function approve(state: State, id: string, now = Date.now()): QueueItem {
  const it = getItem(state, id);
  if (it.status !== "pending") throw new Error(`item ${it.id} is ${it.status}, not pending`);
  const co = cutoffCheck(it, now);
  if (!co.ok) throw new Error(`cannot approve: ${co.reason}`);
  const sc = sideCheck(state, it.market, it.side);
  if (!sc.ok) throw new Error(`cannot approve: ${sc.reason}`);
  const cc = capCheck(state, it.market);
  if (!cc.ok) throw new Error(`cannot approve: ${cc.reason}`);
  const nv = checkNovelty(state, it.market, it.fact.text, { excludeItem: it.id });
  if (!nv.novel) throw new Error(`cannot approve: duplicate of ${nv.duplicateOf}`);
  if (it.files.length > MAX_FILES) throw new Error(`cannot approve: ${it.files.length} files (max ${MAX_FILES})`);
  for (const f of it.files) if (!fs.existsSync(f)) throw new Error(`cannot approve: file missing ${f}`);
  const ss = screenshotCheck(it);
  if (!ss.ok) throw new Error(`cannot approve: ${ss.reason}`);
  lockSide(state, it.market, it.side!);
  it.status = "approved";
  it.decidedAt = new Date(now).toISOString();
  return it;
}

/** Advisory (not blocking): the FAQ asks for a screenshot showing the URL and date when the judge cannot read a link. */
export function approvalWarnings(it: QueueItem): string[] {
  const w: string[] = [];
  if (it.mode === "fallback" && !it.requiresScreenshot && !it.files.some((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))) {
    w.push("fallback item has no screenshot: the FAQ asks for a screenshot showing the URL and date (use attach <id> shot.png); the text PDF capture alone may not be enough");
  }
  if (it.sideCall.confidence === "low") w.push(`side ${it.side} came from a keyword guess (${it.sideCall.reason}); double-check it`);
  return w;
}

export function reject(state: State, id: string, reason = "rejected by reviewer", now = Date.now()): QueueItem {
  const it = getItem(state, id);
  if (it.status === "submitted") throw new Error("already submitted; submissions cannot be edited or retracted");
  const wasApproved = it.status === "approved";
  it.status = "rejected";
  it.rejectReason = reason;
  it.decidedAt = new Date(now).toISOString();
  // Un-approving the only item that set a market's side must not leave that market locked forever.
  if (wasApproved) releaseSideIfUnused(state, it.market);
  return it;
}

export function setSide(state: State, id: string, side: Side): QueueItem {
  const it = getItem(state, id);
  if (it.status !== "pending") throw new Error(`item ${it.id} is ${it.status}; only pending items can change side`);
  it.side = side;
  it.sideCall = { ...it.sideCall, reason: `${it.sideCall.reason} | set by reviewer to ${side}` };
  return it;
}

export function attach(state: State, id: string, file: string): QueueItem {
  const it = getItem(state, id);
  if (it.status !== "pending") throw new Error("attach only to pending items");
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`no file ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  if (!FILE_TYPES[ext]) throw new Error(`file type ${ext || "(none)"} not accepted; use ${Object.keys(FILE_TYPES).join(", ")}`);
  if (fs.statSync(abs).size === 0) throw new Error(`file ${abs} is empty`);
  if (it.files.includes(abs)) return it;
  if (it.files.length >= MAX_FILES) throw new Error(`max ${MAX_FILES} files per submission; remove one first with: detach ${it.id} <file>`);
  it.files.push(abs);
  return it;
}

/** Remove an attachment (by path, basename, or 1-based index) from a pending item. The file on disk is kept. */
export function detach(state: State, id: string, which: string): QueueItem {
  const it = getItem(state, id);
  if (it.status !== "pending") throw new Error("detach only from pending items");
  const n = Number(which);
  const idx = Number.isInteger(n) && n >= 1 && n <= it.files.length ? n - 1 : it.files.findIndex((f) => f === path.resolve(which) || path.basename(f) === which);
  if (idx < 0) throw new Error(`item ${it.id} has no attachment ${which}`);
  it.files.splice(idx, 1);
  return it;
}
