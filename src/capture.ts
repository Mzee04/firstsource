// Builds the evidence package for one fact: link-only when the judge can read the page, otherwise
// the fallback (key text quoted in the note + a dated text-PDF capture), and for hard-to-fetch
// sources a dated PNG screenshot (URL + date visible) as well. Never more than 3 files.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Fact, PreflightResult, QueueItem, Side } from "./types.ts";
import { MAX_FILES } from "./rules.ts";
import { textPdf } from "./pdf.ts";
import { draftNote } from "./drafter.ts";
import { captureScreenshot, findChrome, type ScreenshotResult } from "./screenshot.ts";
import { hasImage, screenshotReason } from "./hardsource.ts";
import { logEvent } from "./feedbacklog.ts";

export type Capturer = (url: string, outFile: string, now: number) => Promise<ScreenshotResult>;

/** Headless-Chrome capturer, or null when screenshots are off or no browser is installed. */
export function defaultCapturer(cfg: Config): Capturer | null {
  if (cfg.screenshot === "off") return null;
  const chrome = findChrome(cfg.chrome);
  if (!chrome) return null;
  return (url, outFile, now) => captureScreenshot(url, outFile, { chrome, now });
}

const IMG = new Set([".png", ".jpg", ".jpeg"]);

export function checkScreenshotFile(file: string): string {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`no screenshot file ${abs}`);
  if (!IMG.has(path.extname(abs).toLowerCase())) throw new Error(`screenshot must be .png, .jpg or .jpeg (got ${path.basename(abs)})`);
  if (fs.statSync(abs).size === 0) throw new Error(`screenshot ${abs} is empty`);
  return abs;
}

export interface Evidence {
  mode: "link" | "fallback";
  files: string[];
  requiresScreenshot: boolean;
  screenshotReason?: string;
  screenshotError?: string;
  note: string;
}

export async function buildEvidence(a: {
  cfg: Config; id: string; market: string; question: string; fact: Fact; side: Side | null; pf: PreflightResult;
  hardHosts: string[]; forced?: boolean; keyText?: string; userScreenshot?: string; capture?: Capturer | null; now: number;
}): Promise<Evidence> {
  const reason = screenshotReason(a.fact.source, a.pf, a.hardHosts);
  const mode: Evidence["mode"] = a.pf.readable && !a.forced && !reason ? "link" : "fallback";
  const files: string[] = [];
  const dir = path.join(a.cfg.dataDir, "captures");
  let screenshotError: string | undefined;
  if (a.userScreenshot) files.push(checkScreenshotFile(a.userScreenshot));
  if (mode === "fallback") {
    fs.mkdirSync(dir, { recursive: true });
    const quote = a.keyText?.trim() || a.fact.text;
    const file = path.join(dir, `${a.id}-capture-${a.pf.checkedAt.slice(0, 10)}.pdf`);
    fs.writeFileSync(file, textPdf(`Dated capture for Delphi evidence (FirstSource) - ${a.pf.checkedAt}`, `Source URL: ${a.fact.source}\nPublisher: ${a.fact.publisher}\nFact date: ${a.fact.date}\nCaptured (UTC): ${a.pf.checkedAt}\nWhy a capture: ${[...a.pf.reasons, reason].filter(Boolean).join("; ")}\n\nKey text, quoted from the source:\n"${quote}"\n\nMarket: ${a.question}`));
    files.push(file);
    if (!hasImage(files) && a.capture && files.length < MAX_FILES) {
      const out = path.join(dir, `${a.id}-screenshot-${new Date(a.now).toISOString().slice(0, 10)}.png`);
      const r = await a.capture(a.fact.source, out, a.now);
      if (r.ok && r.file) files.push(r.file);
      else {
        screenshotError = r.error ?? "screenshot failed";
        logEvent(a.cfg.dataDir, { kind: "screenshot_failure", detail: screenshotError, url: a.fact.source, market: a.market, itemId: a.id });
      }
    }
  }
  if (files.length > MAX_FILES) files.length = MAX_FILES;
  const note = draftNote({ question: a.question, fact: a.fact, side: a.side, preflight: { ...a.pf, readable: mode === "link" }, max: a.cfg.noteMax, screenshot: !!reason || hasImage(files), keyText: a.keyText });
  return { mode, files, requiresScreenshot: !!reason, screenshotReason: reason ?? undefined, screenshotError, note };
}

/** Recompute the note (e.g. after a reviewer changes the side or attaches a screenshot). */
export function redraftItem(item: QueueItem, maxLen = 1200): void {
  item.note = draftNote({ question: item.question, fact: item.fact, side: item.side, preflight: { ...item.preflight, readable: item.mode === "link" }, max: maxLen, screenshot: !!item.requiresScreenshot || hasImage(item.files) });
}
