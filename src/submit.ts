// Part 10: idempotent submit. Dry-run is the default and never calls POST /submissions.
// Live needs ALL of: FIRSTSOURCE_LIVE=1, the --live flag, an "approved" item, terms already
// accepted by the account owner, EntryState.canSubmit, a free slot, one side, and novelty.
// The Idempotency-Key is derived from the item id, so retrying the same item can never double-submit.
import fs from "node:fs";
import path from "node:path";
import { EvidenceApiError, TermsNotAcceptedError, type EvidenceClient, type Submission } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Config } from "./config.ts";
import type { QueueItem, State, SubmissionRecord } from "./types.ts";
import { MAX_FILES, capCheck, cutoffCheck, sideCheck } from "./rules.ts";
import { checkNovelty } from "./novelty.ts";
import { FILE_TYPES, getItem } from "./queue.ts";
import { recordFrom } from "./api.ts";
import { learn } from "./learn.ts";

export function filesFor(item: QueueItem): File[] {
  if (item.files.length > MAX_FILES) throw new Error(`max ${MAX_FILES} files`);
  return item.files.map((f) => {
    const type = FILE_TYPES[path.extname(f).toLowerCase()];
    if (!type) throw new Error(`file type of ${path.basename(f)} is not accepted`);
    return new File([fs.readFileSync(f)], path.basename(f), { type });
  });
}

/** Local guards shared by dry-run and live. */
export function localChecks(state: State, item: QueueItem, remoteRemaining?: number, now = Date.now()): string[] {
  const errs: string[] = [];
  if (item.status !== "approved") errs.push(`item is ${item.status}, not approved`);
  const co = cutoffCheck(item, now);
  if (!co.ok) errs.push(co.reason!);
  const sc = sideCheck(state, item.market, item.side);
  if (!sc.ok) errs.push(sc.reason!);
  const cc = capCheck(state, item.market, { remoteRemaining, excludingItem: item.id });
  if (!cc.ok) errs.push(cc.reason!);
  const nv = checkNovelty(state, item.market, item.fact.text, { excludeItem: item.id });
  if (!nv.novel) errs.push(`duplicate of ${nv.duplicateOf}`);
  if (item.files.length > MAX_FILES) errs.push(`too many files (${item.files.length})`);
  return errs;
}

export interface SubmitOutcome {
  mode: "dry-run" | "live";
  itemId: string;
  dryRunFile?: string;
  submissionId?: string;
  status?: string;
  verdict?: string | null;
  reason?: string | null;
  /** Live only: an earlier attempt had already landed; nothing was re-sent. */
  alreadyLanded?: boolean;
}

export async function submitItem(
  state: State,
  cfg: Config,
  id: string,
  opts: { live?: boolean; wait?: boolean; client?: EvidenceClient; timeoutMs?: number; now?: number; onSubmitted?: () => void } = {},
): Promise<SubmitOutcome> {
  const item = getItem(state, id);
  const now = opts.now ?? Date.now();
  const errs = localChecks(state, item, undefined, now);
  if (errs.length) throw new Error(`blocked: ${errs.join("; ")}`);
  const files = filesFor(item);
  const params = { note: item.note, links: item.links, marketAddress: item.market, idempotencyKey: item.idempotencyKey };

  if (!opts.live) {
    const dir = path.join(cfg.dataDir, "dryruns");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${item.id}-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ wouldCall: "EvidenceClient.submitEvidence", params: { ...params, files: files.map((f) => ({ name: f.name, type: f.type, sizeBytes: f.size })) }, side: item.side, mode: item.mode, preflight: item.preflight }, null, 2));
    item.dryRuns.push(file);
    return { mode: "dry-run", itemId: item.id, dryRunFile: file };
  }

  if (!cfg.live) throw new Error("live submit refused: FIRSTSOURCE_LIVE is not 1");
  const client = opts.client;
  if (!client) throw new Error("live submit needs an API client (DELPHI_API_URL + key)");

  const { data: terms } = await client.getTerms();
  if (!terms.acceptedAt) throw new Error(`live submit refused: evidence terms ${terms.version} not accepted for this account. The account owner must read ${terms.url} and accept them (FirstSource never accepts on its own).`);
  // SDK 2.4.0 README: check listSubmissions({ market }) before submitting, so the account never sends
  // the same information twice (another run, another machine, or a lost state file).
  await syncMarket(state, client, item.market);
  if (item.status === "submitted") {
    // A previous attempt landed (e.g. it timed out after the server saved it). Nothing is re-sent.
    const rec = state.submissions.find((s) => s.id === item.submissionId);
    opts.onSubmitted?.();
    return { mode: "live", itemId: item.id, submissionId: item.submissionId, status: rec?.status, verdict: rec?.verdict ?? null, reason: rec?.reason ?? null, alreadyLanded: true };
  }
  const { data: entry } = await client.getEntryState(item.market);
  if (!entry.canSubmit) throw new Error(`live submit refused by entry state: ${entry.reason ?? "cannot submit"}`);
  const remoteErrs = localChecks(state, item, entry.remainingOnMarket, Date.now());
  if (remoteErrs.length) throw new Error(`blocked: ${remoteErrs.join("; ")}`);

  let sub;
  try {
    ({ data: sub } = await client.submitEvidence({ ...params, files }));
  } catch (e) {
    if (e instanceof TermsNotAcceptedError) item.lastError = `terms_not_accepted (${e.terms.version})`;
    else if (e instanceof EvidenceApiError) item.lastError = `${e.code}${e.limit ? `/${e.limit}` : ""}: ${e.message}${e.retryable ? ` (retryable${e.retryAfterSeconds ? ` after ${e.retryAfterSeconds}s` : ""}; same Idempotency-Key will be reused)` : ""}`;
    else item.lastError = `network: ${(e as Error).message} (retry is safe: same Idempotency-Key)`;
    throw new Error(`submit failed: ${item.lastError}`);
  }
  const rec = recordFrom(sub, item.id, item.market, now);
  state.submissions = state.submissions.filter((s) => s.id !== rec.id).concat(rec);
  item.status = "submitted";
  item.submissionId = sub.id;
  item.lastError = undefined;
  opts.onSubmitted?.();

  let final = sub;
  if (opts.wait !== false && !["judged", "rejected", "failed", "unmatched"].includes(sub.status)) {
    try {
      final = (await client.waitForSubmission(sub.id, { timeoutMs: opts.timeoutMs ?? 300_000 })).data;
    } catch (e) {
      item.lastError = `still judging: ${(e as Error).message} (run sync later)`;
    }
  }
  const rec2 = recordFrom(final, item.id, item.market);
  state.submissions = state.submissions.filter((s) => s.id !== rec2.id).concat(rec2);
  learn(state);
  return { mode: "live", itemId: item.id, submissionId: sub.id, status: rec2.status, verdict: rec2.verdict, reason: rec2.reason };
}

/**
 * A submission that landed but was never recorded locally (timeout after the server saved it, crash
 * before save): match it to our approved item by market + identical note and mark the item submitted.
 * Without this, a retry would be blocked as a "duplicate" of itself and the slot counted twice.
 */
/** multipart/form-data turns "\n" into "\r\n" in text fields, so compare notes with line endings normalized. */
const sameNote = (a: string, b: string) => a.replace(/\r\n?/g, "\n").trim() === b.replace(/\r\n?/g, "\n").trim();

function reconcile(state: State, s: Submission, rec: SubmissionRecord): QueueItem | undefined {
  const byId = state.items.find((i) => i.submissionId === s.id);
  if (byId) return byId;
  const it = state.items.find((i) => i.status === "approved" && !i.submissionId && i.market.toLowerCase() === rec.market.toLowerCase() && s.note !== null && sameNote(i.note, s.note));
  if (it) {
    it.status = "submitted";
    it.submissionId = s.id;
    it.lastError = undefined;
  }
  return it;
}

async function pull(state: State, client: EvidenceClient, q: { market?: string }): Promise<{ fetched: number; imported: number; updated: number }> {
  let cursor: string | undefined;
  let fetched = 0, imported = 0, updated = 0;
  for (let page = 0; page < 100; page++) {
    const { data } = await client.listSubmissions({ ...q, cursor, limit: 50 });
    for (const s of data.items) {
      fetched++;
      const existing = state.submissions.find((x) => x.id === s.id);
      const rec = recordFrom(s, existing?.itemId ?? null, existing?.market ?? q.market);
      const item = reconcile(state, s, rec);
      rec.itemId = item?.id ?? rec.itemId;
      if (existing) { Object.assign(existing, rec); updated++; } else { state.submissions.push(rec); imported++; }
    }
    if (!data.nextCursor || data.nextCursor === cursor) break;
    cursor = data.nextCursor;
  }
  return { fetched, imported, updated };
}

/** Pull our account's submissions on one market (used right before a live submit). */
export async function syncMarket(state: State, client: EvidenceClient, market: string): Promise<void> {
  await pull(state, client, { market });
}

/** Pull our account's submissions (all pages) into local state; feeds novelty, the tracker and learning. */
export async function sync(state: State, client: EvidenceClient): Promise<{ fetched: number; imported: number; updated: number }> {
  const r = await pull(state, client, {});
  learn(state);
  return r;
}
