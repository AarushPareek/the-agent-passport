<!-- Agent Passport managed skill file: agentia passport setup -->

# Writing golden conversations

A golden conversation is a short test chat for one acceptance criterion. `goldens init` fills in what to expect
(which subagent or topic the chat should reach, and which actions should or shouldn't run). You write what the
customer says.

## The file

`passport/goldens/<agent>.json`:

```json
{
  "agent": "CustomerServiceAgent",
  "bundle": "CustomerServiceAgent",
  "passThreshold": 1,
  "runsPerConversation": 3,
  "schemaVersion": 1,
  "conversations": [
    {
      "id": "AC-1",
      "criterion": "A refund request routes to the resolution subagent.",
      "story": "US-0000025",
      "needsReview": ["Write the customer message (utterance) that tests this criterion."],
      "turns": [{"utterance": null, "expect": {"inputsResolved": true, "topic": "resolution"}}]
    }
  ]
}
```

## Utterances

- Write it the way a real customer would: first person, plain words, one request. For the criterion above:
  `"I was charged twice for my last order and I want a refund"`.
- Don't name the subagent, topic or action (no "route me to resolution"). The point is to see whether the agent gets
  there on its own.
- Give the details the action needs to actually run (an order number, a product). Otherwise the agent will just ask a
  follow-up question. For a follow-up, add a second turn: `{"utterance": "It was order 1042", "expect": {...}}`.
- Only use made-up data: no real customer names, emails or record Ids.
- When you've written it, remove the `needsReview` entry you dealt with. Leave any you couldn't resolve and tell the
  user.

## Expectations

| Field | Checks |
|---|---|
| `topic` | the turn reached this subagent (Agent Script) or topic (classic) |
| `actionsInclude` | these actions ran in the turn |
| `actionsExclude` | these actions did not run (for "must not" criteria) |
| `replyMatches` / `replyNotMatches` | the reply matches / does not match this case-insensitive regular expression |
| `inputsResolved` | no action received an unfilled merge field such as `{!state.issue_type}` (default true; keep it) |

Use only names that exist in the agent: `goldens plan` refuses unknown subagents, topics and actions. Add a
`replyMatches` pattern when a criterion is about what the agent says, for example `"case (number|#)\\s*\\d+"` for
"tells the customer the case number".

## Why each conversation runs several times

An agent's routing comes from a language model, so it can change from one run to the next. With `runsPerConversation`
(default 3) and `passThreshold` (default 1, meaning every run must pass), a stamp means the agent passes reliably, not
that it got lucky once.
