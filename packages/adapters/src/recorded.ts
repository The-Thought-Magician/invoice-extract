/**
 * A field extractor that replays recorded answers, keyed by the document.
 *
 * This exists because the end to end suite has to be deterministic and has to
 * run without an API key or network access. It is the same shape as the Gemini
 * adapter, so everything downstream of extraction is exercised for real: the
 * text layer, grounding, validation, routing, the database and the UI.
 *
 * It is not a substitute for measuring extraction accuracy against Gemini. That
 * measurement is what the correction table is for.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ExtractionRun, FieldExtractor } from "@invoice-extract/core";

export interface RecordedDocument {
  /** sha256 of the PDF bytes. */
  readonly digest: string;
  readonly slug: string;
  /** One entry per independent run, cycled if fewer than the configured runs. */
  readonly runs: readonly ExtractionRun[];
}

export function digestOf(pdf: Uint8Array): string {
  return createHash("sha256").update(pdf).digest("hex");
}

export class RecordedFieldExtractor implements FieldExtractor {
  private readonly byDigest = new Map<string, RecordedDocument>();
  private readonly cursors = new Map<string, number>();

  constructor(documents: readonly RecordedDocument[]) {
    for (const document of documents) this.byDigest.set(document.digest, document);
  }

  static async fromFile(path: string): Promise<RecordedFieldExtractor> {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RecordedDocument[];
    return new RecordedFieldExtractor(parsed);
  }

  async extract(pdf: Uint8Array): Promise<ExtractionRun> {
    const digest = digestOf(pdf);
    const document = this.byDigest.get(digest);
    if (!document) {
      // An unrecorded document produces an empty extraction rather than an
      // error. The pipeline then rejects it for missing Rule 46 particulars,
      // which is the honest outcome: nothing was read off it.
      return {};
    }
    const cursor = this.cursors.get(digest) ?? 0;
    this.cursors.set(digest, cursor + 1);
    return document.runs[cursor % document.runs.length] as ExtractionRun;
  }
}
