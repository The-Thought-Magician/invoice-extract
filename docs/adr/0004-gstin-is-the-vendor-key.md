# 0004: GSTIN is the vendor key; the name is display only

## Status
Accepted

## Context
Vendor names on invoice faces are inconsistent: trading names, legal names,
abbreviations, and OCR noise. Matching on them produces a long tail of
duplicate-vendor bugs.

A GSTIN embeds a mod-36 check character, so a single mis-read character is
detectable with certainty rather than estimated. It also embeds the PAN at
characters 3 to 12 and the state code at 1 to 2.

## Decision
The vendor identity is the supplier GSTIN. The display name is resolved from an
internal vendor table keyed on GSTIN. An extracted name is never an identity.

## Consequences
A failed GSTIN check digit is a zero-false-positive error detector and the
single strongest deterministic signal available on a non-e-invoice document.
Invoices from suppliers not yet in the vendor table need a name captured once,
at review time.
