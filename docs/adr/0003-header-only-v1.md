# 0003 — Header fields only in v1

## Status
Accepted

## Context
Line items require table detection, multi-page table continuation, per-line tax
rates and units of measure. They are most of the engineering effort and most of
the errors.

## Decision
v1 extracts header fields only. Line items are v2.

## Consequences
The strongest arithmetic check, sum of line net amounts equals the subtotal, is
unavailable in v1. The remaining arithmetic still binds: taxable value plus tax
heads equals total, CGST equals SGST on intra-state supplies, and the implied
rate must be a GST slab. Item count cannot be validated at all.

The schema is designed so adding a line-items table in v2 does not require
rewriting the header rows.
