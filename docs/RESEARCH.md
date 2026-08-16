# Research findings

Three research passes fed the design. Kept in full because two of them produced
decisions that look arbitrary without the evidence, and one produced a dead end
that would otherwise be rediscovered.

Every claim below has a primary source. Retrieved August 2026.

---

## 1. LLM confidence cannot be thresholded

This is why `docs/adr/0001` exists and why nothing in this system reads a
self-reported confidence score.

### Verbalized confidence is quantized, not continuous

Measured across six models on a 0 to 100 scale:

- The single most frequent value accounts for **35.6 to 68.4 percent** of all
  responses.
- The top three values cover **78.2 to 92.1 percent**.
- Models use only **15 to 28 distinct integers** out of 101 possible.
- **Gemini 3.1 Pro reports exactly 100 on 68.4 percent of instances.** GPT-5.2
  and Qwen3-235B most frequently output 95.
- The preference persists under irregular ranges such as 0 to 73 or 14 to 86,
  which indicates the model is emitting familiar numeric tokens rather than
  reasoning about the scale.
- Coarser scales (0 to 20) outperformed 0 to 100 on metacognitive sensitivity.

Source: [Rescaling Confidence, arXiv:2603.09309](https://arxiv.org/html/2603.09309)

**Consequence.** "Auto-approve above 90" does not partition a continuous score.
It partitions three or four discrete buckets whose boundaries were set by
tokenizer frequency, not by the error distribution.

### Calibration is poor even at best

- Tian et al., *Just Ask for Calibration* (EMNLP 2023) found verbalized
  confidence beats conditional token probabilities, "often reducing the expected
  calibration error by a relative 50%". That is *relative* improvement over a
  badly calibrated baseline on short-form QA, not a claim of absolute
  calibration. [arXiv:2305.14975](https://arxiv.org/abs/2305.14975)
- *On Verbalized Confidence Scores for LLMs*: ECE around 0.1 for 70B+ models
  even with good prompting; confidence stays high while accuracy declines across
  harder datasets. Calibration "heavily depends on how we ask for it".
  [arXiv:2412.14737](https://arxiv.org/html/2412.14737v2)
- Kadavath et al., *Language Models (Mostly) Know What They Know*, is often
  miscited in support. Its actual claim is narrow: large models are calibrated
  on multiple-choice and true/false questions in the right format. Free-form
  field extraction is not that format.
  [arXiv:2207.05221](https://arxiv.org/abs/2207.05221)

### Gemini logprobs are not a fallback

`responseLogprobs` and `logprobs` exist in the SDK types, and Vertex AI
documented values 1 to 20. But Google staff confirmed in August 2026 that
logprobs "are no longer returned for 3.X models", affecting Gemini 3.1 Pro and
3.6 Flash on both Vertex AI and AI Studio. The newer Interactions API has no
logprobs support at all, described as deliberate. Support has been toggled
without announcement before: `gemini-2.5-flash` began returning
`400 INVALID_ARGUMENT` in October 2025.

Sources: [Google issue thread 176557](https://discuss.ai.google.dev/t/missing-logprobs-support-in-the-newest-gemini-models-3-1-pro-3-6-flash-on-vertex-ai-and-ai-studio/176557),
[thread 144837](https://discuss.ai.google.dev/t/missing-logprobs-support-in-next-gen-interactions-api-generationconfig-2/144837),
[thread 107989](https://discuss.ai.google.dev/t/logprobs-is-not-enabled-for-gemini-models/107989)

Even with logprobs, a length-normalized `avgLogprobs` over a JSON response is
not a per-field confidence.

### What does work

- **Self-consistency / multi-sample agreement** has the strongest evidence.
  Farquhar et al. in *Nature* (2024) report semantic entropy at AUROC 0.790
  versus 0.698 for asking the model whether its own answer is true, and 0.691
  for naive token entropy, averaged over 30 task-model combinations. Field
  extraction is easier than open QA here: values are short and string
  comparable, so normalized exact-match agreement across N runs suffices.
  [Nature](https://www.nature.com/articles/s41586-024-07421-0)
- **Cross-model disagreement** addresses self-consistency's failure mode, a
  model producing the same wrong answer repeatedly. Requires only generated
  text, no logit access. [arXiv:2604.17112](https://arxiv.org/html/2604.17112)
- **Grounding** against the source text is cheap, deterministic, and catches
  fabrications outright. Azure Content Understanding returns page number,
  bounding polygon and character span for every field including generative ones.
- **Deterministic business-rule validation** is the highest-precision signal
  available, because it is a verification rather than an estimate. Note honestly:
  no peer-reviewed work was found establishing it as a confidence signal for
  invoice extraction. Sound engineering, thin literature.

### On choosing a threshold

Google Document AI's evaluation page states the tradeoff explicitly and provides
a slider over the confidence threshold with metrics recomputed at each point,
automatically selecting the F1-maximizing value.
[Evaluate performance](https://docs.cloud.google.com/document-ai/docs/evaluate)

Two caveats before copying that:

1. **F1 is the wrong objective for review routing.** It weights precision and
   recall equally. The real objective is a cost function: a missed error
   reaching the ledger versus a reviewer-minute.
2. **Threshold per field, not per document.** Microsoft's own guidance for
   exactly this pipeline shape is "set acceptance thresholds field by field and
   recalibrate them whenever you switch models".
   [Foundry blog](https://devblogs.microsoft.com/foundry/azure-content-understanding-gpt-5-series-guide-model-selection-grounding-improvements-and-confidence-enhancements/)

Microsoft's "80 percent generally, close to 100 percent for financial records"
is not derived from a PR curve and is not backed by published data. Treat it as
a prior, not guidance.
[Azure accuracy and confidence](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/accuracy-confidence?view=doc-intel-4.0.0)

---

## 2. Invoice field standards and deterministic checks

### Legal validity, India

CGST Rule 46 lists the mandatory particulars of a tax invoice. The ones this
system uses:

| Clause | Particular |
| --- | --- |
| (a) | name, address and **GSTIN of the supplier** |
| (b) | **a consecutive serial number not exceeding sixteen characters**, alphanumerics plus hyphen and slash, **unique for a financial year** |
| (c) | date of issue |
| (d) | name, address and GSTIN or UIN of the recipient, **if registered** |
| (g) | **HSN** code for goods or services |
| (j) | total value of supply |
| (k) | taxable value, net of discount |
| (l) | rate of tax per head |
| (m) | amount of tax per head (CGST/SGST/IGST/UTGST/cess) |
| (n) | **place of supply with State name**, for inter-State supply |
| (q) | signature or digital signature |
| (r) | QR code with embedded IRN, where Rule 48(4) applies |

Source: [CBIC Rule 46](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)

India is unusual in imposing a **machine-checkable invoice number format**. The
EU's Article 226(2) says only "sequential… uniquely identifies", so do not regex
an EU invoice number.
[VAT Directive 2006/112/EC](https://www.legislation.gov.uk/eudr/2006/112/title/XI/chapter/3)

### GSTIN structure

15 characters: two-digit state code, ten-character PAN
(`[A-Z]{5}[0-9]{4}[A-Z]`), an entity number, `Z`, and a **mod-36 check
character**. The PAN occupies characters 3 to 12, so a GSTIN and a PAN validate
each other. State codes 01 to 38 are allocated, plus 97 for Other Territory and
99 for Centre Jurisdiction.

This check digit is the single strongest deterministic signal available on a
document with no signed QR. A one-character OCR slip is caught with certainty
rather than estimated. Implemented in `packages/core/src/gstin.ts`.

### Arithmetic

The full chain from EN 16931, which is worth knowing even though the EU standard
does not apply here, because naive validators produce false positives by
collapsing it:

    sum of line net amounts (BT-106)
      − document allowances (BT-107) + document charges (BT-108)
      = total without VAT (BT-109)
    total without VAT + total VAT (BT-110) = total with VAT (BT-112)
    total with VAT − paid (BT-113) + rounding (BT-114) = amount due (BT-115)

At v1 header-only granularity this reduces to
`taxable + CGST + SGST + IGST + cess = total`, which is what `validation.ts`
implements. Tolerance is one paisa, because amounts are rounded per head.

Note that `line amount = qty × unit price` is a **Peppol** rule (R120), not an
EN 16931 rule, and holds only after dividing by price base quantity and applying
line-level allowances and charges. Enforcing the naive form rejects valid
invoices. Relevant when line items land in v2.

Source: [EN 16931 Schematron](https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/master/ubl/schematron/abstract/EN16931-model.sch),
[Peppol BIS Billing 3.0](https://docs.peppol.eu/poacc/billing/3.0/bis/)

### Tax head

Supplier state code equal to place of supply means intra-State, taxed as CGST
plus SGST in equal halves. Otherwise inter-State, taxed as IGST. The head is
derived, never read off a label on the page, because the label is exactly what a
mis-issued invoice gets wrong.

### Commercial extractors, for reference

AWS Textract `AnalyzeExpense`, Google Document AI Invoice Parser and Azure
Document Intelligence `prebuilt-invoice` all return per-field confidence and
**no mandatory fields**. None publishes a calibration curve. Azure is the only
one making an explicit probabilistic claim, without a reliability diagram behind
it. None reconstructs a multi-rate tax breakdown from raw output.

---

## 3. The e-invoice QR dead end

Recorded so it is not rediscovered. Decision in `docs/adr/0005`.

### What exists

Indian B2B invoices from suppliers whose **aggregate turnover exceeds ₹5 crore
in any financial year from 2017-18 onwards** must carry an IRN and a signed QR
code. Threshold set by Notification 10/2023-CT effective 1 August 2023, and
unchanged as of August 2026.
[Notification 10/2023-CT](https://www.gstcouncil.gov.in/sites/default/files/2024-05/10ct_eng.pdf)

The QR carries a JWS in compact serialization, `alg: RS256`, signed by the
Invoice Registration Portal. Payload, exactly ten fields:

    SellerGstin, BuyerGstin, DocNo, DocTyp, DocDt,
    TotInvVal, ItemCnt, MainHsnCode, Irn, IrnDt

Header-level only. No names, no addresses, no tax breakup, no line items.

Legally load-bearing: Rule 48(5) says an in-scope invoice issued any other way
"shall not be treated as an invoice", so the buyer loses input tax credit. That
gives very high compliance among genuine ₹5 crore-plus suppliers.

### Why it does not apply here

The supplier base is below the threshold. Coverage is effectively zero.

Also exempt regardless of turnover: SEZ units, insurers, banks, financial
institutions, NBFCs, goods transport agencies, passenger transport, multiplex
cinema, government departments and local authorities.
[Manual on e-Invoice Exemption](https://einvoice.gst.gov.in/uiassets/js/assets/files/Manual_on_e-invocie_exemption.pdf)

### What building it would have cost

Worth recording, in case the supplier mix changes:

- **Key management, not crypto, is the real cost.** Six IRPs, each publishing
  its own signing certificate independently, no unified JWKS endpoint, keys that
  rotate and expire, and no `x5c` in the JWS header, so certificates must be
  obtained out of band and historic epochs retained.
- **PDF rendering is the weak link.** The government mandates the QR's contents,
  not its rendering. There is no standard e-invoice PDF; the IRP returns signed
  JSON and each supplier's ERP renders it. The payload is roughly 870 characters,
  forcing an 85 to 93 module code, which at the recommended two-inch print size
  is about two pixels per module at screen resolution. Design for decode failure
  as a normal path.
- Offline signature verification cannot detect a **cancelled** IRN. Cancellation
  is allowed within 24 hours and a cancelled invoice's QR still verifies.

### The B2C dynamic QR is not a substitute

Different instrument. Supplier-generated, unsigned, payment-oriented, ₹500 crore
threshold, and its "invoice value" may legitimately be an unpaid balance rather
than the total. Trivially forgeable. Do not build verification on it.
[Circular 146/02/2021-GST](https://cbic-gst.gov.in/pdf/Circular_Refund_146.pdf)
