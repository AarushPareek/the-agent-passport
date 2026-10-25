# Agent Passport

**A promotion checkpoint for Agentforce agents, built as a plugin for the Copado Agentia CLI.**

Before an Agentforce agent moves from Dev to QA, Agent Passport checks three things: everything the agent needs is
in the user story, the agent still does what the story asks, and nothing has changed since it was tested. If any check
fails, Copado stops the story from moving on and tells the developer why.

Demo video: [sources/Agent-Passport-Demo.mp4](sources/Agent-Passport-Demo.mp4) ·
Deck: [sources/Agent-Passport-Deck.pdf](sources/Agent-Passport-Deck.pdf) ·
How it works in detail: [ARCHITECTURE.md](ARCHITECTURE.md)

## What it is

An Agentforce agent is an AI assistant built in Salesforce. It reads a customer's message, decides what to do, and
runs actions that call Flows, Apex classes and prompt templates. Teams build agents in a Dev org and use Copado to
move each change (a user story) through their environments, for example Dev → QA → Production.

Agent Passport gives every agent a **passport** for that journey: a stamp that proves the agent is ready to cross
into the next environment. It plugs into the Agentia CLI, Copado's command line tool, and into Agentia's local quality
gate, so the check runs automatically every time a developer tests or submits a story.

## The problem today

Copado's pipeline was built for metadata and code. An agent is different, and four things slip through:

1. **Missing pieces go unnoticed.** An agent depends on many files. If the story forgets one Flow, the deploy can still
   succeed, and the agent breaks only when a customer reaches that step in QA.
2. **Behaviour is never tested.** An agent's choices come from a language model. A small change to its instructions
   can send customers to the wrong place or skip an action, and no code check or Apex test notices.
3. **Changes after testing are invisible.** Even if someone tested the agent, nothing shows whether it was edited
   afterwards.
4. **Reviewers only see a code diff.** They can't see how the agent actually behaves before they approve it.

All four are usually found late, in QA or by customers, when fixing them costs the most.

## How Agent Passport solves it

| Problem | What Agent Passport does | Command |
|---|---|---|
| Missing pieces | Maps everything the agent depends on, then checks each piece is in the story or already in the next environment. Things that aren't files (the agent's user, publishing the agent) become ready-made Copado deployment steps. | `passport scan`, `passport travel` |
| Untested behaviour | Turns the story's acceptance criteria into short test chats, runs each one 3 times in the Dev org, and grants or refuses a stamp. | `passport goldens`, `passport stamp` |
| Changes after testing | The stamp records a fingerprint of every file it tested. Change one line and the stamp goes stale. | `passport verify` |
| Reviewers can't see behaviour | Writes one readable page with the verdict, every test chat and what the agent did. | `passport report` |

The quality gate ties it together: `agentia cicd work test` and `agentia cicd work submit` run `passport verify`
first. No valid passport, no submit.

![A refused passport: the agent sends an unfilled value to an action, and a Flow will not arrive in QA](sources/report-refused.png)

*A real report: the agent passed a broken placeholder to an action, said it was creating a case without creating one,
and the story forgot a Flow. The passport was refused, so the story could not be submitted.*

## How it works

**Pick the story → Scan → Travel → Test chats → Stamp → Submit → Gate → Copado promotes**

The developer (or a coding agent such as Claude Code) runs the checks on their own machine. The results are saved in a
`passport/` folder and committed with the story, so the proof travels with the change. When the developer submits,
Agentia's quality gate runs `passport verify`. A valid passport lets the submit carry on; anything else stops it, with
the reason. [ARCHITECTURE.md](ARCHITECTURE.md) explains each part with a diagram and a worked example.

## Before you start: prerequisites

Install these first, from their official pages:

| Tool | Get it | Check it | You should see |
|---|---|---|---|
| Node.js 22.12 or newer | [nodejs.org/en/download](https://nodejs.org/en/download) | `node -v` | `v22.12.0` or higher |
| Git | [git-scm.com/downloads](https://git-scm.com/downloads) | `git --version` | `git version 2.x` |
| Salesforce CLI | [developer.salesforce.com/tools/salesforcecli](https://developer.salesforce.com/tools/salesforcecli) | `sf --version` | `@salesforce/cli/2.x ...` |
| Copado Agentia CLI 1.1.0 or newer | [developer.copado.com/docs](https://developer.copado.com/docs), or `npm install -g @copado/agentia-cli` | `agentia --version` | `@copado/agentia-cli/1.1.0 ...` or higher |

If a check prints "command not found", close and reopen your terminal and try again. If it still fails, reinstall
that tool.

You will also need:

- A **Copado** org with access to Agentia, and a pipeline with at least two environments (for example Dev and QA)
  connected to a Git repository.
- A **Salesforce org with Agentforce** for the Dev environment (a free Developer Edition org works), with your agent
  in a Salesforce DX project. Agents built with Agent Script work best, because their previews record exactly what the
  agent did.

## Install Agent Passport

```sh
agentia plugins install git+https://github.com/AarushPareek/the-agent-passport.git --allow-unverified
```

npm builds the plugin during the install. You may see a line like `npm warn install-scripts ... prepare: npm run
build`. That is the build step, and it's expected.

**Check that it worked:**

```sh
agentia passport hello
```

You should see:

```
Agent Passport is connected to Agentia CLI 1.1.0
```

followed by a small table of your Agentia connections. `agentia passport --help` lists all the commands.

## Set up Copado and Salesforce

Do this once per machine and project.

1. **Connect Agentia to Copado.** Run `agentia setup` and follow the prompts to sign in to your Copado org. To check
   it, run `agentia passport hello`: the `cicd` row should say `yes` under Configured.
2. **Connect the Salesforce CLI to your Dev org.**
   ```sh
   sf org login web --alias my-dev-org
   ```
3. **Open your project.** Clone the Git repository your Copado pipeline uses and open a terminal in it.
4. **Pick the user story** you are working on in Copado:
   ```sh
   agentia cicd work set US-0000025
   ```
5. **Turn on the passport.** This adds Agent Passport to the project's quality gate and installs the agent skill for
   coding agents. Commit the files it creates.
   ```sh
   agentia passport setup --env Passport-Dev --agent CustomerServiceAgent --travel-to Passport-QA
   ```
   Use your own environment names (as they appear in the Copado pipeline) and your agent's name. Quality gates the
   project already has keep running, and `agentia passport setup --remove` takes it all out again.

If `agentia cicd work test` doesn't seem to run the quality gate, ask your Copado admin to make sure local quality
gates are enabled for your org.

## Use it, step by step

The example uses an agent called `CustomerServiceAgent` and the environments `Passport-Dev` and `Passport-QA`.
Replace them with your own.

**1. Check that everything the agent needs is in the story.**

```sh
agentia passport scan --agent CustomerServiceAgent
agentia passport travel --to Passport-QA --agent CustomerServiceAgent
```

Fix any errors from `scan`. If `travel` reports a gap, commit the file it names to the story. Add the deployment
steps it suggests to the story in Copado (a coding agent can do this for you through Agentia's MCP tools).

**2. Turn the acceptance criteria into test chats.**

```sh
agentia passport goldens init --agent CustomerServiceAgent
```

Open `passport/goldens/CustomerServiceAgent.json` and, for each criterion, write the message a customer would send in
`"utterance"`.

**3. Run the test chats in your Dev org.**

```sh
agentia passport goldens plan --agent CustomerServiceAgent --target-org my-dev-org
```

This prints the exact `sf agent preview` commands. Run them in order from the project folder. Each chat runs 3 times.

**4. Stamp the agent and write the report.**

```sh
agentia passport stamp --agent CustomerServiceAgent --env Passport-Dev
agentia passport report --env Passport-Dev --travel-to Passport-QA
```

`stamp` says `stamped` or `refused`, and why. If it's refused, fix the agent (not the test chats), run step 3 again
and stamp again. Open `passport/report.html` in a browser to see the full picture.

**5. Commit the passport and submit as usual.**

```sh
git add passport/
git commit -m "Agent passport for US-0000025"
agentia cicd work test
agentia cicd work submit
```

`work test` and `work submit` now check the passport first. If it isn't valid, they stop and print a short table
saying which check failed. If it is valid, Copado carries on as normal.

**Using a coding agent instead?** After `passport setup`, ask Claude Code, Cursor or a similar tool to "get
US-0000025's agent ready to promote". The installed skill teaches it the same steps and the rules: fix the agent,
never weaken a test, never edit the evidence, and never skip the gate.

## Commands

| Command | What it does |
|---|---|
| `passport hello` | Checks the plugin is connected to Agentia |
| `passport setup` | Adds the quality gate and the agent skill to a project (`--remove` takes them out) |
| `passport scan` | Maps everything the agent depends on and flags problems |
| `passport travel` | Checks every piece will reach the next environment and suggests deployment steps |
| `passport goldens init` | Drafts test chats from the story's acceptance criteria |
| `passport goldens plan` | Prints the `sf agent preview` commands that run the test chats |
| `passport stamp` | Scores the test runs and grants or refuses the stamp |
| `passport verify` | The gate check: exits with an error when the passport is not valid |
| `passport report` | Writes the readable HTML passport |

Every command accepts `--json`, and `agentia passport <command> --help` shows all its options.

## Tests

```sh
npm install
npm test                    # 162 unit tests, no network needed
agentia plugins link .      # the integration tests run the plugin inside the real Agentia CLI
npm run test:integration    # 27 integration tests
```

All 189 tests pass on Windows and Linux with Agentia CLI 1.1.0.

## Licence

Copyright (c) 2026 Aarush Pareek. All rights reserved. No open-source licence is granted. The source is public so that it
can be read, installed and evaluated for the Copado Agentia Headless Virtual Hackathon, whose rules grant Copado a licence
to the entry. The sample Salesforce projects used in the tests keep their own licences (see
[test/fx/README.md](test/fx/README.md)).
