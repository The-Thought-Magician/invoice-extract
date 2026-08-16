# 0002: Review everything until the error rate is measured

## Status
Accepted

## Context
The target is 5 percent of invoices going to review, 50 of 1000 a day. The
estimated error rate is 3 to 5 percent, but there is no labelled ground truth
behind that estimate, and the supplier base carries no e-invoice QR to supply
labels for free. An estimate that happens to equal the review budget is a number
chosen to make the plan work.

If the true error rate is materially higher, a 5 percent gate silently passes
the excess into the downstream process, and the tool is worse than manual entry
because nobody is checking.

## Decision
`cold_start` defaults to True. Every invoice routes to REVIEW regardless of how
clean it looks. The gate is only opened once a per-field error rate has been
measured against reviewed invoices. Volume starts at 5 to 10 a day, so full
review is affordable for weeks.

Every human correction is persisted as a labelled example from day one.

A random audit sample of auto-approved invoices continues to reach a human after
the gate opens, so the false-negative rate is measured rather than assumed.

## Consequences
Slower payoff. In exchange, the gate is set from evidence, and there is a
standing measurement of what it lets through.
