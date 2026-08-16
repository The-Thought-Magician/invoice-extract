"""Decide which invoices a human looks at.

The inputs are all things that can be checked, never the model's opinion of
itself. Verbalized LLM confidence is excluded by design: measured across
models it collapses onto a handful of round numbers, so thresholding it is
not thresholding anything.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .model import InvoiceExtraction
from .validation import Finding, Severity


class Route(Enum):
    AUTO_APPROVE = "auto_approve"
    REVIEW = "review"
    REJECT = "reject"


@dataclass(frozen=True)
class Decision:
    route: Route
    reasons: tuple[str, ...]


def decide(
    extraction: InvoiceExtraction,
    findings: list[Finding],
    *,
    cold_start: bool = True,
    sample_for_audit: bool = False,
) -> Decision:
    """Route one extraction.

    `cold_start` defaults to True on purpose. Until the per-field error rate
    has been measured against reviewed invoices there is no evidence on which
    to set an auto-approve gate, so everything goes to a human.

    `sample_for_audit` is set by the caller for a random slice of otherwise
    auto-approvable invoices, so the false-negative rate of the gate keeps
    being measured in production rather than assumed.
    """
    fatal = [f for f in findings if f.severity is Severity.FATAL]
    if fatal:
        return Decision(
            Route.REJECT,
            tuple(f"{f.field}: {f.message}" for f in fatal),
        )

    reasons: list[str] = []

    if cold_start:
        reasons.append("cold start: error rate not yet measured, reviewing everything")

    if sample_for_audit:
        reasons.append("audit sample: measuring the false-negative rate of the gate")

    reasons.extend(
        f"{f.field}: {f.message}" for f in findings if f.severity is not Severity.WARNING
    )

    for name, field in extraction.named_fields():
        if field.is_present and field.grounded is not True:
            # `False` is a failed grounding check; `None` is a check that never
            # ran. Neither is evidence the value came off the page, so both
            # force review. Unknown is not the same as passing.
            reasons.append(f"{name}: not confirmed present in the OCR text layer")
        if not field.samples_agree:
            reasons.append(f"{name}: independent extraction runs disagreed")

    if reasons:
        return Decision(Route.REVIEW, tuple(reasons))

    warnings = [f"{f.field}: {f.message}" for f in findings if f.severity is Severity.WARNING]
    return Decision(
        Route.AUTO_APPROVE,
        tuple(warnings) or ("all deterministic checks passed and fields are grounded",),
    )
