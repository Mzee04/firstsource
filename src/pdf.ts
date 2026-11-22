// Minimal one-page PDF writer (Helvetica, plain text). Used for the dated "capture" file attached
// when a link fails the preflight. It is a text capture, not a screenshot: a real screenshot can be
// added with `attach`.
const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");

function wrap(text: string, width = 92): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/)) {
      if ((line + " " + w).trim().length > width) { out.push(line); line = w; } else line = (line + " " + w).trim();
    }
    out.push(line);
  }
  return out;
}

export function textPdf(title: string, body: string): Buffer {
  const lines = [title, "", ...wrap(body)].slice(0, 62);
  const content = ["BT", "/F1 10 Tf", "12 TL", "50 800 Td", ...lines.map((l, i) => `${i === 0 ? "" : "T* "}(${esc(l)}) Tj`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
