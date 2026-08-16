/**
 * A local stand-in for the Gemini generateContent endpoint.
 *
 * It exists so `run-live.mjs` can be exercised end to end without an API key,
 * and so the runner is proven before anyone spends real requests on it. It
 * answers from the recorded fixture runs, keyed by the sha256 of the PDF it is
 * sent, which means the multipart encoding, the base64 payload, the response
 * parsing and the whole downstream pipeline are all genuinely exercised.
 *
 * It does not tell you anything about how well Gemini reads invoices. Only a
 * real key does that.
 *
 *   node scripts/stub-gemini.mjs 3199 &
 *   GEMINI_API_KEY=stub GEMINI_ENDPOINT=http://127.0.0.1:3199/v1beta \
 *     node scripts/run-live.mjs
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] ?? 3199);

const recorded = JSON.parse(readFileSync(`${ROOT}/fixtures/recorded-runs.json`, "utf8"));
const byDigest = new Map(recorded.map((document) => [document.digest, document]));
const cursors = new Map();

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (!request.headers["x-goog-api-key"]) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "no api key header" }));
      return;
    }

    let fields = {};
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const inline = body.contents[0].parts[1].inline_data;
      if (inline.mime_type !== "application/pdf") throw new Error("wrong mime type");

      const pdf = Buffer.from(inline.data, "base64");
      const digest = createHash("sha256").update(pdf).digest("hex");
      const document = byDigest.get(digest);
      if (document) {
        const cursor = cursors.get(digest) ?? 0;
        cursors.set(digest, cursor + 1);
        fields = document.runs[cursor % document.runs.length];
      }
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(fields) }] } }],
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`stub Gemini listening on http://127.0.0.1:${port}/v1beta`);
});
