import path from "node:path";

// Env var NAMES only. Values come from the environment on day one; nothing is hard-coded.
export const ENV = {
  site: "COMPETITION_SITE_URL", // competition site; /markets.json is read from it
  apiUrl: "DELPHI_API_URL", // evidence API base incl. /v1
  apiKey: "DELPHI_API_ACCESS_KEY", // DELPHI_API_KEY is read as a fallback (same as the starter)
  apiKeyLegacy: "DELPHI_API_KEY",
  agentId: "AGENT_ID",
  agentIdOfficial: "DELPHI_AGENT_ID",
  agentModel: "AGENT_MODEL",
  agentModelOfficial: "DELPHI_AGENT_MODEL",
  agentHarness: "AGENT_HARNESS",
  agentHarnessOfficial: "DELPHI_AGENT_HARNESS",
  wallet: "DELPHI_WALLET_ADDRESS",
  feedbackUrl: "DELPHI_FEEDBACK_URL",
  sendFeedback: "FIRSTSOURCE_SEND_FEEDBACK", // must be "1" to POST feedback; never default
  hardHosts: "FIRSTSOURCE_HARD_HOSTS", // extra hard-to-fetch hosts, comma separated
  screenshot: "FIRSTSOURCE_SCREENSHOT", // "auto" (default: capture with headless Chrome if found) or "off"
  chrome: "FIRSTSOURCE_CHROME", // path to Chrome/Chromium for screenshots
  maxAttempts: "FIRSTSOURCE_MAX_ATTEMPTS", // live send attempts on timeout/network error (same key), 1-5
  live: "FIRSTSOURCE_LIVE", // must be "1" for any real submit
  acceptTerms: "FIRSTSOURCE_ACCEPT_TERMS", // must equal the terms version for accept-terms to run
  dataDir: "FIRSTSOURCE_DATA_DIR",
  sources: "FIRSTSOURCE_SOURCES", // path to sources config (calendars + regional)
  noteMax: "FIRSTSOURCE_NOTE_MAX",
  perMarket: "FIRSTSOURCE_PER_MARKET",
  marketsFile: "FIRSTSOURCE_MARKETS_FILE", // optional local markets.json instead of the site
} as const;

export interface Config {
  siteUrl?: string;
  apiUrl?: string;
  apiKey?: string;
  agentId: string;
  agentModel?: string;
  agentHarness: string;
  hardHosts: string[];
  screenshot: "auto" | "off";
  chrome?: string;
  maxAttempts: number;
  live: boolean;
  dataDir: string;
  sourcesFile: string;
  noteMax: number;
  perMarket: number;
  marketsFile?: string;
  wallet?: string;
  feedbackUrl: string;
}

/** Positive integer from env, else the default. Rejects junk loudly instead of letting NaN disable a cap. */
export function intEnv(raw: string | undefined, def: number, name: string, min = 1, max = 100_000): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** SDK: X-Agent-* headers must be 1 to 64 printable ASCII characters. */
export function headerValue(raw: string | undefined, def: string | undefined, name: string): string | undefined {
  const v = raw === undefined || raw === "" ? def : raw;
  if (v === undefined) return undefined;
  if (!/^[\x20-\x7e]{1,64}$/.test(v)) throw new Error(`${name} must be 1 to 64 printable ASCII characters`);
  return v;
}

export const DEFAULT_SITE_URL = "https://competition.delphi.fyi";
export const DEFAULT_API_URL = "https://delphi.fyi/v1";
export const DEFAULT_FEEDBACK_URL = "https://feedback.delphi.fyi";
export const AGENT_HARNESS = "firstsource/0.3 (node; gensyn-delphi-sdk 2.4.1)";


function screenshotMode(raw: string | undefined): "auto" | "off" {
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "off" || raw === "0") return "off";
  throw new Error(`${ENV.screenshot} must be "auto" or "off"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const first = (...names: string[]) => {
    for (const n of names) {
      const v = env[n];
      if (v !== undefined && v !== "") return v;
    }
    return undefined;
  };
  return {
    siteUrl: first(ENV.site) || DEFAULT_SITE_URL,
    apiUrl: first(ENV.apiUrl) || DEFAULT_API_URL,
    apiKey: first(ENV.apiKey, ENV.apiKeyLegacy),
    agentId: headerValue(first(ENV.agentId, ENV.agentIdOfficial), "firstsource", ENV.agentId)!,
    // The contest asks agents to send ID, harness and model. FirstSource uses no LLM.
    agentModel: headerValue(first(ENV.agentModel, ENV.agentModelOfficial), "rule-based (no LLM)", ENV.agentModel),
    agentHarness: headerValue(first(ENV.agentHarness, ENV.agentHarnessOfficial), AGENT_HARNESS, ENV.agentHarness)!,
    hardHosts: (env[ENV.hardHosts] ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    screenshot: screenshotMode(env[ENV.screenshot]),
    chrome: env[ENV.chrome] || undefined,
    maxAttempts: intEnv(env[ENV.maxAttempts], 3, ENV.maxAttempts, 1, 5),
    live: env[ENV.live] === "1",
    dataDir: path.resolve(env[ENV.dataDir] || "data"),
    sourcesFile: path.resolve(env[ENV.sources] || "config/sources.json"),
    noteMax: intEnv(env[ENV.noteMax], 1200, ENV.noteMax, 200, 8_000),
    perMarket: intEnv(env[ENV.perMarket], 2, ENV.perMarket, 1, 3),
    marketsFile: env[ENV.marketsFile] || undefined,
    wallet: first(ENV.wallet),
    feedbackUrl: (first(ENV.feedbackUrl) || DEFAULT_FEEDBACK_URL).replace(/\/$/, ""),
  };
}

/** Safe to print: never includes the key, only whether one is set. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    siteUrl: c.siteUrl ?? "(unset)",
    apiUrl: c.apiUrl ?? "(unset)",
    apiKey: c.apiKey ? "(set)" : "(unset)",
    agentId: c.agentId,
    agentModel: c.agentModel ?? "(unset)",
    agentHarness: c.agentHarness,
    hardHosts: c.hardHosts,
    screenshot: c.screenshot,
    maxAttempts: c.maxAttempts,
    noteMax: c.noteMax,
    perMarket: c.perMarket,
    live: c.live,
    dataDir: c.dataDir,
    sourcesFile: c.sourcesFile,
    marketsFile: c.marketsFile ?? "(unset)",
    wallet: c.wallet ? "(set)" : "(unset)",
    feedbackUrl: c.feedbackUrl,
  };
}

export const USER_AGENT = "FirstSource/0.3 (+evidence preflight; plain fetch, no JS)";
