# 0001 — Deterministic validation replaces self-reported model confidence

## Status
Accepted

## Context
The original design auto-approved an extraction when Gemini reported a
confidence above 90 percent. Measurement across models shows verbalized
confidence is not a probability: models emit only 15 to 28 distinct integers out
of 101, the top three values absorb 78 to 92 percent of all responses, and
Gemini 3.1 Pro reports exactly 100 on 68.4 percent of instances. Round-number
preference persists even on irregular scales, so the number reflects token
familiarity, not calibration. Token logprobs would be an honest alternative but
Google has disabled them for the 3.X generation on both Vertex AI and AI Studio,
and the Interactions API never exposed them.

## Decision
No decision in this system reads a model's self-reported confidence. Routing is
driven by signals that can be checked:

1. Deterministic rules from CGST Rule 46 and arithmetic identities.
2. Grounding: the value must appear verbatim in the OCR text layer.
3. Agreement across independent extraction runs.

## Consequences
Extraction costs roughly three times more, which at this volume is immaterial.
Every routing decision is explainable by naming the rule that fired. The system
cannot express "probably right", only "these specific checks passed".

## References
- https://arxiv.org/html/2603.09309
- https://arxiv.org/abs/2305.14975
- https://www.nature.com/articles/s41586-024-07421-0
- https://discuss.ai.google.dev/t/missing-logprobs-support-in-the-newest-gemini-models-3-1-pro-3-6-flash-on-vertex-ai-and-ai-studio/176557
