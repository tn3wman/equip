---
name: improve
description: Improves Tyler's agent instructions and skills from evidence, using Equip's local improvement ledger to record task outcomes and feedback, diagnose recurring agent failures, and compare a baseline against a candidate change over repeated runs. Use for "$improve", retrospectives, "why do agents keep doing X", recording feedback about a run, or testing an instruction or skill edit before publishing it.
---

# Improve

Change the agent system only on evidence, and measure each change. **Done means:** the change is kept or reverted because a predeclared metric moved, and the decision is recorded in the ledger.

## Check the CLI

Run `equip improve help`. It must return JSON with `"feature": "improvement-loop"`, which needs CLI 1.1.10 or newer and Node 22.20 or newer. Older CLIs print status output instead. In that case, report that recording is unavailable rather than claiming a write.

The ledger is `~/.equip/improvement/ledger.sqlite`. It stays local and holds no credentials. [references/ledger.md](references/ledger.md) has the payload shapes and the runner contract; read it before writing payloads.

## Record

After substantial work, or when Tyler volunteers feedback:

1. Snapshot the configuration you actually used: `equip improve snapshot`, passing only the instruction files and skills you read.
2. Record the run: `equip improve record --file <private.json>`, with acceptance met out of total and the evidence. Omit unknown costs rather than entering zero.
3. Attach Tyler's own words with `equip improve feedback`. Set a verdict (`delegate-again`, `needed-steering`, `would-redo`) only when he actually said that. Never ask for a rating just to fill the field.

## Diagnose

- Run `equip improve summary --days 7` and read the runs behind each pattern.
- Name one failure mechanism and one competing explanation. Many "instruction problems" are really missing information, broken tooling, or a weak check.
- Fix a mechanical cause with a hook, script, or config before adding prose.
- Turn the failure into an `equip improve case`: a realistic prompt plus the expected observable behavior, including a neighboring behavior the fix must not break.

## Test a candidate

Climb with `climb`'s rules, using the Equip runner as the eval:

- State a falsifiable hypothesis. Make the smallest edit, preferring deletion; every instruction encodes an assumption about what the model can't do on its own.
- Snapshot the baseline and the candidate, then register an experiment with one deciding metric, a threshold, a repetition count, and a budget.
- `equip improve evaluate <id> --runner /absolute/trusted-runner.mjs --repetitions 3`. Inspect the runner first. It must apply each configuration and grade observable behavior. The runner provides no OS sandbox and may call paid models only within existing usage.
- `equip improve compare <id>`. Keep the candidate only if it clears the threshold with no per-case regression. Otherwise keep the baseline.
- Record the decision as agent feedback on the source run.

Publish a kept change to the skill or instruction file through Equip, with `cross-review` under the global rules.
