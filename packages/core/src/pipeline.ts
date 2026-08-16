/**
 * Orchestration for one invoice.
 *
 * The two things that talk to the outside world, reading a text layer and
 * asking a model for fields, are interfaces. Everything else here is pure, so
 * the whole pipeline is testable without a PDF, an OCR binary or an API key.
 */

import {
  FIELD_NAMES,
  type FieldName,
  type Grounded,
  type InvoiceExtraction,
  field,
} from "./model";
import { type Decision, type DecideOptions, decide } from "./routing";
import { type Finding, validate } from "./validation";

/** One model run's answer: a raw string per field, or null if not found. */
export type ExtractionRun = Readonly<Partial<Record<FieldName, string | null>>>;

export interface TextLayerReader {
  /**
   * The document's text. For a digital PDF this is the embedded text layer; for
   * a scan it is OCR output. Half of this corpus is scans, so this returning
   * poor text is a normal condition, not an exception.
   */
  read(pdf: Uint8Array): Promise<string>;
}

export interface FieldExtractor {
  /** One independent extraction run over the document. */
  extract(pdf: Uint8Array): Promise<ExtractionRun>;
}

export interface PipelineResult {
  readonly extraction: InvoiceExtraction;
  readonly findings: readonly Finding[];
  readonly decision: Decision;
  readonly textLayer: string;
}

/**
 * Normalise a string for grounding comparison.
 *
 * Grounding asks whether the extracted value is on the page, not whether it is
 * formatted the same way. An invoice printing "Rs. 1,180.00" grounds the value
 * "1180.00"; a model inventing "1190.00" does not.
 */
export function normaliseForGrounding(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s, ]/g, "")
    .replace(/[₹$]|rs\.?|inr/g, "")
    .replace(/[^a-z0-9./-]/g, "");
}

/** Whether `value` occurs in `textLayer`, ignoring formatting differences. */
export function isGrounded(value: string, textLayer: string): boolean {
  const needle = normaliseForGrounding(value);
  if (needle === "") return false;
  return normaliseForGrounding(textLayer).includes(needle);
}

const SHORT_MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/**
 * Every way an ISO date might legitimately appear on an Indian invoice.
 *
 * The extractor is told to return ISO 8601, but almost no Indian invoice prints
 * it that way. Grounding has to ask whether the date is on the page in any
 * plausible printed form, not whether the canonical string is.
 */
function printedDateForms(iso: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return [];
  const [, year, month, day] = match as unknown as [string, string, string, string];

  const shortYear = year.slice(2);
  const bareDay = String(Number(day));
  const bareMonth = String(Number(month));
  const monthName = SHORT_MONTHS[Number(month) - 1] as string;

  const forms: string[] = [iso];
  for (const separator of ["/", "-", "."]) {
    for (const d of [day, bareDay]) {
      for (const m of [month, bareMonth]) {
        for (const y of [year, shortYear]) {
          forms.push(`${d}${separator}${m}${separator}${y}`);
        }
      }
    }
  }
  for (const d of [day, bareDay]) {
    forms.push(`${d}${monthName}${year}`, `${monthName}${d}${year}`);
  }
  return forms;
}

/**
 * Grounding that knows what the extractor was asked to normalise.
 *
 * Only the date needs this today. Everything else is copied verbatim off the
 * page, so a literal comparison is the right one and a mismatch is real.
 */
export function isFieldGrounded(
  name: FieldName,
  value: string,
  textLayer: string,
): boolean {
  if (name !== "invoiceDate") return isGrounded(value, textLayer);
  const forms = printedDateForms(value);
  if (forms.length === 0) return false;
  return forms.some((form) => isGrounded(form, textLayer));
}

/**
 * Collapse independent runs into one extraction.
 *
 * The reported value is the modal answer across runs. Disagreement is preserved
 * on the field rather than resolved silently, because disagreement is the whole
 * signal.
 */
export function mergeRuns(runs: readonly ExtractionRun[], textLayer: string): InvoiceExtraction {
  const merged = {} as Record<FieldName, ReturnType<typeof field>>;

  for (const name of FIELD_NAMES) {
    const samples = runs
      .map((run) => run[name])
      .filter((v): v is string => typeof v === "string" && v.trim() !== "");

    const value = modalValue(samples);
    const grounded: Grounded =
      value === null ? "not-attempted" : isFieldGrounded(name, value, textLayer);
    merged[name] = field(value, { grounded, samples });
  }

  return merged as InvoiceExtraction;
}

function modalValue(samples: readonly string[]): string | null {
  if (samples.length === 0) return null;
  const counts = new Map<string, number>();
  for (const sample of samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);

  let best = samples[0] as string;
  let bestCount = 0;
  for (const [candidate, count] of counts) {
    // Ties break towards the first run's answer, which `best` already holds.
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export interface PipelineDependencies {
  readonly textLayerReader: TextLayerReader;
  readonly extractor: FieldExtractor;
  /** How many independent extraction runs to take. Three by default. */
  readonly runs?: number;
}

export async function processInvoice(
  pdf: Uint8Array,
  deps: PipelineDependencies,
  options: DecideOptions = {},
): Promise<PipelineResult> {
  const runCount = deps.runs ?? 3;

  const [textLayer, runs] = await Promise.all([
    deps.textLayerReader.read(pdf),
    Promise.all(Array.from({ length: runCount }, () => deps.extractor.extract(pdf))),
  ]);

  const extraction = mergeRuns(runs, textLayer);
  const findings = validate(extraction);
  return { extraction, findings, decision: decide(extraction, findings, options), textLayer };
}

/**
 * The natural key for duplicate detection.
 *
 * Rule 46(b) guarantees an invoice number is unique per supplier within a
 * financial year, so this is a real key rather than a heuristic. The Indian
 * financial year runs April to March.
 */
export function duplicateKey(
  supplierGstin: string,
  invoiceNumber: string,
  isoInvoiceDate: string,
): string {
  const year = Number(isoInvoiceDate.slice(0, 4));
  const month = Number(isoInvoiceDate.slice(5, 7));
  const financialYearStart = month >= 4 ? year : year - 1;
  return `${supplierGstin.trim()}|${invoiceNumber.trim()}|FY${financialYearStart}-${financialYearStart + 1}`;
}
