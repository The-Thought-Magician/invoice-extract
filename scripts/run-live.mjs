/**
 * Run the real pipeline over the fixture corpus with a real Gemini key.
 *
 * This is the first honest measurement the project can make. Everything up to
 * now has been either unit-tested logic or replayed answers; this puts ten
 * documents with exactly known ground truth through Gemini and reports how
 * often it was right, per field, split by digital versus scanned.
 *
 * That number is what ADR 0002 has been waiting for. Until it exists there is
 * no basis for opening the auto-approve gate.
 *
 *   GEMINI_API_KEY=... node scripts/run-live.mjs
 *
 * Options, all via environment:
 *   GEMINI_MODEL      default gemini-2.5-flash
 *   GEMINI_ENDPOINT   override the API base, used by the test stub
 *   EXTRACTION_RUNS   default 3
 *   OCR_DPI           default 300
 *   CONCURRENCY       documents in flight, default 2
 *   REPORT            output path, default fixtures/live-report.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FIELD_NAMES, decide, validate } from "../packages/core/src/index.ts";
import { mergeRuns } from "../packages/core/src/pipeline.ts";
import { GeminiFieldExtractor } from "../packages/adapters/src/gemini.ts";
import { PdfTextLayerReader } from "../packages/adapters/src/textLayer.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set. Nothing to measure without it.");
  process.exit(2);
}

const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const runsPerDocument = Number(process.env.EXTRACTION_RUNS ?? 3);
const concurrency = Number(process.env.CONCURRENCY ?? 2);
const reportPath = process.env.REPORT ?? `${ROOT}/fixtures/live-report.json`;

const extractor = new GeminiFieldExtractor({
  apiKey,
  model,
  ...(process.env.GEMINI_ENDPOINT ? { endpoint: process.env.GEMINI_ENDPOINT } : {}),
});
const textLayerReader = new PdfTextLayerReader({ dpi: Number(process.env.OCR_DPI ?? 300) });

const expected = JSON.parse(await readFile(`${ROOT}/fixtures/expected.json`, "utf8"));

console.log(`model ${model}, ${runsPerDocument} runs per document, ${expected.length} documents\n`);

/**
 * Comparison is normalised, because a difference of formatting is not a
 * difference of fact. "1,180.00" and "1180.00" are the same total; "1180.00"
 * and "1180.0" are the same too. Anything else is a genuine miss.
 */
function same(a, b) {
  const clean = (value) =>
    value === null || value === undefined
      ? ""
      : String(value).trim().toUpperCase().replace(/[\s,₹]/g, "").replace(/^RS\.?/, "");
  const left = clean(a);
  const right = clean(b);
  if (left === right) return true;
  const asNumber = (value) => (/^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null);
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  return leftNumber !== null && rightNumber !== null && leftNumber === rightNumber;
}

async function processDocument(entry) {
  const started = Date.now();
  const pdf = new Uint8Array(await readFile(`${ROOT}/fixtures/${entry.file}`));

  const layer = await textLayerReader.readDetailed(pdf);
  const runs = [];
  for (let index = 0; index < runsPerDocument; index += 1) {
    runs.push(await extractor.extract(pdf));
  }

  const extraction = mergeRuns(runs, layer.text);
  const findings = validate(extraction);
  const decision = decide(extraction, findings, { coldStart: false });

  const fields = {};
  for (const name of FIELD_NAMES) {
    const truth = entry.truth[name] ?? null;
    const got = extraction[name].value;
    fields[name] = {
      truth,
      got,
      correct: same(truth, got),
      grounded: extraction[name].grounded,
      unanimous: new Set(extraction[name].samples).size <= 1,
      samples: extraction[name].samples,
    };
  }

  return {
    slug: entry.slug,
    scanned: entry.scanned,
    textLayerSource: layer.source,
    textLayerLength: layer.text.length,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    route: decision.route,
    expectedRoute: entry.expect.route,
    routeAsExpected: decision.route === entry.expect.route,
    reasons: decision.reasons,
    findings: findings.map((finding) => finding.code),
    expectedFindings: entry.expect.codes,
    fields,
  };
}

/** Bounded concurrency: Gemini rate limits, and OCR is CPU bound. */
async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await worker(items[index]);
        } catch (error) {
          results[index] = {
            slug: items[index].slug,
            scanned: items[index].scanned,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }),
  );
  return results;
}

const results = await mapLimited(expected, concurrency, async (entry) => {
  const result = await processDocument(entry);
  const wrong = Object.entries(result.fields).filter(([, f]) => !f.correct);
  console.log(
    `${result.slug.padEnd(32)} ${result.scanned ? "scan   " : "digital"} ` +
      `${String(result.route).padEnd(13)} ${result.routeAsExpected ? "as expected" : "UNEXPECTED "} ` +
      `${12 - wrong.length}/12 fields  ${result.seconds}s`,
  );
  for (const [name, f] of wrong) {
    console.log(`    ${name}: expected ${JSON.stringify(f.truth)}, got ${JSON.stringify(f.got)}`);
  }
  return result;
});

const ok = results.filter((result) => !result.error);
const failed = results.filter((result) => result.error);

function accuracy(subset) {
  let correct = 0;
  let total = 0;
  for (const result of subset) {
    for (const name of FIELD_NAMES) {
      total += 1;
      if (result.fields[name].correct) correct += 1;
    }
  }
  return { correct, total, rate: total === 0 ? null : correct / total };
}

const perField = {};
for (const name of FIELD_NAMES) {
  const correct = ok.filter((result) => result.fields[name].correct).length;
  perField[name] = {
    correct,
    total: ok.length,
    rate: ok.length === 0 ? null : correct / ok.length,
    ungrounded: ok.filter((result) => result.fields[name].grounded !== true).length,
    disagreed: ok.filter((result) => !result.fields[name].unanimous).length,
  };
}

const digital = ok.filter((result) => !result.scanned);
const scanned = ok.filter((result) => result.scanned);

const summary = {
  model,
  runsPerDocument,
  documents: results.length,
  failedDocuments: failed.length,
  routeAsExpected: ok.filter((result) => result.routeAsExpected).length,
  fieldAccuracy: {
    overall: accuracy(ok),
    digital: accuracy(digital),
    scanned: accuracy(scanned),
  },
  reviewRate: ok.length === 0 ? null : ok.filter((r) => r.route === "review").length / ok.length,
  perField,
};

const percent = (rate) => (rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`);

console.log("\n--- summary ---");
console.log(`documents            ${summary.documents}, ${failed.length} failed`);
console.log(`routed as expected   ${summary.routeAsExpected}/${ok.length}`);
console.log(`field accuracy       ${percent(summary.fieldAccuracy.overall.rate)} overall`);
console.log(`  digital            ${percent(summary.fieldAccuracy.digital.rate)}`);
console.log(`  scanned            ${percent(summary.fieldAccuracy.scanned.rate)}`);
console.log(`review rate          ${percent(summary.reviewRate)}`);

console.log("\nper field (accuracy, ungrounded, runs disagreed)");
for (const [name, stats] of Object.entries(perField)) {
  console.log(
    `  ${name.padEnd(26)} ${percent(stats.rate).padStart(6)}  ` +
      `${String(stats.ungrounded).padStart(2)} ungrounded  ` +
      `${String(stats.disagreed).padStart(2)} disagreed`,
  );
}

for (const failure of failed) {
  console.log(`\nFAILED ${failure.slug}: ${failure.error}`);
}

await writeFile(reportPath, JSON.stringify({ summary, results }, null, 2) + "\n");
console.log(`\nreport written to ${reportPath}`);

console.log(
  "\nThis is ten documents. It is a smoke test of the pipeline against a real\n" +
    "model, not the measurement that opens the auto-approve gate. That one comes\n" +
    "from the correction table, on your own invoices, at a few hundred documents.",
);

process.exit(failed.length > 0 ? 1 : 0);
