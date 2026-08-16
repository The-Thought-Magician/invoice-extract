# 0005: No e-invoice QR verification path

## Status
Accepted

## Context
Indian B2B invoices from suppliers above 5 crore rupees aggregate turnover must
carry an RS256-signed QR code issued by an Invoice Registration Portal. Its
payload contains supplier GSTIN, recipient GSTIN, document number, document
date, total value, item count, main HSN and the IRN. It is verifiable offline
and would supply free, government-signed ground truth for most of the v1 field
set.

This supplier base is below the threshold. QR coverage is effectively zero.

## Decision
Do not build QR decoding, JWS verification, or IRP certificate management.

## Consequences
There is no free ground truth. Labels must be bootstrapped from human review,
which is why ADR 0002 exists. Revisit if the supplier mix changes or if the
5 crore threshold is lowered by notification.

## References
- Notification 10/2023-CT: https://www.gstcouncil.gov.in/sites/default/files/2024-05/10ct_eng.pdf
- Manual on e-Invoice Exemption: https://einvoice.gst.gov.in/uiassets/js/assets/files/Manual_on_e-invocie_exemption.pdf
