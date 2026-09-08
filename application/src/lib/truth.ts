import fs from "node:fs";
import path from "node:path";
import type { AnswerKey } from "./types";
import { DATA_DIR } from "./pdftext";

let cached: AnswerKey | null = null;

export function loadAnswerKey(): AnswerKey {
  if (cached) return cached;
  const p = path.join(DATA_DIR, "truth", "answer_key.json");
  if (!fs.existsSync(p)) {
    throw new Error(
      "data/truth/answer_key.json missing. Run: npm run prepare-data"
    );
  }
  cached = JSON.parse(fs.readFileSync(p, "utf8")) as AnswerKey;
  return cached;
}

export function pdfPathFor(pdfFile: string): string {
  return path.join(DATA_DIR, "pdfs", pdfFile);
}
