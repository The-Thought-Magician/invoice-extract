/**
 * Deterministic validation of an extracted Indian GST tax invoice.
 *
 * Nothing here estimates. Every check either holds or does not, which is why
 * these findings, and not a model's self-reported confidence, are the primary
 * input to review routing.
 *
 * Rule references are to the CGST Rules, 2017.
 */

import { isValidGstin } from "./gstin";
import { absolute, impliedRateBasisPoints, parsePaise } from "./money";
import { type Field, type FieldName, type InvoiceExtraction, isPresent } from "./model";

/**
 * Rounding slack, in paise. Amounts are rounded to two decimals per line and
 * per tax head, so a one-paisa drift is a rounding artefact, not an error.
 */
const TOLERANCE_PAISE = 1n;

/** Rule 46(b): at most sixteen characters, alphanumerics plus hyphen and slash. */
const INVOICE_NUMBER_MAX_LENGTH = 16;
const INVOICE_NUMBER_PATTERN = /^[A-Za-z0-9/-]+$/;

/** Rule 46(g): HSN for goods, SAC for services. Four, six or eight digits. */
const HSN_LENGTHS: ReadonlySet<number> = new Set([4, 6, 8]);

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Combined ad valorem rates in basis points, across the pre- and post-reform
 * slab structures. A plausibility heuristic, not a legal rule: an unrecognised
 * rate means look again, not reject.
 */
const PLAUSIBLE_RATE_BASIS_POINTS: ReadonlySet<bigint> = new Set([
  0n, 10n, 25n, 100n, 150n, 300n, 500n, 600n, 750n, 1200n, 1800n, 2800n, 4000n,
]);

/** Lower sorts first. FATAL means the document is not an invoice at all. */
export enum Severity {
  Fatal = 0,
  Error = 1,
  Warning = 2,
}

export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly field: FieldName;
  readonly message: string;
}

const MANDATORY_PARTICULARS: ReadonlyArray<readonly [FieldName, string]> = [
  ["supplierGstin", "MISSING_SUPPLIER_GSTIN"],
  ["invoiceNumber", "MISSING_INVOICE_NUMBER"],
  ["invoiceDate", "MISSING_INVOICE_DATE"],
  ["taxableValue", "MISSING_TAXABLE_VALUE"],
  ["totalValue", "MISSING_TOTAL_VALUE"],
];

const AMOUNT_FIELDS: ReadonlyArray<readonly [FieldName, string]> = [
  ["taxableValue", "TAXABLE_VALUE_NOT_NUMERIC"],
  ["totalValue", "TOTAL_VALUE_NOT_NUMERIC"],
  ["cgstAmount", "CGST_AMOUNT_NOT_NUMERIC"],
  ["sgstAmount", "SGST_AMOUNT_NOT_NUMERIC"],
  ["igstAmount", "IGST_AMOUNT_NOT_NUMERIC"],
  ["cessAmount", "CESS_AMOUNT_NOT_NUMERIC"],
];

/** Every deterministic rule this extraction violates, most severe first. */
export function validate(extraction: InvoiceExtraction): Finding[] {
  const findings: Finding[] = [
    ...checkMandatoryParticulars(extraction),
    ...checkInvoiceNumber(extraction.invoiceNumber),
    ...checkGstins(extraction),
    ...checkHsn(extraction.hsn),
    ...checkInvoiceDate(extraction.invoiceDate),
    ...checkArithmetic(extraction),
    ...checkTaxHeads(extraction),
  ];
  return findings.sort((a, b) => a.severity - b.severity);
}

/**
 * Rule 46: without these the document is not a tax invoice. The recipient's
 * GSTIN is absent from this list because Rule 46(d) requires it only where the
 * recipient is registered.
 */
function checkMandatoryParticulars(extraction: InvoiceExtraction): Finding[] {
  return MANDATORY_PARTICULARS.filter(([name]) => !isPresent(extraction[name])).map(
    ([name, code]) => ({
      code,
      severity: Severity.Fatal,
      field: name,
      message: `Rule 46 requires ${name}`,
    }),
  );
}

function checkInvoiceNumber(f: Field): Finding[] {
  if (!isPresent(f)) return [];
  const value = (f.value as string).trim();
  const findings: Finding[] = [];
  if (value.length > INVOICE_NUMBER_MAX_LENGTH) {
    findings.push({
      code: "INVOICE_NUMBER_TOO_LONG",
      severity: Severity.Error,
      field: "invoiceNumber",
      message: `Rule 46(b) caps the invoice number at ${INVOICE_NUMBER_MAX_LENGTH} characters; got ${value.length}`,
    });
  }
  if (!INVOICE_NUMBER_PATTERN.test(value)) {
    findings.push({
      code: "INVOICE_NUMBER_BAD_CHARS",
      severity: Severity.Error,
      field: "invoiceNumber",
      message: "Rule 46(b) permits alphanumerics, hyphen and slash only",
    });
  }
  return findings;
}

function checkGstins(extraction: InvoiceExtraction): Finding[] {
  const pairs: ReadonlyArray<readonly [FieldName, string]> = [
    ["supplierGstin", "SUPPLIER_GSTIN_INVALID"],
    ["recipientGstin", "RECIPIENT_GSTIN_INVALID"],
  ];
  return pairs
    .filter(([name]) => isPresent(extraction[name]) && !isValidGstin(extraction[name].value))
    .map(([name, code]) => ({
      code,
      severity: Severity.Error,
      field: name,
      message: "GSTIN failed structural or check-digit verification",
    }));
}

function checkHsn(f: Field): Finding[] {
  if (!isPresent(f)) return [];
  const value = (f.value as string).trim();
  if (/^\d+$/.test(value) && HSN_LENGTHS.has(value.length)) return [];
  return [
    {
      code: "HSN_MALFORMED",
      severity: Severity.Error,
      field: "hsn",
      message: "Rule 46(g) HSN/SAC must be 4, 6 or 8 digits",
    },
  ];
}

/**
 * Dates must arrive already normalised to ISO 8601. Day-month ambiguity is
 * resolved upstream where the document's own format is visible; by the time a
 * date reaches validation an unparseable value means normalisation failed.
 */
function checkInvoiceDate(f: Field): Finding[] {
  if (!isPresent(f)) return [];
  const value = (f.value as string).trim();
  const malformed: Finding = {
    code: "INVOICE_DATE_UNPARSEABLE",
    severity: Severity.Error,
    field: "invoiceDate",
    message: "invoice date is not a normalised ISO 8601 date",
  };
  if (!ISO_DATE_PATTERN.test(value)) return [malformed];
  // Date.parse accepts 2026-02-31 and rolls it forward, so round-trip instead.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return [malformed];
  return parsed.toISOString().slice(0, 10) === value ? [] : [malformed];
}

function checkArithmetic(extraction: InvoiceExtraction): Finding[] {
  const findings: Finding[] = [];

  for (const [name, code] of AMOUNT_FIELDS) {
    const f = extraction[name];
    if (isPresent(f) && parsePaise(f.value) === null) {
      findings.push({
        code,
        severity: Severity.Error,
        field: name,
        message: "amount is not a parseable decimal",
      });
    }
  }

  const amount = (name: FieldName): bigint | null =>
    isPresent(extraction[name]) ? parsePaise(extraction[name].value) : null;
  const zeroIfAbsent = (name: FieldName): bigint | null =>
    isPresent(extraction[name]) ? parsePaise(extraction[name].value) : 0n;

  const taxable = amount("taxableValue");
  const total = amount("totalValue");
  const cgst = zeroIfAbsent("cgstAmount");
  const sgst = zeroIfAbsent("sgstAmount");
  const igst = zeroIfAbsent("igstAmount");
  const cess = zeroIfAbsent("cessAmount");

  if (taxable !== null && taxable < 0n) {
    findings.push({
      code: "NEGATIVE_TAXABLE_VALUE",
      severity: Severity.Error,
      field: "taxableValue",
      message: "taxable value is negative; a credit note is a separate document type",
    });
  }

  if (taxable === null || total === null || cgst === null || sgst === null || igst === null || cess === null) {
    return findings;
  }

  const expectedTotal = taxable + cgst + sgst + igst + cess;
  if (absolute(expectedTotal - total) > TOLERANCE_PAISE) {
    findings.push({
      code: "TOTAL_MISMATCH",
      severity: Severity.Error,
      field: "totalValue",
      message: "taxable plus taxes does not equal the invoice total",
    });
  }

  if (cgst > 0n && sgst > 0n && absolute(cgst - sgst) > TOLERANCE_PAISE) {
    findings.push({
      code: "CGST_SGST_ASYMMETRY",
      severity: Severity.Error,
      field: "cgstAmount",
      message: "central and state tax must be equal halves of an intra-state levy",
    });
  }

  const rate = impliedRateBasisPoints(cgst + sgst + igst, taxable);
  if (rate !== null && !PLAUSIBLE_RATE_BASIS_POINTS.has(rate)) {
    findings.push({
      code: "IMPLAUSIBLE_TAX_RATE",
      severity: Severity.Warning,
      field: "taxableValue",
      message: `implied combined tax rate of ${Number(rate) / 100}% is not a GST slab`,
    });
  }

  return findings;
}

/**
 * Place of supply decides the tax head. Rule 46(l), (m) and (n). Supplier state
 * equal to place of supply means an intra-state supply taxed as CGST plus SGST;
 * otherwise it is inter-state and taxed as IGST. The head is never read off a
 * label on the page.
 */
function checkTaxHeads(extraction: InvoiceExtraction): Finding[] {
  const supplier = extraction.supplierGstin;
  const pos = extraction.placeOfSupplyStateCode;
  if (!isPresent(supplier) || !isValidGstin(supplier.value)) return [];
  if (!isPresent(pos)) return [];

  const cgst = parsePaise(extraction.cgstAmount.value) ?? 0n;
  const sgst = parsePaise(extraction.sgstAmount.value) ?? 0n;
  const igst = parsePaise(extraction.igstAmount.value) ?? 0n;

  const findings: Finding[] = [];
  if (igst > 0n && (cgst > 0n || sgst > 0n)) {
    findings.push({
      code: "MIXED_TAX_HEADS",
      severity: Severity.Error,
      field: "igstAmount",
      message: "a supply is either intra-state or inter-state, never both",
    });
  }

  const supplierState = (supplier.value as string).trim().slice(0, 2);
  const placeOfSupply = (pos.value as string).trim().padStart(2, "0");
  const isIntraState = supplierState === placeOfSupply;

  if (isIntraState && igst > 0n) {
    findings.push({
      code: "WRONG_TAX_HEAD",
      severity: Severity.Error,
      field: "igstAmount",
      message: "intra-state supply charged IGST",
    });
  }
  if (!isIntraState && (cgst > 0n || sgst > 0n)) {
    findings.push({
      code: "WRONG_TAX_HEAD",
      severity: Severity.Error,
      field: "cgstAmount",
      message: "inter-state supply charged CGST or SGST",
    });
  }
  return findings;
}
