"""GSTIN is a public seam: other subsystems key vendors on it.

Behaviour under test: given a candidate string, can we say with certainty
whether it is a well-formed GSTIN, and can we derive the facts it embeds
(state code, PAN) without asking anyone?
"""

import pytest

from invoice_extract.gstin import GstinError, parse_gstin, is_valid_gstin

# Real-world GSTINs whose check digit is self-consistent. These are the
# independent source of truth: the expected values are not recomputed the
# way the code computes them, they are read off the string itself.
VALID = [
    "27AAPFU0939F1ZV",
    "29AAGCB7383J1Z4",
    "24AAACC1206D1ZM",
]


@pytest.mark.parametrize("gstin", VALID)
def test_accepts_wellformed_gstin(gstin: str) -> None:
    assert is_valid_gstin(gstin)


@pytest.mark.parametrize("gstin", VALID)
def test_exposes_state_code_and_pan(gstin: str) -> None:
    parsed = parse_gstin(gstin)
    assert parsed.state_code == gstin[:2]
    assert parsed.pan == gstin[2:12]


def test_rejects_single_digit_transposition() -> None:
    # The whole point of the check digit: a one-character OCR slip is caught.
    assert not is_valid_gstin("27AAPFU0939F1ZW")


def test_rejects_wrong_length() -> None:
    assert not is_valid_gstin("27AAPFU0939F1Z")
    assert not is_valid_gstin("27AAPFU0939F1ZVV")


def test_rejects_lowercase() -> None:
    # GSTINs are uppercase. Accepting lowercase would let a normalisation bug
    # through silently.
    assert not is_valid_gstin("27aapfu0939f1zv")


def test_rejects_unknown_state_code() -> None:
    # 00 and 99 are not allocated state codes.
    assert not is_valid_gstin("00AAPFU0939F1ZV")


def test_rejects_malformed_pan_block() -> None:
    # PAN is 5 letters, 4 digits, 1 letter. Digits in the letter block is a
    # structural failure regardless of the check digit.
    assert not is_valid_gstin("27AAPF10939F1ZV")


def test_parse_raises_on_invalid() -> None:
    with pytest.raises(GstinError):
        parse_gstin("not-a-gstin")


def test_normalises_surrounding_whitespace() -> None:
    assert is_valid_gstin("  27AAPFU0939F1ZV  ")
