# Evaluating categorization and local decision models

`ynab_suggest_categories` answers each uncategorized outflow from exact-payee
history first, then from a personal prior learned from the plan's own history,
and asks a model only about what is left. This guide is for anyone who wants
to measure how well that works on their own plan, or to try a local decision
model in place of the hosted one. It is generic: it describes the method and
the kinds of results to expect, not results from any particular plan.

Nothing here changes the server. The server only talks to TypeSafe today; a
local model is something you evaluate first, using the same request shape.

## 1. Keep the data private

Your transactions are personal financial data.

- Export with read-only `GET` requests (`/plans/{plan_id}/transactions`,
  `/categories`, `/payees`, `/accounts`, and `/settings` for the currency's
  decimal digits). Never test against a live plan with write calls.
- Keep exports, labeled sets and results outside any git repository, with
  owner-only file permissions.
- Load the YNAB token, and any provider key, only inside the process that
  needs it. Never print, log or commit them.
- A hosted model sees the request body you send. Decide before a paid run what
  may leave the machine, and set a spending ceiling.

## 2. Build a labeled set from your own categorized transactions

Your already-categorized transactions are free labels. Use the same eligibility
rules the tool uses, or the set will measure the wrong population:

1. Keep non-deleted outflows (`amount < 0`) that have a category.
2. Drop transfers, both rows with `transfer_account_id` and rows whose payee is
   a transfer payee, and drop splits and YNAB's balance-adjustment payees
   ("Starting Balance", "Manual Balance Adjustment", "Reconciliation Balance
   Adjustment").
3. Drop rows whose category is no longer in today's eligible set (hidden,
   deleted, or internal/credit-card-payment categories). The model can only
   choose from today's set, so those labels are unreachable.
4. Sort by date and **hold out the most recent slice** (for example the last
   20%) as the test set. Keep a whole day on one side of the boundary. Never
   shuffle: a random split leaks later habits into earlier predictions.
5. For every row, rebuild what the tool would have known **on that row's date**:
   only rows dated strictly earlier, within 12 months. Compute the exact-payee
   and similar-name history summaries from that window, not from the whole
   export.

### Pick the population that matters

YNAB usually fills in a known payee's last category when a transaction is
imported. So the rows still uncategorized when you open the tool are mostly
payees with little or no history. Report results separately for:

- **all held-out rows**;
- **rows the tool would send to a model**: no unanimous exact-payee history;
- **cold rows**: no exact-payee history at all. This is closest to the real
  workload.

Check your own pending uncategorized rows too. If almost none of them have
exact-payee history, the cold-row numbers are the ones to trust.

## 3. Measure baselines before any model

Without these, a model number has no meaning.

- **Majority class:** always answer the most common category. Any method must
  beat it on the same rows.
- **History rule:** coverage and precision of "every prior exact-payee row
  agrees". Sweep the minimum number of rows (1, 2, 3, 5). Also compare
  last-used against plurality as the pick when rows disagree.
- **Personal prior:** train a naive-Bayes classifier on only the rows dated
  before each scored row. Use name tokens from the payee and both import
  fields, the account, and an amount bucket; `src/tools/personalPrior.ts` is
  the implementation the tool uses. Report top-1 and top-3, and precision and
  coverage at probability cut-offs such as 0.6, 0.8 and 0.9.

The tool's routing (`history_rule` → `personal_prior` → model) is itself a
baseline. Score the end-to-end pipeline, not just each piece: how many rows get
a confident answer, how many of those are right, and how often the right
category is in the shortlist offered for review.

## 4. Serve a local decision model with the same request shape

Ollama 0.40.4 and later expose `/v1/systemone`, which follows the System One
request and response shape the tool already sends to TypeSafe: `state`,
`questions` with `type: "choice"`, and answers carrying `choice`,
`probabilities` and `confidence`. Several open "decision" models in the Ollama
library are built for it. You can therefore send the tool's exact request body
locally and change only the `model` field:

```bash
curl http://127.0.0.1:11434/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "<decision-model-tag>",
    "state": {
      "eligible_categories": [
        {"key": "c000", "group": "Everyday", "name": "Dining Out"},
        {"key": "c001", "group": "Everyday", "name": "Groceries"}
      ],
      "transactions": [{"payee_name": "Lumen Pantry", "amount": -18.4, "direction": "outflow"}]
    },
    "questions": {
      "t00": {
        "type": "choice",
        "instructions": {"question": "Which eligible budget category best fits state.transactions[0]?"},
        "criteria": {"c000": null, "c001": null, "leave_uncategorized": "No eligible category is a sufficiently supported fit"}
      }
    }
  }'
```

Practical checks before a long run:

- **Option count.** The tool sends one option per eligible category plus
  `leave_uncategorized`. Some decision models accept up to 255 options; others
  document a much lower maximum. A model may accept more options than it was
  trained on and quietly do worse, so record which models you ran outside
  their documented range.
- **Validate every answer** with the same checks as `isChoiceAnswer` in
  `src/tools/SuggestCategoriesTool.ts`: every option present, probabilities
  summing to 1, and the choice is the arg-max. Count failures separately from
  wrong answers.
- **Memory.** Resident size grows with the model's default context length. A
  Modelfile with `PARAMETER num_ctx 8192` (enough for a request of 10
  transactions) can save gigabytes with identical answers; confirm that on a
  few rows.
- **Share the machine.** Long local runs compete with everything else on a
  laptop. Cap threads (`PARAMETER num_thread`), run under `nice`, and keep one
  model resident at a time.
- **Integrated GPUs** may need opting in (for example `OLLAMA_VULKAN=1` and
  `OLLAMA_IGPU_ENABLE=1`); check the server log for the device it uses.
- **Batch size.** The tool puts ten transactions in one state and asks about
  `transactions[i]`. Measure batch 1 as well; small models can confuse which
  transaction a question refers to.

## 5. Evaluate

For each model and request variant, on the same rows:

| Metric | Meaning |
|---|---|
| Accuracy as routed | the model's actual pick; `leave_uncategorized` counts as a miss |
| Forced top-1 | the best real category, ignoring `leave_uncategorized` |
| Top-3 | the label is among the three most probable real categories (the review shortlist) |
| Abstention | how often the model picks `leave_uncategorized` |
| Calibration | accuracy per confidence bin, plus expected calibration error on the winning probability |
| Routing precision | precision and coverage at each candidate threshold |
| Latency and memory | per call and per transaction, at the batch size you would ship |

Also try variants that change only what the model is told. One worth
measuring is listing each category's most frequent payees in the state; the
tool's opt-in `YNAB_AI_TYPICAL_PAYEES` setting does exactly this. Score it only
on held-out rows, building the lists from the training period, so the test
payees cannot leak in.

## 6. Choose thresholds per model

Confidence is not comparable across models. One model may cluster its
confidences low while still being right; another may report high confidence on
wrong answers. Synthetic fixtures can make a model look far better calibrated
than it is on real history.

- Pick a threshold from the held-out precision-coverage curve for **that
  model, version and quantization**, at a precision you would accept without
  review.
- If no threshold reaches it with useful coverage, the model should only rank:
  keep its answers as `needs_review`, which is what the tool does today.
- Store thresholds per pinned model (`MODEL_THRESHOLDS` in
  `src/tools/SuggestCategoriesTool.ts`) and refit them whenever the model,
  version or quantization changes.

## 7. What to expect

Evaluations of this kind on real household history tend to find that:

- Each household's taxonomy is personal (where restaurants, clinics, tolls or
  shared spending are filed), and general-purpose models guess it wrong.
- History rules and a small personal prior trained on the plan's own rows beat
  zero-shot models, local or hosted, on the rows that matter. They are
  instant, free and private.
- Telling the model what the household puts in each category, for example
  typical payees, closes much of the gap.
- Small local decision models abstain often or confuse transactions when
  batched, and run seconds per transaction on laptop hardware. Hosted models
  are much faster, but their confidence may not be trustworthy enough to skip
  review.

Treat these as hypotheses to check on your own data, not results.
