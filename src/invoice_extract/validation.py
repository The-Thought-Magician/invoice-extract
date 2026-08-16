"""Deterministic validation of an extracted Indian GST tax invoice.

Nothing here estimates. Every check either holds or does not, which is why
these findings, and not a model's self-reported confidence score, are the
primary input to review routing.

Rule references are to the CGST Rules, 2017.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from enum import IntEnum

from .gstin import is_valid_gstin
from .model import Field, InvoiceExtraction

# Rounding slack. Amounts are rounded to two decimals per line and per head,
# so a one-paisa drift is a rounding artefact, not an extraction error.
TOLERANCE = Decimal("0.01")

# Rule 46(b): not more than sixteen characters, alphanumerics plus hyphen and
# slash only, unique for a financial year.
INVOICE_NUMBER_MAX_LENGTH = 16
INVOICE_NUMBER_PATTERN = re.compile(r"^[A-Za-z0-9/-]+$")

# Rule 46(g): HSN for goods, SAC for services. Four, six or eight digits.
HSN_LENGTHS = frozenset({4, 6, 8})

# Combined ad valorem rates seen across the pre- and post-reform slab
# structures. This is a plausibility heuristic, not a legal rule: an
# unrecognised rate means look again, not reject.
PLAUSIBLE_TAX_RATES = frozenset(
    Decimal(x)
    for x in ("0", "0.1", "0.25", "1", "1.5", "3", "5", "6", "7.5", "12", "18", "28", "40")
)


class Severity(IntEnum):
    """Lower sorts first. FATAL means the document is not an invoice at all."""

    FATAL = 0
    ERROR = 1
    WARNING = 2


@dataclass(frozen=True)
class Finding:
    code: str
    severity: Severity
    field: str
    message: str


def _amount(field: Field) -> Decimal | None:
    """Parse an amount, or None if it is absent or not a number.

    Deliberately strict. A value like "Rs. 1,180/-" is an upstream
    normalisation failure and must surface as a finding, not be silently
    coerced into 1180.
    """
    if not field.is_present:
        return None
    try:
        return Decimal(str(field.value).strip())
    except (InvalidOperation, ValueError):
        return None


def _zero_if_absent(field: Field) -> Decimal | None:
    return Decimal("0") if not field.is_present else _amount(field)


def validate(extraction: InvoiceExtraction) -> list[Finding]:
    """Every deterministic rule this extraction violates, most severe first."""
    findings: list[Finding] = []
    findings.extend(_check_mandatory_particulars(extraction))
    findings.extend(_check_invoice_number(extraction.invoice_number))
    findings.extend(_check_gstins(extraction))
    findings.extend(_check_hsn(extraction.hsn))
    findings.extend(_check_invoice_date(extraction.invoice_date))
    findings.extend(_check_arithmetic(extraction))
    findings.extend(_check_tax_heads(extraction))
    return sorted(findings, key=lambda finding: finding.severity)


def _check_mandatory_particulars(extraction: InvoiceExtraction) -> list[Finding]:
    """Rule 46: without these the document is not a tax invoice.

    The recipient's GSTIN is not on this list because Rule 46(d) requires it
    only where the recipient is registered.
    """
    required = {
        "supplier_gstin": "MISSING_SUPPLIER_GSTIN",
        "invoice_number": "MISSING_INVOICE_NUMBER",
        "invoice_date": "MISSING_INVOICE_DATE",
        "taxable_value": "MISSING_TAXABLE_VALUE",
        "total_value": "MISSING_TOTAL_VALUE",
    }
    return [
        Finding(code, Severity.FATAL, name, f"Rule 46 requires {name.replace('_', ' ')}")
        for name, code in required.items()
        if not getattr(extraction, name).is_present
    ]


def _check_invoice_number(field: Field) -> list[Finding]:
    if not field.is_present:
        return []
    value = str(field.value).strip()
    findings = []
    if len(value) > INVOICE_NUMBER_MAX_LENGTH:
        findings.append(
            Finding(
                "INVOICE_NUMBER_TOO_LONG",
                Severity.ERROR,
                "invoice_number",
                f"Rule 46(b) caps the invoice number at {INVOICE_NUMBER_MAX_LENGTH} "
                f"characters; got {len(value)}",
            )
        )
    if not INVOICE_NUMBER_PATTERN.match(value):
        findings.append(
            Finding(
                "INVOICE_NUMBER_BAD_CHARS",
                Severity.ERROR,
                "invoice_number",
                "Rule 46(b) permits alphanumerics, hyphen and slash only",
            )
        )
    return findings


def _check_gstins(extraction: InvoiceExtraction) -> list[Finding]:
    findings = []
    for name, code in (
        ("supplier_gstin", "SUPPLIER_GSTIN_INVALID"),
        ("recipient_gstin", "RECIPIENT_GSTIN_INVALID"),
    ):
        field = getattr(extraction, name)
        if field.is_present and not is_valid_gstin(str(field.value)):
            findings.append(
                Finding(
                    code,
                    Severity.ERROR,
                    name,
                    "GSTIN failed structural or check-digit verification",
                )
            )
    return findings


def _check_hsn(field: Field) -> list[Finding]:
    if not field.is_present:
        return []
    value = str(field.value).strip()
    if value.isdigit() and len(value) in HSN_LENGTHS:
        return []
    return [
        Finding(
            "HSN_MALFORMED",
            Severity.ERROR,
            "hsn",
            "Rule 46(g) HSN/SAC must be 4, 6 or 8 digits",
        )
    ]


def _check_invoice_date(field: Field) -> list[Finding]:
    """Dates must arrive already normalised to ISO 8601.

    Day-month ambiguity is resolved upstream where the document's own format
    is visible; by the time a date reaches validation, an unparseable value
    means normalisation failed and the value cannot be trusted.
    """
    if not field.is_present:
        return []
    try:
        date.fromisoformat(str(field.value).strip())
    except ValueError:
        return [
            Finding(
                "INVOICE_DATE_UNPARSEABLE",
                Severity.ERROR,
                "invoice_date",
                "invoice date is not a normalised ISO 8601 date",
            )
        ]
    return []


def _check_arithmetic(extraction: InvoiceExtraction) -> list[Finding]:
    findings: list[Finding] = []

    for name, code in (
        ("taxable_value", "TAXABLE_VALUE_NOT_NUMERIC"),
        ("total_value", "TOTAL_VALUE_NOT_NUMERIC"),
        ("cgst_amount", "CGST_AMOUNT_NOT_NUMERIC"),
        ("sgst_amount", "SGST_AMOUNT_NOT_NUMERIC"),
        ("igst_amount", "IGST_AMOUNT_NOT_NUMERIC"),
        ("cess_amount", "CESS_AMOUNT_NOT_NUMERIC"),
    ):
        field = getattr(extraction, name)
        if field.is_present and _amount(field) is None:
            findings.append(
                Finding(code, Severity.ERROR, name, "amount is not a parseable decimal")
            )

    taxable = _amount(extraction.taxable_value)
    total = _amount(extraction.total_value)
    cgst = _zero_if_absent(extraction.cgst_amount)
    sgst = _zero_if_absent(extraction.sgst_amount)
    igst = _zero_if_absent(extraction.igst_amount)
    cess = _zero_if_absent(extraction.cess_amount)

    if taxable is not None and taxable < 0:
        findings.append(
            Finding(
                "NEGATIVE_TAXABLE_VALUE",
                Severity.ERROR,
                "taxable_value",
                "taxable value is negative; a credit note is a separate document type",
            )
        )

    if None in (taxable, total, cgst, sgst, igst, cess):
        return findings

    assert taxable is not None and total is not None
    assert cgst is not None and sgst is not None and igst is not None and cess is not None

    expected_total = taxable + cgst + sgst + igst + cess
    if abs(expected_total - total) > TOLERANCE:
        findings.append(
            Finding(
                "TOTAL_MISMATCH",
                Severity.ERROR,
                "total_value",
                f"taxable plus taxes is {expected_total}, invoice total is {total}",
            )
        )

    if cgst > 0 and sgst > 0 and abs(cgst - sgst) > TOLERANCE:
        findings.append(
            Finding(
                "CGST_SGST_ASYMMETRY",
                Severity.ERROR,
                "cgst_amount",
                f"central and state tax must be equal halves; got {cgst} and {sgst}",
            )
        )

    if taxable > 0:
        rate = ((cgst + sgst + igst) / taxable * 100).quantize(Decimal("0.01"))
        if rate.normalize() not in {r.normalize() for r in PLAUSIBLE_TAX_RATES}:
            findings.append(
                Finding(
                    "IMPLAUSIBLE_TAX_RATE",
                    Severity.WARNING,
                    "taxable_value",
                    f"implied combined tax rate of {rate}% is not a GST slab",
                )
            )

    return findings


def _check_tax_heads(extraction: InvoiceExtraction) -> list[Finding]:
    """Place of supply decides the tax head. Rule 46(l), (m) and (n).

    Supplier state equal to place of supply means an intra-state supply, taxed
    as CGST plus SGST. Otherwise it is inter-state and taxed as IGST.
    """
    supplier = extraction.supplier_gstin
    pos = extraction.place_of_supply_state_code
    if not supplier.is_present or not is_valid_gstin(str(supplier.value)):
        return []
    if not pos.is_present:
        return []

    cgst = _zero_if_absent(extraction.cgst_amount) or Decimal("0")
    sgst = _zero_if_absent(extraction.sgst_amount) or Decimal("0")
    igst = _zero_if_absent(extraction.igst_amount) or Decimal("0")

    findings = []
    if igst > 0 and (cgst > 0 or sgst > 0):
        findings.append(
            Finding(
                "MIXED_TAX_HEADS",
                Severity.ERROR,
                "igst_amount",
                "a supply is either intra-state or inter-state, never both",
            )
        )

    is_intra_state = str(supplier.value).strip()[:2] == str(pos.value).strip().zfill(2)
    if is_intra_state and igst > 0:
        findings.append(
            Finding(
                "WRONG_TAX_HEAD",
                Severity.ERROR,
                "igst_amount",
                "intra-state supply charged IGST",
            )
        )
    if not is_intra_state and (cgst > 0 or sgst > 0):
        findings.append(
            Finding(
                "WRONG_TAX_HEAD",
                Severity.ERROR,
                "cgst_amount",
                "inter-state supply charged CGST or SGST",
            )
        )
    return findings
