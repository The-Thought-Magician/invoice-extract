/**
 * Gemini as the field extractor.
 *
 * Two things about this adapter are deliberate.
 *
 * It never asks the model how confident it is. A verbalized confidence score is
 * not a probability and cannot be thresholded (ADR 0001); the pipeline gets its
 * confidence from independent runs disagreeing, from grounding, and from
 * arithmetic. Adding a confidence field to the schema would invite someone to
 * use it.
 *
 * It sends the PDF itself rather than OCR text. Gemini reads document images
 * directly and does that better than it reads mangled OCR output. Tesseract's
 * job is grounding, not extraction.
 */

import type { ExtractionRun, FieldExtractor } from "@invoice-extract/core";
import { FIELD_NAMES } from "@invoice-extract/core";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

const PROMPT = `You are reading a single Indian GST tax invoice.

Return the header fields exactly as they are printed on the document.

Rules:
- Copy values verbatim from the page. Do not compute, infer, correct or complete anything.
- If a field is not printed on the document, return null for it. Never guess.
- Amounts: digits and at most two decimal places, no currency symbol, no thousands separators. Write 1180.00, not "Rs. 1,180.00".
- invoiceDate: ISO 8601, YYYY-MM-DD. Indian invoices normally print DD/MM/YYYY, so 15/07/2026 is 2026-07-15.
- placeOfSupplyStateCode: the two digit state code only, for example 27 for Maharashtra. If the place of supply is printed as a state name with no code, return the code for that state.
- GSTINs: 15 characters, uppercase, no spaces.
- hsn: the HSN or SAC code of the highest value line item.
- If the document is not a tax invoice at all, return null for every field.`;

/** JSON schema Gemini is constrained to. Every field is nullable on purpose. */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    FIELD_NAMES.map((name) => [name, { type: "string", nullable: true }]),
  ),
  required: [...FIELD_NAMES],
  propertyOrdering: [...FIELD_NAMES],
} as const;

export interface GeminiOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly endpoint?: string;
  /**
   * Non-zero so that independent runs are genuinely independent. At
   * temperature 0 three runs are three copies of the same answer and the
   * agreement signal measures nothing.
   */
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  /** Per-attempt ceiling. A stalled connection must not hang the worker. */
  readonly timeoutMs?: number;
}

export class GeminiExtractionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class GeminiFieldExtractor implements FieldExtractor {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly temperature: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(options: GeminiOptions) {
    if (!options.apiKey) throw new GeminiExtractionError("Gemini API key is required");
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.temperature = options.temperature ?? 0.4;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async extract(pdf: Uint8Array): Promise<ExtractionRun> {
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: "application/pdf", data: toBase64(pdf) } },
          ],
        },
      ],
      generationConfig: {
        temperature: this.temperature,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    const url = `${this.endpoint}/models/${this.model}:generateContent`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Header rather than a query parameter, so the key never lands in
            // a proxy access log or an error message containing the URL.
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify(body),
          // A connection that stalls after the handshake never rejects on its
          // own, which would hang the drain and strand the invoice mid-claim.
          // An abort surfaces as a retryable error like any other.
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 429 || response.status >= 500) {
          throw new GeminiExtractionError(
            `Gemini responded ${response.status}`,
            response.status,
          );
        }
        if (!response.ok) {
          // 4xx other than rate limiting will not improve on retry.
          throw Object.assign(
            new GeminiExtractionError(`Gemini responded ${response.status}`, response.status),
            { permanent: true },
          );
        }

        return parseResponse(await response.json());
      } catch (error) {
        lastError = error;
        if ((error as { permanent?: boolean }).permanent) break;
        if (attempt < this.maxRetries) {
          await delay(2 ** attempt * 500);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new GeminiExtractionError("Gemini request failed");
  }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export function parseResponse(payload: unknown): ExtractionRun {
  const text = (payload as GeminiResponse).candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new GeminiExtractionError("Gemini returned no text part");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiExtractionError("Gemini returned text that is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new GeminiExtractionError("Gemini returned JSON that is not an object");
  }

  const record = parsed as Record<string, unknown>;
  const run: Record<string, string | null> = {};
  for (const name of FIELD_NAMES) {
    const value = record[name];
    // Anything that is not a non-empty string is absence. The model returning
    // a number, or the literal string "null", both mean the field is missing.
    run[name] =
      typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "null"
        ? value.trim()
        : null;
  }
  return run as ExtractionRun;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Replays recorded answers instead of calling the API.
 *
 * Used by the end to end suite, and by anyone working offline or behind a proxy
 * that blocks generativelanguage.googleapis.com.
 */
export class ReplayFieldExtractor implements FieldExtractor {
  private index = 0;
  constructor(private readonly runs: readonly ExtractionRun[]) {
    if (runs.length === 0) throw new Error("ReplayFieldExtractor needs at least one run");
  }
  async extract(): Promise<ExtractionRun> {
    const run = this.runs[this.index % this.runs.length] as ExtractionRun;
    this.index += 1;
    return run;
  }
}
