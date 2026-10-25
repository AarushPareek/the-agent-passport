---
name: agent-passport
description: Use when changing, testing, committing, publishing, submitting or promoting an Agentforce agent (Agent Script .agent files, bots, topics, actions, or the Flows, Apex and prompt templates they use) in a Copado project, or when `agentia cicd work test` or `work submit` fails with "PASSPORT NOT VALID".
---

<!-- Agent Passport managed skill file: agentia passport setup -->

# Agent Passport

Before an Agentforce agent moves to the next environment, three things need to be true. Everything it depends on
travels with the story. It still does what the story's acceptance criteria say. And nothing has changed since that was
tested. Agent Passport checks all three and keeps the proof in `passport/`. The project's local quality gate runs
`agentia passport verify`, so `agentia cicd work submit` will not go through until the passport is valid.

You run `sf` and Agentia commands. The plugin itself only reads files and Git. Add `--json` when you need to parse the
output. If the Agentia MCP tools (`agentia_*`) are available, use them for Copado operations and fall back to the CLI
when they are not.

## Steps

1. Check which story is active: `agentia cicd work get --json`, or the MCP tool `agentia_work_get` with no id. If no
   story is active, tell the user and stop. Don't choose one yourself.
2. Scan the agent: `agentia passport scan --agent <Agent> --json`. Fix every finding with level `error` before you go
   on, for example `MISSING_DEPENDENCY`, `UNKNOWN_TARGET`, `NAME_MISMATCH` or `AGENT_USER_HARDCODED`.
3. Check what will reach the next environment: `agentia passport travel --to <next environment> --agent <Agent> --json`
   (use `--to-branch <branch>` when offline). Each `TRAVEL_GAP` names a file and the reason. Commit that file to the
   story with `git add` and `git commit`.
4. Add the deployment steps. Every item under `requirements` has a `proposedStep` for something metadata can't carry,
   such as the agent user, or publishing and activating the agent. Look at what the story already has with
   `agentia_work_deployment_step_list` (CLI: `agentia cicd work deployment-step list --json`) and skip any step whose
   name is already there. Show the user what you are about to add, then create each step with
   `agentia_work_deployment_step_create`, or with the CLI:
   `agentia cicd work deployment-step create --type "Manual Task" --name "<name>" --instructions "<instructions>" --sequence <order> --environment destination --json`
   (`order` is `before` or `after`). Don't delete or change steps you didn't create.
5. Draft the test conversations: `agentia passport goldens init --agent <Agent> --json` writes one conversation per
   acceptance criterion to `passport/goldens/<agent>.json`. Write each `utterance` following
   [references/writing-goldens.md](references/writing-goldens.md). Only add expectations by hand where `needsReview`
   asks for them.
6. Run the previews: `agentia passport goldens plan --agent <Agent> --target-org <alias> --json` prints the exact
   `sf agent preview` commands. Run them in order, one session at a time, from the project root, because Salesforce
   CLI saves the traces there. Use live actions unless the user has agreed to `--simulate`.
7. Stamp: `agentia passport stamp --agent <Agent> --env <current environment> --json`.
   - If the verdict is `stamped`, carry on.
   - If it is `refused`, read the first failing check for each conversation. Fix the **agent** (its script, actions,
     Flows or Apex), not the test conversation. Then run the plan and stamp again.
   - If you see `REGRESSION`, something that used to pass now fails. Tell the user.
8. Write the report and commit the proof: `agentia passport report --env <current environment> --travel-to <next environment>`
   writes `passport/report.html` for reviewers. Then `git add passport/` and commit it to the story along with the
   change, so the stamps and the report travel with it.
9. Run the gate: `agentia cicd work test --json` (MCP: `agentia_work_test`), which runs `agentia passport verify`. If
   it prints `PASSPORT NOT VALID`, the table explains why: no stamp, a refused stamp, a stale stamp (the agent, a
   dependency or the test conversations changed after stamping), scan errors or travel gaps. Fix it and go back to the
   step it points to.
10. Publish and submit: `agentia cicd work publish --json`, then `agentia cicd work submit --json`. Only use
    `submit --deploy` or `--done` when the user asks you to promote.
11. Once Copado has deployed to the next environment, run the same conversations against that org and stamp it too:
    `agentia passport stamp --env <next environment> --agent <Agent>`.

## Rules

- Never make a failing check pass by weakening it. Don't delete or loosen expectations, lower `passThreshold` or
  `runsPerConversation`, or reword an utterance until it passes. Editing the goldens file makes the stamp stale, and
  the edit shows up in the story's diff. If a criterion looks wrong, say so to the user.
- Don't write or edit anything under `.sfdx/agents/**/sessions/`, `passport/stamps/` or `passport/baselines/` by
  hand. Those files are the evidence. Use `stamp --update-baseline` only when the user agrees the new behaviour is
  correct.
- Never use `agentia cicd work submit --skip-local-tests` to get past a failing passport.
- Never print credentials, tokens, OAuth signatures or org usernames from command output.
- `agentia passport setup` looks after the gate scripts and this skill. Don't edit the lines between the
  `agent-passport` markers in `.agentia_quality_gates.*` by hand; run setup again instead.

## When you finish

Tell the user which agent and environment you checked, the stamp verdict and pass rates, any regressions, the
deployment steps you added, and anything they still need to do, such as rewording a criterion.
