# Decision log

The design came out of a structured interview rather than a document. This is
the record: every question put, what was answered, and what changed as a result.
It exists so nobody has to guess later why the system is shaped this way.

The original idea, verbatim:

> An invoice PDF reading tool. You give the invoice or invoices to the tool, it
> does OCR on it and matches against some fixed values. The output of this is
> then fed to an LLM query consisting of Gemini with the invoice PDF (different
> flows for each invoice uploaded) and asked if the data extracted is correct or
> if there is some modification needed and adding to it. Finally it gets stored
> in a tabular format in a DB and is shown once a person clicks on the invoice.
> If there is any doubt regarding the data it is presented to a human for review.

Three things in that description did not survive: the confidence threshold, the
OCR-then-ask-the-model-to-check architecture, and the assumption that "display
the data" meant correctness was cheap.

---

## Round 1

**Q1. What decision does the output serve?**
Answered: reducing manual load. Someone currently finds these numbers by hand
and types them into a downstream process.
→ Correctness is not free. A wrong number costs whatever the downstream process
does with it.

**Q2. What are the "fixed values"?**
Answered: total amount, vendor name, and the rest of what is normally on an
invoice. Research requested.
→ Produced the field set in `docs/spec.md`, grounded in CGST Rule 46 rather than
invented.

**Q3. Why is OCR in the pipeline if Gemini reads PDFs natively?**
Answered: OCR checks the document meets the criteria of an invoice; Gemini is
not trustworthy on its own. Option (a) chosen: OCR as a cheap deterministic
pre-filter.
→ Partly kept, partly corrected. OCR does not validate anything; it returns
text. The validation is deterministic rules on top. OCR's real job became
grounding.

**Q4. Volume and latency.**
Answered: 5 to 10 a day now, 500 to 1000 later. Uploader comes back later.
→ Asynchronous from the start: upload writes a row and returns, a worker drains
the queue.

**Q5. What does a wrong number cost, and what is the gate?**
Answered: use Gemini's probability, auto-approve above 90 percent.
→ **Discarded.** See Round 2.

**Q6. What does "different flows for each invoice" mean?**
Answered: (a), each invoice is an independent call. Not a design decision.

**Q7. Who reviews, and at what throughput?**
Answered: the uploader reviews.
→ Flagged as a control that weakens at volume; revisited in Q15.

**Q8. Where is invoice data allowed to go?**
Answered: no restriction.

---

## Round 2

Research came back and killed Q5's answer.

**Verbalized LLM confidence is not a probability.** Measured across models, the
single most frequent value accounts for 35.6 to 68.4 percent of all responses;
the top three cover 78 to 92 percent; models use only 15 to 28 distinct integers
out of 101. Gemini 3.1 Pro reports exactly 100 on 68.4 percent of instances. A
"> 90" gate is not a threshold, it is a partition of three or four buckets whose
boundaries were chosen by tokenizer frequency.

Logprobs would have been the honest alternative. Google disabled them for the
3.X generation on both Vertex AI and AI Studio, and the Interactions API never
had them.

**Q9. Q1 and Q5 contradict each other.**
Answered: the data is used in a process; the tool removes manual entry.
→ Correctness matters. Confirmed.

**Q10. What replaces the 90 percent gate?**
Answered: all three of arithmetic, grounding, and multi-run agreement.
→ `docs/adr/0001`. This is the load-bearing decision in the whole system.

**Q11. Which jurisdiction?**
Answered: Indian GST.
→ Unlocked a large deterministic rule set: GSTIN mod-36 check digit, Rule 46(b)
invoice number format, CGST equals SGST on intra-state, tax head from place of
supply, HSN shape.

**Q12. What does the gate actually check?**
Answered: take the recommendation.
→ Rule 46 presence checks, then the arithmetic chain. Note the chain is not
`subtotal + tax = total`; document-level allowances, charges, paid and rounding
amounts sit in between, and naive validators produce false positives by skipping
them.

**Q13. Header only, or line items?**
Answered: header only for v1, line items in v2. → `docs/adr/0003`.

**Q14. Where does labelled ground truth come from?**
Answered: there is none.
→ Round 3 thought it had found free ground truth. It had not.

**Q15. The uploader reviewing their own extraction is not a control.**
Answered in Round 3: at 1000 a day, about 50 should reach review.
→ Recorded as a capacity budget, not a measured error rate.

---

## Round 3, and the dead end worth recording

Research found that Indian B2B invoices from suppliers above ₹5 crore aggregate
turnover must carry an RS256-signed QR code issued by a government-authorised
IRP. Its payload contains supplier GSTIN, recipient GSTIN, invoice number,
invoice date, total value, item count, main HSN and the IRN. It is verifiable
fully offline and is legally load-bearing: an in-scope invoice without an IRN is
not an invoice, and the buyer loses input tax credit.

That would have supplied free, cryptographically signed ground truth for five of
the twelve v1 fields, at zero labelling cost.

**Q17. What fraction of your invoices carry a QR?**
Answered: minimal, technically none. The supplier base is below the threshold.

→ The entire QR path died. Recorded in `docs/adr/0005` rather than silently
dropped, because the answer changes if the supplier mix changes or if the
threshold is lowered by notification. The research is preserved in
`docs/RESEARCH.md`.

**Q18. The 3 to 5 percent error rate has no evidence behind it.**
Answered: assume it, stop questioning.
→ Accepted. The `coldStart` switch stays in the code so the assumption can be
replaced by a measurement without a rewrite, and audit sampling runs either way.

**Q19. Vendor name.**
→ `docs/adr/0004`. GSTIN is the key because it carries a check digit; a name
does not.

**Q21. Cancelled IRNs.** Answered: not a concern. Moot once the QR path died.

---

## Round 4

**Scan ratio: 1:1.** Half the corpus has no text layer.

This is the answer with the largest downstream consequence. Grounding works by
checking the extracted value appears in the text layer; on a scan that layer
comes from OCR. So on half the volume, grounding is only as good as Tesseract.

The asymmetry is what makes it acceptable: an OCR misread makes a *correct*
value look ungrounded and sends it to a human. It costs reviewer time. It can
never promote a wrong value, because grounding only ever withholds trust.

**Stack:** TypeScript backend, Next.js frontend, Postgres. UI reference
beautifului.dev, which is copy-paste components aimed at human-in-the-loop
approval flows.

**OCR:** Gemini extracts from the document image; Tesseract exists only to
produce a text layer for grounding. → `docs/adr/0006`.

---

## What building it then found

Four defects that no amount of design review would have surfaced. Each is now
covered by a test and listed in `CLAUDE.md`.

1. A foreign key from `invoice.supplier_gstin` to `vendor` made every
   first-time supplier fail.
2. `invoice_number varchar(16)`, faithfully encoding Rule 46(b), turned a
   flaggable invoice into a failed one and hid the violation.
3. Grounding compared ISO dates against pages printing DD/MM/YYYY, marking
   every invoice ungrounded and firing the signal on all of them.
4. The list page assumed a `date` column arrives as a string. Both drivers
   return a `Date`.

And one measurement worth keeping: OCR accuracy is not monotonic in resolution.
Tesseract reads the same GSTIN correctly at 300 dpi and wrong at 200, and reads
an invoice number correctly at 200 and wrong at 300. Both are pinned by tests so
nobody tunes the dpi by intuition.

---

## Still open

- Evidence for the error rate. Taken as 3 to 5 percent by direction; the code
  treats the gate as unopened until the `correction` table says otherwise.
- What happens to stored rows when the model or prompt changes. `prompt_hash` is
  recorded against every correction so the question is answerable, but nothing
  acts on it.
- Line items (v2).
- Authentication, object storage, a scheduled worker process.
