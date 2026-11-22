// Part 6 helper: which side does a fact argue? Threshold questions ("above 3.0%") compare the
// figure in the fact; event questions use outcome words. Anything unclear -> null, and a human
// must set the side before approval.
import type { SideCall } from "./types.ts";

const UP = "above|over|exceed(?:s|ing)?|more than|greater than|higher than|at least|reach(?:es)?|hit|top";
const DOWN = "below|under|less than|lower than|at most|fall below|drop below";
const THRESH = new RegExp(`\\b(${UP}|${DOWN})\\s+\\$?(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*(%|percent|k|m|bn|billion|million|thousand)?`, "i");

const unitOf = (u?: string) => (!u ? "" : /%|percent/i.test(u) ? "%" : u.toLowerCase());

interface Num { v: number; unit: string; at: number }

export function numbersIn(s: string): Num[] {
  const out: Num[] = [];
  const re = /(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent|k\b|m\b|bn\b|billion|million|thousand)?/gi;
  let m: RegExpExecArray | null;
  const masked = s
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (x) => " ".repeat(x.length))
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?/gi, (x) => " ".repeat(x.length))
    .replace(/\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/gi, (x) => " ".repeat(x.length));
  while ((m = re.exec(masked))) {
    const v = Number(m[1].replace(/,/g, ""));
    const unit = unitOf(m[2]);
    if (!unit && Number.isInteger(v) && v >= 1900 && v <= 2100) continue; // a year
    out.push({ v, unit, at: m.index });
  }
  return out;
}

const YES_WORDS = /\b(approved|passed|signed|confirmed|announced|launched|completed|won|elected|cut|raised|enacted|ratified)\b/i;
const NO_WORDS = /\b(rejected|failed|vetoed|denied|postponed|delayed|cancel(?:l)?ed|ruled out|withdrawn|blocked|held steady|unchanged|lost|suspended)\b/i;

export function inferSide(question: string, fact: string): SideCall {
  const t = THRESH.exec(question);
  if (t) {
    const dir = new RegExp(`^(${UP})$`, "i").test(t[1]) ? "up" : "down";
    const inclusive = /at least|at most|reach|hit/i.test(t[1]);
    const th = Number(t[2].replace(/,/g, ""));
    const unit = unitOf(t[3]);
    const cands = numbersIn(fact).filter((n) => n.unit === unit);
    const distinct = [...new Set(cands.map((c) => c.v))];
    if (distinct.length === 1) {
      const v = distinct[0];
      const yes = dir === "up" ? (inclusive ? v >= th : v > th) : inclusive ? v <= th : v < th;
      return { side: yes ? "YES" : "NO", confidence: "medium", reason: `fact figure ${v}${unit} vs threshold ${dir === "up" ? ">" : "<"}${inclusive ? "=" : ""} ${th}${unit}` };
    }
    if (distinct.length > 1) return { side: null, confidence: "none", reason: `several figures (${distinct.join(", ")}); human must pick the side` };
    return { side: null, confidence: "none", reason: "no figure in the fact matching the question's unit" };
  }
  const y = YES_WORDS.test(fact), n = NO_WORDS.test(fact);
  if (y && !n) return { side: "YES", confidence: "low", reason: `outcome word "${YES_WORDS.exec(fact)![1]}"` };
  if (n && !y) return { side: "NO", confidence: "low", reason: `outcome word "${NO_WORDS.exec(fact)![1]}"` };
  return { side: null, confidence: "none", reason: y && n ? "mixed outcome words" : "no clear direction" };
}
