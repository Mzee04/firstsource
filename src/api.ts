import { EvidenceClient, type Submission } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Config } from "./config.ts";
import type { SubmissionRecord } from "./types.ts";

export const API_TIMEOUT_MS = 60_000;

/**
 * The SDK passes no AbortSignal on most calls (submitEvidence, getEntryState, getTerms...), so a
 * stalled connection would hang forever. Add a per-request timeout; a timed-out submit is safe to
 * retry because the Idempotency-Key is fixed per item.
 */
export function withTimeout(f: typeof fetch, ms = API_TIMEOUT_MS): typeof fetch {
  return (input, init = {}) => {
    const t = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, t]) : t;
    return f(input, { ...init, signal });
  };
}

export function makeClient(cfg: Config, fetchImpl?: typeof fetch, timeoutMs = API_TIMEOUT_MS): EvidenceClient {
  if (!cfg.apiUrl || !cfg.apiKey) throw new Error("DELPHI_API_URL and DELPHI_API_ACCESS_KEY must be set (values are never printed)");
  return new EvidenceClient({
    baseUrl: cfg.apiUrl,
    apiKey: cfg.apiKey,
    agentId: cfg.agentId,
    agentHarness: cfg.agentHarness,
    agentModel: cfg.agentModel,
    fetch: withTimeout(fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), timeoutMs),
  });
}

export function recordFrom(sub: Submission, itemId: string | null, fallbackMarket?: string, now = Date.now()): SubmissionRecord {
  const m = sub.markets?.[0];
  return {
    id: sub.id,
    market: m?.marketAddress ?? fallbackMarket ?? "unknown",
    itemId,
    note: sub.note,
    links: sub.links ?? [],
    status: sub.status,
    verdict: m?.verdict ?? null,
    reason: m?.reason ?? null,
    bounty: m?.bounty ?? null,
    createdAt: sub.createdAt,
    updatedAt: new Date(now).toISOString(),
  };
}
