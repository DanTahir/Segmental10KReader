import { readFileSync } from "node:fs";
import { evidenceFilePath } from "@/lib/evidence";

// Reads rendered page images off disk, so this must be Node.
export const runtime = "nodejs";

/**
 * GET /api/evidence?file=<name>.png -- serve one cached PDF page render.
 *
 * The images live in data/evidence/, outside the build output and outside
 * public/, for the same reason run history does: they must survive rebuilds and
 * they are generated at run time. That means they cannot be served statically,
 * hence this route. Path validation lives in evidenceFilePath.
 */
export async function GET(request: Request) {
  const file = new URL(request.url).searchParams.get("file");
  if (!file) {
    return new Response("missing file parameter", { status: 400 });
  }

  const full = evidenceFilePath(file);
  if (!full) {
    // Also the path for runs whose images were never generated or have been
    // cleaned up -- the UI treats a 404 as "no thumbnail" and carries on.
    return new Response("not found", { status: 404 });
  }

  const bytes = readFileSync(full);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      // The filename embeds the PDF's size, the page and the DPI, so a given
      // URL's bytes can never change: safe to cache immutably.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
