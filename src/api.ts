import { EvidenceApiError, EvidenceClient, TermsNotAcceptedError, type Submission } from "@gensyn-ai/gensyn-delphi-sdk";
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
  if (!cfg.apiKey) throw new Error("DELPHI_API_ACCESS_KEY must be set (the value is never printed)");
  if (!cfg.apiUrl) throw new Error("DELPHI_API_URL must be set (the value is never printed)");
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

/** Human-readable API error; never includes the key. */
export function explainEvidenceError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof EvidenceApiError ? e.code : e instanceof TermsNotAcceptedError ? "terms_not_accepted" : undefined;
  const status = e instanceof EvidenceApiError ? e.status : undefined;
  const requestId = e instanceof EvidenceApiError ? (e as { requestId?: string }).requestId : undefined;
  const hint =
    status === 401 || code === "unauthorized"
      ? "401 means the key is missing, wrong, or a Testnet key. Create a Mainnet key at https://api-access.delphi.fyi (same sign-in as Delphi) and set it as DELPHI_API_ACCESS_KEY."
      : status === 404 || code === "not_found"
        ? "404 on every call means the account does not have evidence access yet: the DoraHacks wallet may not match the Delphi profile wallet, or access has not synced (up to 1 hour)."
        : code === "terms_not_accepted" || (e instanceof TermsNotAcceptedError)
          ? "The account has not accepted the current evidence terms. Run `npm run fs -- terms`, read the URL, and only then `FIRSTSOURCE_ACCEPT_TERMS=<version> npm run fs -- accept-terms`."
          : code === "forbidden"
            ? "403 forbidden: the request was refused (for example a restricted region)."
            : "";
  const id = requestId ? ` requestId=${requestId}` : "";
  return hint ? `${msg}${id}. ${hint}` : `${msg}${id}`;
}
