# Plays extraction eval set (P2 — plays-plan §4)

Hand-labeled cases for `pnpm -C packages/worker plays-eval` — the model-choice instrument.
**Target ≥ 30 cases** (a dozen gives ±20-point confidence intervals), stratified across:

- screenshot kinds: single position / portfolio / order ticket
- brokers (Robinhood, Fidelity, Schwab, IBKR, Webull, …) and light/dark mode
- shapes: single-leg, spreads (multi-leg!), shares, realized ("closed") views, non-USD

## Layout — one directory per case

```
fixtures/plays/<case-name>/
  post.json        # { "title": …, "selftext": …, "flair": … } — from the plays row
  expected.json    # hand-labeled LlmExtraction (the answer key) — MUST parse against
                   # LlmExtractionSchema (schema conventions: positive quantity, side carries
                   # the sign, per-share option prices, absolute dollars, YYYY-MM-DD expiry)
  images/          # the screenshots, gallery order by filename (0.jpg, 1.jpg, …)
```

## Sourcing + redaction

Source cases from the LIVE capture archive (`data/media/plays/<post_id>/` + the `plays` row's
title/selftext/flair). Before committing: **redact usernames AND account identifiers** (account
numbers, masked or not) from the images — crop or blur. Position/price data stays: it is the thing
being evaluated, and the posts are public.

Label `expected.json` by reading the screenshot yourself — not by running the extractor and
correcting it (that anchors the answer key to one model's errors).

## Scoring

`plays-eval` machine-scores exact match per field (numbers within 0.5 % for broker rounding; a
correct `null` scores as correct), reporting PER-FIELD accuracy — the marking-critical fields
(ticker/side/quantity/strike/expiry) get their own lines and near-perfect expectations; the P2 gate
threshold (≥ 80 %) applies per field, not to one blended number.
