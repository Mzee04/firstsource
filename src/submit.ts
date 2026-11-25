// Part 10: idempotent submit. Dry-run is the default and never calls POST /submissions.
// Live needs ALL of: FIRSTSOURCE_LIVE=1, the --live flag, an "approved" item, terms already
// accepted by the account owner, EntryState.canSubmit, a free slot, one side, and novelty.
// The Idempotency-Key is derived from the item id, so retrying the same item can never double-submit.
import fs from "node:fs";
import path from "node:path";
import { EvidenceApiError, TermsNotAcceptedError, type EvidenceClient, type Submission } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Config } from "./config.ts";
import type { QueueItem, State, SubmissionRecord } from "./types.ts";
import { MAX_FILES, capCheck, cutoffCheck, filesCheck, itemsCheck, sideCheck } from "./rules.ts";
import { checkNovelty } from "./novelty.ts";
import { FILE_TYPES, getItem } from "./queue.ts";
import { recordFrom } from "./api.ts";
import { learn } from "./learn.ts";
import { screenshotCheck } from "./hardsource.ts";
import { logEvent } from "./feedbacklog.ts";
import { uuidFromSeed } from "./text.ts";

/**
 * The Idempotency-Key is deterministic per queued item (uuidFromSeed(item id), and the item id is
 * itself derived from market + fact fingerprint) and is stored on the item when it is queued. It is
 * filled in only if missing (old state files) and is NEVER replaced, so every retry reuses it.
 */
export function ensureIdempotencyKey(item: QueueItem): string {
  if (!item.idempotencyKey) item.idempotencyKey = uuidFromSeed(item.id);
  return item.idempotencyKey;
}

/** Errors worth retrying with the same key: timeouts, dropped connections, and API errors marked retryable. */
export function isTransient(e: unknown): boolean {
  if (e instanceof TermsNotAcceptedError) return false;
  if (e instanceof EvidenceApiError) return e.retryable || e.status >= 500 || e.status === 0;
  return true; // fetch failed, socket hang up, AbortSignal timeout, ...
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live submit is one-id-at-a-time under human review; --all-approved is dry-run only. */
export function assertSubmitFlags(opts: { live?: boolean; allApproved?: boolean }): void {
  if (opts.live && opts.allApproved) {
    throw new Error("refusing: --all-approved cannot be combined with --live; submit live items one id at a time");
  }
}


export async function filesFor(item: QueueItem): Promise<File[]> {
  if (item.files.length > MAX_FILES) throw new Error(`max ${MAX_FILES} files`);
  const fc = await filesCheck(item.files);
  if (!fc.ok) throw new Error(fc.reason!);
  return item.files.map((f) => {
    const type = FILE_TYPES[path.extname(f).toLowerCase()];
    if (!type) throw new Error(`file type of ${path.basename(f)} is not accepted`);
    return new File([fs.readFileSync(f)], path.basename(f), { type });
  });
}

/** Local guards shared by dry-run and live. */
export async function localChecks(state: State, item: QueueItem, remoteRemaining?: number, now = Date.now()): Promise<string[]> {
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
  const ic = itemsCheck(item.note, item.links, item.files);
  if (!ic.ok) errs.push(ic.reason!);
  const fc = await filesCheck(item.files);
  if (!fc.ok) errs.push(fc.reason!);
  if (item.note.length > 8_000) errs.push(`note is ${item.note.length} characters (max 8000)`);
  const ss = screenshotCheck(item);
  if (!ss.ok) errs.push(ss.reason!);
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
  /** Live only: how many POSTs this call made (all with the same Idempotency-Key). */
  attempts?: number;
}


/** OpenAPI lists submissionsPerMarket; SDK 2.4.1's EvidenceLimits type does not yet. */
function submissionsPerMarketOf(limits: object): number | undefined {
  const v = (limits as { submissionsPerMarket?: unknown }).submissionsPerMarket;
  return typeof v === "number" ? v : undefined;
}

export async function submitItem(
  state: State,
  cfg: Config,
  id: string,
  opts: { live?: boolean; wait?: boolean; client?: EvidenceClient; timeoutMs?: number; now?: number; onSubmitted?: () => void; maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<SubmitOutcome> {
  const item = getItem(state, id);
  const now = opts.now ?? Date.now();
  const errs = await localChecks(state, item, undefined, now);
  if (errs.length) throw new Error(`blocked: ${errs.join("; ")}`);
  const files = await filesFor(item);
  ensureIdempotencyKey(item);
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
  // Official: check GET /v1/limits before every batch (hourly cap can change; Restricted tier is 1/market).
  const { data: limits } = await client.getLimits();
  if ((limits.submitsLeftThisHour ?? 0) <= 0) {
    throw new Error(`live submit refused: no submissions left this UTC hour (resets at ${limits.hourEndsAt ?? "the next hour"})`);
  }
  // SDK / official docs: check listSubmissions({ market }) before submitting, so the account never sends
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
  const remoteErrs = await localChecks(state, item, entry.remainingOnMarket, Date.now());
  if (remoteErrs.length) throw new Error(`blocked: ${remoteErrs.join("; ")}`);
  const perMarket = submissionsPerMarketOf(limits);
  if (perMarket !== undefined) {
    const cc = capCheck(state, item.market, { remoteRemaining: entry.remainingOnMarket, excludingItem: item.id, perMarket });
    if (!cc.ok) throw new Error(`blocked: ${cc.reason}`);
  }

  // Send with the item's fixed key. On a timeout / dropped connection the request may still have
  // landed (FAQ: it then shows up in GET /submissions), so: check our submissions on this market
  // first, and only if it is not there, resend with the SAME Idempotency-Key. Never a new key.
  const key = params.idempotencyKey;
  const maxAttempts = opts.maxAttempts ?? cfg.maxAttempts ?? 3;
  item.attempts ??= [];
  let sub: Submission | undefined;
  let attempt = 0;
  for (;;) {
    attempt++;
    if (item.idempotencyKey !== key) throw new Error("internal: Idempotency-Key changed between attempts"); // defensive; never expected
    try {
      ({ data: sub } = await client.submitEvidence({ ...params, idempotencyKey: key, files }));
      item.attempts.push({ at: new Date().toISOString(), idempotencyKey: key, outcome: "sent" });
      break;
    } catch (e) {
      if (e instanceof TermsNotAcceptedError) item.lastError = `terms_not_accepted (${e.terms.version})`;
      else if (e instanceof EvidenceApiError) item.lastError = `${e.code}${e.limit ? `/${e.limit}` : ""}: ${e.message}${e.retryable ? ` (retryable${e.retryAfterSeconds ? ` after ${e.retryAfterSeconds}s` : ""}; same Idempotency-Key will be reused)` : ""}`;
      else item.lastError = `network: ${(e as Error).message} (retry is safe: same Idempotency-Key)`;
      item.attempts.push({ at: new Date().toISOString(), idempotencyKey: key, outcome: item.lastError });
      const transient = isTransient(e);
      logEvent(cfg.dataDir, e instanceof EvidenceApiError
        ? { kind: "api_error", code: e.code, detail: `POST /submissions: ${e.message}`, market: item.market, itemId: item.id }
        : { kind: "network_error", detail: `POST /submissions: ${(e as Error).name}: ${(e as Error).message}`, market: item.market, itemId: item.id });
      if (!transient || attempt >= maxAttempts) throw new Error(`submit failed: ${item.lastError}${transient ? ` (gave up after ${attempt} attempt(s); run submit again later, the same key will be reused)` : ""}`);
      // Did it land anyway? GET /submissions?market=... and match it to this item.
      try {
        await syncMarket(state, client, item.market);
      } catch (e2) {
        logEvent(cfg.dataDir, { kind: "network_error", detail: `GET /submissions after a failed POST: ${(e2 as Error).message}`, market: item.market, itemId: item.id });
      }
      if ((item.status as string) === "submitted") { // syncMarket may have reconciled it
        const rec = state.submissions.find((s) => s.id === item.submissionId);
        item.lastError = undefined;
        item.attempts.push({ at: new Date().toISOString(), idempotencyKey: key, outcome: `found in GET /submissions as ${item.submissionId}; not re-sent` });
        logEvent(cfg.dataDir, { kind: "retry", detail: "POST failed but the submission had landed (found in GET /submissions); not re-sent", market: item.market, itemId: item.id, submissionId: item.submissionId });
        opts.onSubmitted?.();
        learn(state);
        return { mode: "live", itemId: item.id, submissionId: item.submissionId, status: rec?.status, verdict: rec?.verdict ?? null, reason: rec?.reason ?? null, alreadyLanded: true, attempts: attempt };
      }
      logEvent(cfg.dataDir, { kind: "retry", detail: `resending with the same Idempotency-Key (attempt ${attempt + 1} of ${maxAttempts})`, market: item.market, itemId: item.id });
      const ra = e instanceof EvidenceApiError && e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : undefined;
      await sleep(Math.min(ra ?? (opts.retryDelayMs ?? 2000) * attempt, 60_000));
    }
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
  return { mode: "live", itemId: item.id, submissionId: sub.id, status: rec2.status, verdict: rec2.verdict, reason: rec2.reason, attempts: attempt };
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
  // If the API echoes the Idempotency-Key on list entries (not in the published SDK types, but list entries
  // keep extra keys), that is the strongest match. Otherwise fall back to market + identical note.
  const echoed = (s as unknown as Record<string, unknown>).idempotencyKey;
  const byKey = typeof echoed === "string" ? state.items.find((i) => i.status === "approved" && !i.submissionId && i.idempotencyKey === echoed) : undefined;
  const it = byKey ?? state.items.find((i) => i.status === "approved" && !i.submissionId && i.market.toLowerCase() === rec.market.toLowerCase() && s.note !== null && sameNote(i.note, s.note));
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
