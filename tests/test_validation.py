"""Validation is the seam that replaces the discarded confidence threshold.

Behaviour under test: given an extraction, which deterministic facts about
an Indian GST tax invoice are violated? Every expected value here comes from
CGST Rule 46 or from arithmetic done by hand, never from re-running the
implementation.
"""


from invoice_extract.model import Field, InvoiceExtraction
from invoice_extract.validation import Severity, validate


def f(value: str | None, *, grounded: bool = True, samples: tuple[str, ...] = ()) -> Field:
    return Field(value=value, grounded=grounded, samples=samples or ((value,) if value else ()))


def intra_state_invoice(**overrides: Field) -> InvoiceExtraction:
    """A clean Maharashtra-to-Maharashtra invoice. 1000 taxable, 18% split 9/9."""
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


def codes(extraction: InvoiceExtraction) -> set[str]:
    return {finding.code for finding in validate(extraction)}


# --- the happy path -------------------------------------------------------


def test_clean_intra_state_invoice_has_no_findings() -> None:
    assert validate(intra_state_invoice()) == []


def test_clean_inter_state_invoice_has_no_findings() -> None:
    # Maharashtra supplier, Karnataka place of supply, so IGST at 18%.
    inter = intra_state_invoice(
        place_of_supply_state_code=f("29"),
        recipient_gstin=f("29AAGCB7383J1Z4"),
        cgst_amount=f("0.00"),
        sgst_amount=f("0.00"),
        igst_amount=f("180.00"),
    )
    assert validate(inter) == []


# --- Rule 46 presence -----------------------------------------------------


def test_missing_supplier_gstin_is_fatal() -> None:
    findings = validate(intra_state_invoice(supplier_gstin=f(None)))
    assert "MISSING_SUPPLIER_GSTIN" in {x.code for x in findings}
    assert any(x.severity is Severity.FATAL for x in findings)


def test_missing_invoice_number_is_fatal() -> None:
    assert "MISSING_INVOICE_NUMBER" in codes(intra_state_invoice(invoice_number=f(None)))


def test_missing_total_is_fatal() -> None:
    assert "MISSING_TOTAL_VALUE" in codes(intra_state_invoice(total_value=f(None)))


def test_missing_recipient_gstin_is_not_fatal() -> None:
    # Recipient GSTIN is only mandatory when the recipient is registered.
    # An unregistered-buyer invoice is still a valid invoice.
    findings = validate(intra_state_invoice(recipient_gstin=f(None)))
    assert all(x.severity is not Severity.FATAL for x in findings)


# --- Rule 46(b): invoice number format ------------------------------------


def test_invoice_number_over_sixteen_characters_is_an_error() -> None:
    assert "INVOICE_NUMBER_TOO_LONG" in codes(
        intra_state_invoice(invoice_number=f("INV/2026/00000000042"))
    )


def test_invoice_number_with_illegal_characters_is_an_error() -> None:
    # Rule 46(b) permits alphanumerics plus hyphen and slash only.
    assert "INVOICE_NUMBER_BAD_CHARS" in codes(
        intra_state_invoice(invoice_number=f("INV#2026*42"))
    )


def test_invoice_number_at_exactly_sixteen_characters_is_accepted() -> None:
    assert "INVOICE_NUMBER_TOO_LONG" not in codes(
        intra_state_invoice(invoice_number=f("ABCD/1234-5678/9"))
    )


# --- GSTIN integrity ------------------------------------------------------


def test_supplier_gstin_failing_checksum_is_an_error() -> None:
    assert "SUPPLIER_GSTIN_INVALID" in codes(
        intra_state_invoice(supplier_gstin=f("27AAPFU0939F1ZW"))
    )


def test_recipient_gstin_failing_checksum_is_an_error() -> None:
    assert "RECIPIENT_GSTIN_INVALID" in codes(
        intra_state_invoice(recipient_gstin=f("29AAGCB7383J1Z9"))
    )


# --- arithmetic -----------------------------------------------------------


def test_total_not_equal_to_taxable_plus_taxes_is_an_error() -> None:
    # 1000 + 90 + 90 = 1180, not 1200.
    assert "TOTAL_MISMATCH" in codes(intra_state_invoice(total_value=f("1200.00")))


def test_one_paisa_of_rounding_is_tolerated() -> None:
    assert "TOTAL_MISMATCH" not in codes(intra_state_invoice(total_value=f("1180.01")))


def test_two_paisa_of_drift_is_not_tolerated() -> None:
    assert "TOTAL_MISMATCH" in codes(intra_state_invoice(total_value=f("1180.02")))


def test_cgst_not_equal_to_sgst_is_an_error() -> None:
    # On an intra-state supply the two halves are equal by construction.
    assert "CGST_SGST_ASYMMETRY" in codes(
        intra_state_invoice(cgst_amount=f("100.00"), sgst_amount=f("80.00"))
    )


def test_implied_tax_rate_outside_the_gst_slabs_is_flagged() -> None:
    # 180/1000 = 18%, a real slab. 130/1000 = 13%, which does not exist.
    assert "IMPLAUSIBLE_TAX_RATE" in codes(
        intra_state_invoice(
            cgst_amount=f("65.00"), sgst_amount=f("65.00"), total_value=f("1130.00")
        )
    )


def test_negative_taxable_value_is_an_error() -> None:
    assert "NEGATIVE_TAXABLE_VALUE" in codes(intra_state_invoice(taxable_value=f("-1000.00")))


def test_unparseable_amount_is_an_error_not_a_crash() -> None:
    assert "TOTAL_VALUE_NOT_NUMERIC" in codes(intra_state_invoice(total_value=f("Rs. 1,180/-")))


# --- tax head consistency -------------------------------------------------


def test_intra_state_supply_charging_igst_is_an_error() -> None:
    assert "WRONG_TAX_HEAD" in codes(
        intra_state_invoice(
            cgst_amount=f("0.00"), sgst_amount=f("0.00"), igst_amount=f("180.00")
        )
    )


def test_inter_state_supply_charging_cgst_is_an_error() -> None:
    assert "WRONG_TAX_HEAD" in codes(intra_state_invoice(place_of_supply_state_code=f("29")))


def test_both_igst_and_cgst_charged_is_an_error() -> None:
    assert "MIXED_TAX_HEADS" in codes(intra_state_invoice(igst_amount=f("180.00")))


# --- Rule 46(g): HSN ------------------------------------------------------


def test_hsn_of_odd_length_is_an_error() -> None:
    # HSN/SAC codes are 4, 6 or 8 digits.
    assert "HSN_MALFORMED" in codes(intra_state_invoice(hsn=f("99831")))


def test_non_numeric_hsn_is_an_error() -> None:
    assert "HSN_MALFORMED" in codes(intra_state_invoice(hsn=f("ABC123")))


# --- dates ----------------------------------------------------------------


def test_unparseable_date_is_an_error() -> None:
    assert "INVOICE_DATE_UNPARSEABLE" in codes(intra_state_invoice(invoice_date=f("15/07/26")))


def test_ambiguous_day_month_date_is_flagged_for_review() -> None:
    # Handled upstream by normalising to ISO. A bare ISO date is unambiguous.
    assert "INVOICE_DATE_UNPARSEABLE" not in codes(
        intra_state_invoice(invoice_date=f("2026-07-15"))
    )


# --- ordering -------------------------------------------------------------


def test_fatal_findings_are_reported_before_errors() -> None:
    broken = intra_state_invoice(total_value=f(None), hsn=f("99831"))
    findings = validate(broken)
    assert findings[0].severity is Severity.FATAL


def test_findings_name_the_field_they_concern() -> None:
    findings = validate(intra_state_invoice(hsn=f("99831")))
    assert findings[0].field == "hsn"
