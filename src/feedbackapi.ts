// Official feedback API: https://feedback.delphi.fyi (POST /v1/feedback).
// Nothing here runs unless the operator sets FIRSTSOURCE_SEND_FEEDBACK=1 and supplies a
// reviewed payload. The API key is sent as x-api-key and is never logged or printed.
import { ENV } from "./config.ts";
import type { Config } from "./config.ts";

export const FEEDBACK_AREAS = ["api", "keys", "markets", "judging", "rewards", "docs", "site", "other"] as const;
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

/** Map local log categories onto the official `area` values. */
export function mapArea(category: string): FeedbackArea {
  switch (category) {
    case "bug":
    case "api":
      return "api";
    case "docs":
      return "docs";
    case "judge":
      return "judging";
    case "ux":
      return "site";
    case "idea":
    default:
      return FEEDBACK_AREAS.includes(category as FeedbackArea) ? (category as FeedbackArea) : "other";
  }
}

export interface FeedbackPayload {
  wallet: string;
  area: FeedbackArea;
  text: string;
  title?: string;
  marketId?: string;
  submissionId?: string;
  topic?: "agent-competition-evidence-mining";
}

export function buildFeedbackPayload(input: {
  wallet: string;
  area: string;
  text: string;
  title?: string;
  marketId?: string;
  submissionId?: string;
}): FeedbackPayload {
  const wallet = input.wallet.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("DELPHI_WALLET_ADDRESS must be 0x followed by 40 hex characters (the wallet the API key was created with)");
  const area = mapArea(input.area);
  const text = input.text.trim();
  if (!text || text.length > 4000) throw new Error("feedback text must be 1 to 4000 characters");
  const title = input.title?.trim();
  if (title && title.length > 120) throw new Error("feedback title must be at most 120 characters");
  const submissionId = input.submissionId?.trim();
  if (submissionId && !/^[\x20-\x7e]{1,64}$/.test(submissionId)) throw new Error("submissionId must be 1 to 64 printable ASCII characters");
  return {
    wallet,
    area,
    text,
    ...(title ? { title } : {}),
    ...(input.marketId?.trim() ? { marketId: input.marketId.trim() } : {}),
    ...(submissionId ? { submissionId } : {}),
    topic: "agent-competition-evidence-mining",
  };
}

/**
 * POST one feedback entry. Refuses unless FIRSTSOURCE_SEND_FEEDBACK=1.
 * Never prints the key. Returns the 201 body { id, createdAt }.
 */
export async function sendFeedback(
  cfg: Config,
  input: { area: string; text: string; title?: string; marketId?: string; submissionId?: string },
  opts: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): Promise<{ id: string; createdAt: string }> {
  const env = opts.env ?? process.env;
  if (env[ENV.sendFeedback] !== "1") {
    throw new Error("feedback not sent: set FIRSTSOURCE_SEND_FEEDBACK=1 after you have reviewed the text");
  }
  if (!cfg.apiKey) throw new Error("DELPHI_API_ACCESS_KEY must be set (the value is never printed)");
  const wallet = cfg.wallet;
  if (!wallet) throw new Error("DELPHI_WALLET_ADDRESS must be set to the wallet the API key was created with");
  const body = buildFeedbackPayload({ ...input, wallet });
  const base = cfg.feedbackUrl.replace(/\/$/, "");
  const res = await (opts.fetch ?? fetch)(`${base}/v1/feedback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "X-Agent-Id": cfg.agentId,
      "X-Agent-Harness": cfg.agentHarness,
      ...(cfg.agentModel ? { "X-Agent-Model": cfg.agentModel } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (res.status !== 201) {
    throw new Error(`feedback API ${res.status}: ${raw.slice(0, 300)}`);
  }
  return JSON.parse(raw) as { id: string; createdAt: string };
}
