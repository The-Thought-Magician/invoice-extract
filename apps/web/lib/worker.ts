/**
 * The background worker.
 *
 * Upload never blocks on Gemini or Tesseract. It writes a row and returns; this
 * drains the queue. Claiming uses `for update skip locked`, so running several
 * workers is safe.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  type ExtractionRun,
  type FieldExtractor,
  type TextLayerReader,
  Route,
  processInvoice,
} from "@invoice-extract/core";
import {
  GeminiFieldExtractor,
  PdfTextLayerReader,
  RecordedFieldExtractor,
  ReplayFieldExtractor,
  type RecordedDocument,
} from "@invoice-extract/adapters";

import {
  claimNextQueued,
  markAuditSample,
  markFailed,
  saveResult,
  shouldAuditSample,
} from "./store";
import { storagePath } from "./storage";

export interface WorkerConfig {
  readonly extractor: FieldExtractor;
  readonly textLayerReader: TextLayerReader;
  readonly runs: number;
  readonly coldStart: boolean;
  readonly auditSampleRate: number;
  readonly model: string;
}

/**
 * Recording extractions per run lets the worker report the raw model output
 * without the pipeline having to hand it back through its return type.
 */
class RecordingExtractor implements FieldExtractor {
  readonly runs: ExtractionRun[] = [];
  constructor(private readonly inner: FieldExtractor) {}
  async extract(pdf: Uint8Array): Promise<ExtractionRun> {
    const run = await this.inner.extract(pdf);
    this.runs.push(run);
    return run;
  }
}

let cachedConfig: WorkerConfig | null = null;

/**
 * Built once per process.
 *
 * Rebuilding it per request re-read the recorded-runs file synchronously on the
 * event loop every time, and handed each call a fresh extractor — which resets
 * the replay cursor, so a sequence of recorded answers restarted on every
 * invoice instead of advancing.
 */
export function configFromEnvironment(): WorkerConfig {
  cachedConfig ??= buildConfig();
  return cachedConfig;
}

/** Test helper: drop the memoised config so the next call re-reads the env. */
export function resetConfig(): void {
  cachedConfig = null;
}

function buildConfig(): WorkerConfig {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  // Without a key the worker still runs, on recorded or replayed answers. That
  // keeps the whole application, including the end to end suite, runnable
  // offline and behind a proxy that blocks generativelanguage.googleapis.com.
  const recordedPath = process.env.RECORDED_RUNS;
  const extractor: FieldExtractor = key
    ? new GeminiFieldExtractor({ apiKey: key, model })
    : recordedPath
      ? new RecordedFieldExtractor(
          JSON.parse(readFileSync(recordedPath, "utf8")) as RecordedDocument[],
        )
      : new ReplayFieldExtractor([emptyRun()]);

  return {
    extractor,
    textLayerReader: new PdfTextLayerReader({
      dpi: Number(process.env.OCR_DPI ?? 300),
      language: process.env.OCR_LANGUAGE ?? "eng",
    }),
    runs: Number(process.env.EXTRACTION_RUNS ?? 3),
    // Defaults to true. ADR 0002: the gate stays shut until the error rate has
    // been measured. Set COLD_START=false only once that measurement exists.
    coldStart: process.env.COLD_START !== "false",
    auditSampleRate: Number(process.env.AUDIT_SAMPLE_RATE ?? 0.05),
    model: key ? model : recordedPath ? "recorded" : "replay",
  };
}

export async function processOne(config: WorkerConfig): Promise<string | null> {
  const claimed = await claimNextQueued();
  if (!claimed) return null;

  try {
    const pdf = new Uint8Array(await readFile(storagePath(claimed.storage_key)));
    const recorder = new RecordingExtractor(config.extractor);

    const result = await processInvoice(
      pdf,
      { textLayerReader: config.textLayerReader, extractor: recorder, runs: config.runs },
      { coldStart: config.coldStart },
    );

    // Audit sampling only applies to invoices that would otherwise sail
    // through. Sampling something already going to review measures nothing.
    const sampled =
      result.decision.route === Route.AutoApprove &&
      shouldAuditSample(config.auditSampleRate);

    const decision = sampled
      ? {
          route: Route.Review,
          reasons: [
            "audit sample: measuring the false-negative rate of the gate",
            ...result.decision.reasons,
          ],
        }
      : result.decision;

    await saveResult({
      id: claimed.id,
      extraction: result.extraction,
      findings: result.findings,
      decision,
      textLayer: result.textLayer,
      hadTextLayer: result.textLayer.trim().length >= 40,
      model: config.model,
      promptHash: promptHash(config.model, config.runs),
      rawRuns: recorder.runs,
    });

    if (sampled) await markAuditSample(claimed.id);
    return claimed.id;
  } catch (error) {
    await markFailed(claimed.id, error instanceof Error ? error.message : String(error));
    return claimed.id;
  }
}

/** Drain the queue. Returns how many invoices were processed. */
export async function drainQueue(config: WorkerConfig, limit = 100): Promise<number> {
  let processed = 0;
  while (processed < limit) {
    const id = await processOne(config);
    if (!id) break;
    processed += 1;
  }
  return processed;
}

/**
 * Identifies the configuration that produced a value. Corrections are only
 * evidence about the model and prompt that generated them, so thresholds have
 * to be refit whenever this changes.
 */
function promptHash(model: string, runs: number): string {
  return createHash("sha256").update(`${model}|runs=${runs}|v1`).digest("hex").slice(0, 16);
}

function emptyRun(): ExtractionRun {
  return {};
}
