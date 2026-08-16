"""The extraction record that flows through the pipeline.

A `Field` is deliberately not just a string. Every extracted value carries the
two signals the design relies on instead of self-reported model confidence:
whether the value was found in the OCR text layer (`grounded`), and what the
independent sampling runs produced (`samples`).
"""

from __future__ import annotations

from dataclasses import dataclass, fields as dataclass_fields
from typing import Iterator


@dataclass(frozen=True)
class Field:
    """One extracted value plus the evidence for trusting it."""

    value: str | None
    grounded: bool | None = None
    """True if `value` was located verbatim in the OCR text layer.

    None means grounding was not attempted, which routing treats as unknown
    rather than as passing.
    """

    samples: tuple[str, ...] = ()
    """What each independent extraction run returned for this field."""

    @property
    def is_present(self) -> bool:
        return self.value is not None and self.value.strip() != ""

    @property
    def samples_agree(self) -> bool:
        """False when independent runs disagreed.

        Zero or one sample means there was nothing to disagree about, which is
        not evidence of agreement but is not evidence of conflict either.
        """
        return len(set(self.samples)) <= 1


@dataclass(frozen=True)
class InvoiceExtraction:
    """Header-level fields of an Indian GST tax invoice. Line items are v2."""

    supplier_gstin: Field
    recipient_gstin: Field
    invoice_number: Field
    invoice_date: Field
    place_of_supply_state_code: Field
    taxable_value: Field
    cgst_amount: Field
    sgst_amount: Field
    igst_amount: Field
    cess_amount: Field
    total_value: Field
    hsn: Field

    def named_fields(self) -> Iterator[tuple[str, Field]]:
        for spec in dataclass_fields(self):
            yield spec.name, getattr(self, spec.name)
