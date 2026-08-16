/**
 * The extraction record that flows through the pipeline.
 *
 * A `Field` is deliberately not a bare string. Every extracted value carries the
 * two signals the design relies on instead of self-reported model confidence:
 * whether the value was located in the OCR text layer (`grounded`), and what the
 * independent extraction runs returned (`samples`).
 */

export type Grounded = true | false | "not-attempted";

export interface Field {
  readonly value: string | null;
  /**
   * `true` if the value was located verbatim in the text layer.
   * `"not-attempted"` means the check never ran, which routing treats as
   * unknown rather than as passing.
   */
  readonly grounded: Grounded;
  /** What each independent extraction run returned for this field. */
  readonly samples: readonly string[];
}

export const FIELD_NAMES = [
  "supplierGstin",
  "recipientGstin",
  "invoiceNumber",
  "invoiceDate",
  "placeOfSupplyStateCode",
  "taxableValue",
  "cgstAmount",
  "sgstAmount",
  "igstAmount",
  "cessAmount",
  "totalValue",
  "hsn",
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

export type InvoiceExtraction = Readonly<Record<FieldName, Field>>;

export function field(
  value: string | null,
  options: { grounded?: Grounded; samples?: readonly string[] } = {},
): Field {
  return {
    value,
    grounded: options.grounded ?? "not-attempted",
    samples: options.samples ?? (value === null ? [] : [value]),
  };
}

export function isPresent(f: Field): boolean {
  return f.value !== null && f.value.trim() !== "";
}

/**
 * False when independent runs disagreed. Zero or one sample means there was
 * nothing to disagree about, which is not evidence of agreement but is not
 * evidence of conflict either.
 */
export function samplesAgree(f: Field): boolean {
  return new Set(f.samples).size <= 1;
}

export function namedFields(
  extraction: InvoiceExtraction,
): ReadonlyArray<readonly [FieldName, Field]> {
  return FIELD_NAMES.map((name) => [name, extraction[name]] as const);
}
