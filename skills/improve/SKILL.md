---
name: improve
description: Record substantial task outcomes and volunteered user feedback in Equip's local ledger. Use for retrospectives, diagnosing recurring agent failures, evaluating instruction or skill changes, and closing the improvement loop with repeated baseline and candidate comparisons.
---

# Improve

Turn observed task results into tested changes. Keep objective acceptance, explicit user feedback, and agent diagnosis separate throughout.

## Check availability and evidence

Run `equip improve help` first. Require JSON with `schema: 1`, `feature: "improvement-loop"`, and an improvement command list. This feature ships in CLI release 1.1.10 and requires Node.js 22.20.0 or newer. Older CLIs can fall through to status output, even with a successful exit. Status output is not an improvement receipt. If the marker is absent, report that improvement commands are unavailable in the installed CLI and leave recording pending. Do not claim a write or silently install an update.

The ledger lives at `$EQUIP_HOME/improvement/ledger.sqlite`, with `EQUIP_HOME` defaulting to `~/.equip`. It stays local. Keep private evidence, exports, and scratch payloads outside repositories and shared folders with private permissions. Store the minimum redacted evidence needed to verify the finding. Never copy credentials into the ledger. Exporting evidence does not authorize uploading or sharing it.

Read [references/ledger.md](references/ledger.md) when constructing payloads or running an experiment. It contains examples and the runner contract. Use the CLI for persistence and comparison rather than implementing another ledger or editing SQLite directly.

## Record the result

After substantial work, capture the run's acceptance counts, verification, concrete observations, and known measurements. Include evidence for unmet criteria as well as passes. Count the criteria agreed for the task, not incidental tool calls. A completed status alone does not prove acceptance or verification. Omit unavailable cost, time, and effort measurements instead of entering zero.

Attribute the run to the provider, model, settings, harness, instruction hashes, and skill revisions supported by evidence. Run `equip improve snapshot` with only instructions and skills actually read for this task. Capture the configuration before editing those files, or use preserved original revisions. A snapshot of today's files cannot establish yesterday's configuration. Preserve file contents privately if needed to reproduce either version, since hashes alone cannot reconstruct them.

Snapshots have `basis: "declared"`. They identify declared inputs, not proof that a model loaded or obeyed them. Use `unknown` for unidentified provider, model, or harness values and leave unobserved settings out. Keep uncertainty about actual model and tool execution explicit in the evidence. An advertised model is not proof of the executing model.

Submit the run with `equip improve record --file <private-run.json>` and retain its returned run ID and configuration ID. Check the JSON receipt before reporting it recorded. Use stable IDs and inspect `equip improve show run <id>` before retrying an uncertain write.

When the user volunteers feedback, attach its words to the actual source run with `equip improve feedback`. Assign a user verdict only when the user explicitly expresses the corresponding judgment: `delegate-again`, `needed-steering`, or `would-redo`. Ambiguous feedback can have a note without a verdict. Silence, a passing test, task completion, or the agent's confidence supplies no satisfaction evidence. Never solicit a rating merely to fill a missing field. Agent observations use `source: "agent"` and omit `verdict`.

Routine recording ends with a confirmed receipt. It does not require a retrospective or experiment on every task.

## Diagnose a recurring problem

For a retrospective or requested improvement, run `equip improve summary --days 7`, adjusting the window to the available evidence. Inspect the source runs, feedback, configurations, and checks behind each suggested issue. Keep explicit feedback separate from observations and report the number of relevant runs and known measurements. Frequency alone does not establish a cause.

Identify a repeated failure mechanism and consider a competing explanation. Distinguish instruction ambiguity from missing information, broken tooling, weak verification, or an unsuitable evaluation environment. Prefer repairing a proven mechanical cause over adding a universal instruction. A single serious failure can justify a regression case, but describe it as one observation rather than a recurring trend.

Create an `equip improve case` linked to an actual source run. Preserve a realistic prompt, observable expected behavior, and enough sanitized fixtures to reproduce the failure safely. Include relevant neighboring behavior that a proposed fix might damage. Keep case contents fixed during comparison. A changed case needs a new ID and a new experiment.

## Test a small candidate

State a falsifiable hypothesis and change the smallest relevant instruction or skill. Follow applicable instruction-writing guidance and review requirements. Keep the baseline intact and preserve both versions in isolated local workspaces. This skill grants no new publication, production, spending, scheduling, or global-instruction authority.

Snapshot both configurations and register an experiment with their returned configuration IDs, immutable case IDs, an explicit environment identity, and one deciding metric. Before evaluation, state the success threshold, tolerated regressions, repetition count, and budget. Keep provider, model, settings, harness, fixtures, evaluator, and environment constant where possible. If they change, treat the result as a comparison of whole configurations and disclose the confound.

Supply a trusted absolute Node runner to `equip improve evaluate`. Inspect what it executes first. It must actually apply the requested baseline or candidate configuration, exercise the case, and grade observable behavior. Returning canned success or merely checking that text exists is not an evaluation of agent behavior. Keep grading consistent across arms and independent of their labels where feasible.

Run both arms repeatedly on the same cases in a caller-provided safe sandbox with isolated fixtures. The CLI does not provide OS sandboxing. Block unintended network calls and live writes in the runner environment. Evaluation makes no automatic model API calls. Any runner that invokes paid models must have an explicit provider, model, total call budget, and existing authorization covering that usage. Prepare an offline comparison if that authority is absent. Create no subscription, trial, or recurring schedule.

Use `equip improve compare <experiment-id>` after the run. Examine paired repetitions, missing or unknown grades, per-case metric regressions, runner identity, actual execution runtime, and confounds. Report latency, cost, and human effort only with their known denominators. A single favorable run or an aggregate pass rate cannot erase a regression. Reuse finished trial slots on resume. A reserved `running` trial has uncertain effects; inspect it and reconcile the process before any replacement work. Never bypass its reservation by inventing a fresh experiment ID to replay it.

## Close the loop

Keep the candidate only when the predeclared criterion passes and relevant regressions are resolved. Revert a demonstrated regression. If evidence is missing, confounded, or mixed, keep the baseline and state what would resolve the uncertainty. Successful deterministic checks can support a narrow claim; they cannot prove user satisfaction or general model quality.

Record the decision as agent feedback on the source run, without a verdict. Include the experiment ID, baseline and candidate IDs, observed results, limitations, keep or revert decision, and next check. Retain the comparison and supporting evidence locally. The decision record describes the outcome; applying or publishing a change still follows the task's authority and review requirements.

Report what changed, the evidence that justified the decision, unresolved uncertainty, and the relevant local IDs. Check later real runs for recurrence and volunteered feedback. Reopen the diagnosis if the improvement fails in practice rather than accumulating rules around an unproven fix.
