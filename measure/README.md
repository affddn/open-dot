# Recall measurement (#42)

`run.ts` builds what a dot would see for each question with the plugin's own functions. `composeTurn` gives the checkpoint, the listed notes and the tail, and `recallResults` gives `dot_recall`. It does this for four arms, with that arm's switches set on an in-memory database:

| Arm       | What the dot sees                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `today`   | The fixture's frozen compaction `summary` and the newest `visibleTail` messages after it.                                                     |
| `b`       | `today`, plus `dot_recall` for the question's three longest uncommon words. This stands in for the dot choosing its own search.               |
| `b+d1`    | `b`, plus automatic recall for the question as the owner's latest message.                                                                    |
| `b+d1+d3` | `b+d1`, plus the ledger: the checkpoint for the context's text compaction, observed rows in recall, and the "since the last checkpoint" list. |

It scores retrieval: whether the answer text or its source message ID is in that view. Nothing calls a model, OpenCode or the network, and nothing opens the live open-dot database.

```
bun measure/run.ts                                  # the synthetic fixture
bun measure/run.ts --details                        # per-question results too
bun measure/run.ts --fixture <path> --private       # the owner's private fixture
bun measure/run.ts --fixture <path> --private --import <scores.json>
```

## Imported answer scores and provider tokens

Answer accuracy and provider cache counts need a live run, which this harness never makes. Whoever runs one records it as JSON and passes it with `--import`:

```json
{
  "fixtureSHA256": "<the report's fixtureSHA256>",
  "arms": {
    "today": {
      "q01": { "steps": [{ "answerScore": 1, "cachedTokens": 1200, "uncachedTokens": 300 }] }
    },
    "b": { "q01": { "steps": [] } },
    "b+d1": {},
    "b+d1+d3": {}
  }
}
```

The import is refused when any of these hold:

- It names another fixture.
- It doesn't have exactly the four arms.
- It names a question the fixture lacks.
- A score is outside 0 to 1.
- A token count isn't a whole number.

Every model request a question takes is a step. The report keeps every step's own `cachedTokens` and `uncachedTokens` exactly as imported, and `cachedDelta`, the plain change in cached tokens from the step before. It doesn't diagnose cache breaks: provider minimums and block sizes, cache boundaries, expiry and changed input all move these counts, and the counters alone can't tell which. A step without counters, and the step after it, have `cachedDelta` `unavailable`. A question, score or counter the import lacks is reported as missing or `unavailable`, never estimated. Without `--import`, the report says answer scores and provider tokens are unavailable. `addedTokensEstimate` is each arm's added bytes divided by 4, an estimate, not a provider count.

## The shipped fixture

`synthetic.json` is entirely made up:

- 40 questions, 16 of them paraphrases, about a fictional project, Orchard.
- 440 messages.
- A short frozen summary.
- 20 ledger rows written by hand, not by an observer.

Its scores check that the harness works and say nothing about real use.

## Measuring for real, later

After some real use, the owner writes a private fixture with the same shape, `"synthetic": false`. It needs:

- 30 to 50 questions about real early facts, including paraphrases, each naming its source message.
- The frozen summary the dot actually had.
- Optionally, the ledger rows the observer actually wrote.

Keep it outside the repository, for example under `~/.opendot/evidence/issue-42/`. Never commit it, and never paste its contents into an issue.
