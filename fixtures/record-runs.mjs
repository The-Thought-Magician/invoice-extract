/**
 * Build the recorded extraction runs used by the end to end suite.
 *
 * Each fixture gets three runs. Most are unanimous and match what is printed on
 * the page, which is what a competent model does on a clean document. Three are
 * given deliberate variation so the pipeline's disagreement and grounding paths
 * are exercised by the suite rather than only by unit tests:
 *
 *   03  one run misreads a digit in the total, so the runs disagree
 *   07  every run agrees on a value that is not on the page, a fabrication that
 *       only grounding can catch
 *   05  the model faithfully reports the wrong total the document itself prints,
 *       which grounding cannot catch and only arithmetic can
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const expected = JSON.parse(await readFile(`${HERE}expected.json`, "utf8"));

const VARIATIONS = {
  "03-five-percent-slab": (truth) => [
    truth,
    truth,
    // A single transposed digit in run three. The modal answer still wins, but
    // the field is marked as disagreeing and the invoice goes to a human.
    { ...truth, totalValue: "13020.00".replace("13020", "13200") },
  ],
  "07-scan-clean-inter-state": (truth) => {
    // Unanimous but wrong: a plausible looking recipient GSTIN that is not
    // printed anywhere on the document. Agreement cannot catch this, and the
    // arithmetic does not involve it. Only grounding can.
    const fabricated = { ...truth, recipientGstin: "27AAGCB7383J1Z8".replace("B7383J", "B7384J") };
    return [fabricated, fabricated, fabricated];
  },
};

// Where a variation is applied, the expected route has to move with it: a
// document that is clean on paper still goes to a human if the model wobbled or
// invented a value. Recording that here keeps one source of truth for the suite.
const VARIED_ROUTE_REASON = {
  "03-five-percent-slab": "recorded runs disagree on the total",
  "07-scan-clean-inter-state": "recorded runs agree on a recipient GSTIN that is not on the page",
};

const documents = [];
for (const entry of expected) {
  const pdf = new Uint8Array(await readFile(`${HERE}${entry.file}`));
  const digest = createHash("sha256").update(pdf).digest("hex");
  const truth = entry.truth;
  const runs = VARIATIONS[entry.slug]?.(truth) ?? [truth, truth, truth];
  documents.push({ digest, slug: entry.slug, runs });

  if (VARIED_ROUTE_REASON[entry.slug]) {
    entry.expect.route = "review";
    entry.expect.becauseOfRecording = VARIED_ROUTE_REASON[entry.slug];
  }
}

await writeFile(`${HERE}expected.json`, JSON.stringify(expected, null, 2) + "\n");

await writeFile(`${HERE}recorded-runs.json`, JSON.stringify(documents, null, 2) + "\n");
console.log(`recorded ${documents.length} documents`);
