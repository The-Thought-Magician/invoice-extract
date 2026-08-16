"""Routing is the seam the whole design turns on: which invoices a human sees.

Behaviour under test: given validation findings, grounding results and
multi-sample agreement, is this invoice auto-approved, sent for review, or
rejected as not-an-invoice? Self-reported model confidence is deliberately
not an input.
"""

from invoice_extract.model import Field, InvoiceExtraction
from invoice_extract.routing import Route, decide
from invoice_extract.validation import validate


def f(value: str | None, *, grounded: bool = True, samples: tuple[str, ...] = ()) -> Field:
    return Field(value=value, grounded=grounded, samples=samples or ((value,) if value else ()))


def clean(**overrides: Field) -> InvoiceExtraction:
    base = dict(
        supplier_gstin=f("27AAPFU0939F1ZV"),
        recipient_gstin=f("27AAGCB7383J1Z8"),
        invoice_number=f("INV/2026/0042"),
        invoice_date=f("2026-07-15"),
        place_of_supply_state_code=f("27"),
        taxable_value=f("1000.00"),
        cgst_amount=f("90.00"),
        sgst_amount=f("90.00"),
        igst_amount=f("0.00"),
        cess_amount=f("0.00"),
        total_value=f("1180.00"),
        hsn=f("998314"),
    )
    base.update(overrides)
    return InvoiceExtraction(**base)


def route(extraction: InvoiceExtraction, **kwargs: bool) -> Route:
    return decide(extraction, validate(extraction), **kwargs).route


def test_clean_invoice_is_auto_approved_once_the_gate_is_open() -> None:
    assert route(clean(), cold_start=False) is Route.AUTO_APPROVE


def test_cold_start_sends_everything_to_review() -> None:
    # Until the error rate has been measured there is no basis for a gate.
    assert route(clean(), cold_start=True) is Route.REVIEW


def test_cold_start_is_the_default() -> None:
    assert decide(clean(), validate(clean())).route is Route.REVIEW


def test_fatal_finding_rejects() -> None:
    # Not an invoice under Rule 46, so there is nothing to review.
    assert route(clean(invoice_number=f(None)), cold_start=False) is Route.REJECT


def test_error_finding_sends_to_review() -> None:
    assert route(clean(hsn=f("99831")), cold_start=False) is Route.REVIEW


def test_ungrounded_field_sends_to_review_even_when_arithmetic_passes() -> None:
    # A value the model produced that does not appear in the OCR text layer
    # is a fabrication candidate, no matter how well it adds up.
    ungrounded = clean(supplier_gstin=f("27AAPFU0939F1ZV", grounded=False))
    assert route(ungrounded, cold_start=False) is Route.REVIEW


def test_sample_disagreement_sends_to_review() -> None:
    wobbly = clean(total_value=Field(value="1180.00", grounded=True,
                                     samples=("1180.00", "1180.00", "1130.00")))
    assert route(wobbly, cold_start=False) is Route.REVIEW


def test_unanimous_samples_do_not_send_to_review() -> None:
    steady = clean(total_value=Field(value="1180.00", grounded=True,
                                     samples=("1180.00", "1180.00", "1180.00")))
    assert route(steady, cold_start=False) is Route.AUTO_APPROVE


def test_decision_explains_itself() -> None:
    decision = decide(clean(hsn=f("99831")), validate(clean(hsn=f("99831"))), cold_start=False)
    assert decision.reasons
    assert any("hsn" in reason for reason in decision.reasons)


def test_auto_approved_decision_still_carries_a_reason() -> None:
    decision = decide(clean(), validate(clean()), cold_start=False)
    assert decision.reasons


def test_sampling_rate_forces_review_of_otherwise_clean_invoices() -> None:
    # Continuous measurement of the false-negative rate: a slice of
    # auto-approved invoices must keep reaching a human.
    decision = decide(clean(), validate(clean()), cold_start=False, sample_for_audit=True)
    assert decision.route is Route.REVIEW
    assert any("audit" in reason for reason in decision.reasons)


def test_field_with_grounding_not_attempted_sends_to_review() -> None:
    # `grounded=None` means the check never ran. Treating unknown as passing
    # would let an entire un-grounded batch auto-approve once the gate opens.
    unknown = clean(total_value=Field(value="1180.00", grounded=None, samples=("1180.00",)))
    assert route(unknown, cold_start=False) is Route.REVIEW


def test_absent_optional_field_does_not_force_review_for_grounding() -> None:
    # There is nothing to ground when there is no value.
    assert route(clean(recipient_gstin=Field(value=None)), cold_start=False) is Route.AUTO_APPROVE
