// Builds the evidence package for one fact: link-only when the judge can read the page, otherwise
// a fallback. Official cap is 3 items total (note + each link + each file). For hard-to-fetch
// sources we attach a dated PNG screenshot (URL + date visible) and skip the extra text-PDF so
// note + link + screenshot stays at 3. A text-PDF is used only when no screenshot is present.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import type { Fact, PreflightResult, QueueItem, Side } from "./types.ts";
import { MAX_FILES, MAX_ITEMS, itemCount } from "./rules.ts";
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
  // Official cap: note + each link + each file <= 3. We always send a note and the source link,
  // so at most one file. Prefer a dated screenshot; only write a text-PDF when there is no image.
  const roomForFile = () => MAX_ITEMS - itemCount("x", [a.fact.source], files);
  if (mode === "fallback") {
    fs.mkdirSync(dir, { recursive: true });
    if (!hasImage(files) && a.capture && roomForFile() > 0) {
      const out = path.join(dir, `${a.id}-screenshot-${new Date(a.now).toISOString().slice(0, 10)}.png`);
      const r = await a.capture(a.fact.source, out, a.now);
      if (r.ok && r.file) files.push(r.file);
      else {
        screenshotError = r.error ?? "screenshot failed";
        logEvent(a.cfg.dataDir, { kind: "screenshot_failure", detail: screenshotError, url: a.fact.source, market: a.market, itemId: a.id });
      }
    }
    if (!hasImage(files) && !reason && roomForFile() > 0) {
      // Unreadable but not a hard host: a text-PDF capture is the fallback attachment.
      const quote = a.keyText?.trim() || a.fact.text;
      const file = path.join(dir, `${a.id}-capture-${a.pf.checkedAt.slice(0, 10)}.pdf`);
      const body = [
        `Source URL: ${a.fact.source}`,
        `Publisher: ${a.fact.publisher}`,
        `Fact date: ${a.fact.date}`,
        `Captured (UTC): ${a.pf.checkedAt}`,
        `Why a capture: ${[...a.pf.reasons, reason].filter(Boolean).join("; ")}`,
        "",
        "Key text, quoted from the source:",
        `"${quote}"`,
        "",
        `Market: ${a.question}`,
      ].join("\n");
      fs.writeFileSync(file, textPdf(`Dated capture for Delphi evidence (FirstSource) - ${a.pf.checkedAt}`, body));
      files.push(file);
    }
    // If this is a hard source and no screenshot could be captured, leave files empty so the
    // reviewer can attach one (note + link + screenshot = 3). Do not also add a PDF.
  }
  if (files.length > MAX_FILES) files.length = MAX_FILES;
  while (itemCount("x", [a.fact.source], files) > MAX_ITEMS) files.pop();

  const note = draftNote({ question: a.question, fact: a.fact, side: a.side, preflight: { ...a.pf, readable: mode === "link" }, max: a.cfg.noteMax, screenshot: !!reason || hasImage(files), keyText: a.keyText });
  return { mode, files, requiresScreenshot: !!reason, screenshotReason: reason ?? undefined, screenshotError, note };
}

/** Recompute the note (e.g. after a reviewer changes the side or attaches a screenshot). */
export function redraftItem(item: QueueItem, maxLen = 1200): void {
  item.note = draftNote({ question: item.question, fact: item.fact, side: item.side, preflight: { ...item.preflight, readable: item.mode === "link" }, max: maxLen, screenshot: !!item.requiresScreenshot || hasImage(item.files) });
}
