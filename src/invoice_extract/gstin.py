"""GSTIN parsing and check-digit verification.

This is the single strongest deterministic signal available on a non-e-invoice
Indian tax invoice. A GSTIN embeds a mod-36 check character, so a one-character
OCR slip is caught with certainty rather than estimated. It also embeds the
supplier's PAN and state code, which means the vendor identity and the tax-head
rule both come from a verifiable string rather than from a fuzzy name match.

Reference: CGST Rule 46(a) requires the supplier's GSTIN on every tax invoice.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# 2-digit state code, 10-character PAN, entity number, Z, check character.
GSTIN_PATTERN = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][0-9A-Z][0-9A-Z]$")

# State codes 01-38 are allocated to states and union territories; 97 is
# "Other Territory" and 99 is Centre Jurisdiction.
VALID_STATE_CODES = frozenset(f"{n:02d}" for n in range(1, 39)) | {"97", "99"}


class GstinError(ValueError):
    """Raised when a string that must be a GSTIN is not one."""


@dataclass(frozen=True)
class Gstin:
    raw: str

    @property
    def state_code(self) -> str:
        return self.raw[:2]

    @property
    def pan(self) -> str:
        return self.raw[2:12]

    def __str__(self) -> str:
        return self.raw


def check_character(first_fourteen: str) -> str:
    """The mod-36 check character for the first fourteen characters of a GSTIN.

    Each character's ordinal is multiplied by an alternating 1, 2 factor; the
    quotient and remainder of that product against 36 are both accumulated.
    """
    total = 0
    for index, char in enumerate(first_fourteen):
        factor = 1 if index % 2 == 0 else 2
        product = CHARSET.index(char) * factor
        total += product // 36 + product % 36
    return CHARSET[(36 - total % 36) % 36]


def is_valid_gstin(candidate: str | None) -> bool:
    """True only if `candidate` is structurally sound and its check digit holds."""
    if candidate is None:
        return False
    value = candidate.strip()
    if len(value) != 15:
        return False
    if not GSTIN_PATTERN.match(value):
        return False
    if value[:2] not in VALID_STATE_CODES:
        return False
    return check_character(value[:14]) == value[14]


def parse_gstin(candidate: str) -> Gstin:
    """Parse a GSTIN, raising rather than returning a half-trusted value."""
    value = (candidate or "").strip()
    if not is_valid_gstin(value):
        raise GstinError(f"not a valid GSTIN: {candidate!r}")
    return Gstin(raw=value)
