/**
 * Decide which invoices a human looks at.
 *
 * Every input is something that can be checked, never the model's opinion of
 * itself. Verbalized LLM confidence is excluded by design: measured across
 * models it collapses onto a handful of round numbers, so thresholding it is
 * not thresholding anything. See ADR 0001.
 */

import { type InvoiceExtraction, isPresent, namedFields, samplesAgree } from "./model";
import { type Finding, Severity } from "./validation";

export enum Route {
  AutoApprove = "auto_approve",
  Review = "review",
  Reject = "reject",
}

export interface Decision {
  readonly route: Route;
  readonly reasons: readonly string[];
}

export interface DecideOptions {
  /**
   * Defaults to true on purpose. Until the per-field error rate has been
   * measured against reviewed invoices there is no evidence on which to set an
   * auto-approve gate, so everything goes to a human. See ADR 0002.
   */
  readonly coldStart?: boolean;
  /**
   * Set by the caller for a random slice of otherwise auto-approvable invoices,
   * so the gate's false-negative rate keeps being measured in production rather
   * than assumed.
   */
  readonly sampleForAudit?: boolean;
}

export function decide(
  extraction: InvoiceExtraction,
  findings: readonly Finding[],
  options: DecideOptions = {},
): Decision {
  const { coldStart = true, sampleForAudit = false } = options;

  const fatal = findings.filter((f) => f.severity === Severity.Fatal);
  if (fatal.length > 0) {
    return {
      route: Route.Reject,
      reasons: fatal.map((f) => `${f.field}: ${f.message}`),
    };
  }

  const reasons: string[] = [];

  if (coldStart) {
    reasons.push("cold start: error rate not yet measured, reviewing everything");
  }
  if (sampleForAudit) {
    reasons.push("audit sample: measuring the false-negative rate of the gate");
  }

  for (const f of findings) {
    if (f.severity !== Severity.Warning) reasons.push(`${f.field}: ${f.message}`);
  }

  for (const [name, f] of namedFields(extraction)) {
    // `false` is a failed grounding check; `"not-attempted"` is a check that
    // never ran. Neither is evidence the value came off the page, so both force
    // review. Unknown is not the same as passing.
    if (isPresent(f) && f.grounded !== true) {
      reasons.push(`${name}: not confirmed present in the OCR text layer`);
    }
    if (!samplesAgree(f)) {
      reasons.push(`${name}: independent extraction runs disagreed`);
    }
  }

  if (reasons.length > 0) {
    return { route: Route.Review, reasons };
  }

  const warnings = findings
    .filter((f) => f.severity === Severity.Warning)
    .map((f) => `${f.field}: ${f.message}`);

  return {
    route: Route.AutoApprove,
    reasons:
      warnings.length > 0
        ? warnings
        : ["all deterministic checks passed and every field is grounded"],
  };
}
