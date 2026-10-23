# Ledger payloads and evaluation

All improvement commands return JSON. Payload commands accept `--file <path>` or `--file -` for JSON on stdin. Run `equip improve help` and require `schema: 1`, `feature: "improvement-loop"`, and its command list before using them. The Equip repository's `cli/improvement/types.ts` defines the payloads. When this skill is installed without the repository, use the examples below and the installed CLI's help. If the contracts differ, report the mismatch instead of inventing fields.

The examples are synthetic shapes, not observations to insert into a real ledger. Replace their IDs, paths, evidence, counts, and configuration with actual local evidence. Keep scratch files private. Retain returned IDs rather than assuming a filename becomes an ID.

## Configuration and run

Create a configuration using only files actually read for the run. Repeat `--instructions` and `--skill` when needed. The command returns `{configurationId, configuration}`. Retain the ID for experiments and place only its `configuration` object in the run's `configuration` field:

```sh
equip improve snapshot --provider openai --model observed-model-id --harness codex --instructions /absolute/AGENTS.md --skill /absolute/skill --settings '{"reasoningEffort":"high"}'
```

A `RunInput` has this shape. Replace the entire sample configuration with the real snapshot. Unknown measurements stay omitted.

```json
{
  "id": "run-parser-001",
  "title": "Reject malformed input without changing stored records",
  "configuration": {
    "provider": "unknown",
    "model": "unknown",
    "harness": "unknown",
    "settings": {},
    "instructions": [],
    "skills": [],
    "environment": {"node": "unknown", "platform": "unknown", "arch": "unknown"},
    "basis": "declared"
  },
  "status": "blocked",
  "acceptance": {
    "met": 1,
    "total": 2,
    "evidence": ["Synthetic example: invalid JSON rejected; preservation check not run"]
  },
  "verification": "partial",
  "observations": [
    {"reason": "unfinished", "evidence": "Synthetic example: preservation criterion lacks evidence", "source": "agent"}
  ]
}
```

```sh
equip improve record --file /private/scratch/run.json
equip improve show run run-parser-001
```

Optional run fields are `session`, `repository`, `pr`, `elapsedMs`, `humanMinutes`, and `costUsd`. `status` is `completed`, `blocked`, or `failed`; verification is `verified`, `partial`, or `unverified`. A completed run requires all acceptance criteria met. Observation sources are `agent` or `check`.

## Feedback

Record a user verdict only from explicit feedback expressing that judgment. This synthetic example assumes the user actually supplied the quoted words:

```json
{
  "id": "feedback-parser-001",
  "runId": "run-parser-001",
  "source": "user",
  "verdict": "needed-steering",
  "reasons": ["unfinished"],
  "note": "User said: I had to remind you to check that the stored records were preserved."
}
```

```sh
equip improve feedback --file /private/scratch/feedback.json
equip improve summary --days 7
```

Verdicts are `delegate-again`, `needed-steering`, and `would-redo`. Both feedback and observations use these reason values: `unnecessary-questions`, `unfinished`, `incorrect`, `overengineered`, `poor-design`, `slow`, `cost`, `scope`, `authorization`, or `other`. Feedback always includes `reasons` and `note`. Use an empty reasons array if no reason is supported. Agent feedback uses `source: "agent"` and omits `verdict`.

## Case and experiment

A case must reference a recorded source run. Supply the sanitized fixture separately in the runner's isolated environment, and describe its identity in the case so another run can reproduce it.

```json
{
  "id": "case-parser-preservation-v1",
  "title": "Preserve records when malformed input is rejected",
  "prompt": "Fix malformed JSON handling. Use fixture parser-preservation-v1 in the isolated test repository.",
  "expected": "The parser rejects malformed JSON. Existing stored records remain byte-identical. The final response reports evidence for both criteria.",
  "sourceRunId": "run-parser-001",
  "kind": "regression"
}
```

Case kinds are `regression` and `capability`. Create the case, then register an experiment using the actual baseline and candidate configuration IDs returned by the CLI:

```sh
equip improve case --file /private/scratch/case.json
equip improve experiment --file /private/scratch/experiment.json
```

```json
{
  "id": "experiment-preservation-001",
  "hypothesis": "A completion check tied to each acceptance criterion prevents omitted preservation checks without harming valid-input handling.",
  "change": "Add one acceptance-evidence check to the relevant skill; preserve the baseline copy.",
  "baseline": "replace-with-baseline-configuration-id",
  "candidate": "replace-with-candidate-configuration-id",
  "caseIds": ["case-parser-preservation-v1"],
  "environment": "isolated-parser-fixture-v1; exact runtime, dependency lock hash, model endpoint and evaluator identity recorded locally",
  "metric": "pass-rate"
}
```

Metrics are `pass-rate`, `latency`, `cost`, and `human-effort`. Add actual neighboring regression cases before registering the experiment. Make the environment identity concrete and stable, including fixture, runtime, dependency, and evaluator versions. A description of the desired environment alone is insufficient.

## Runner contract

```sh
equip improve evaluate experiment-preservation-001 --runner /absolute/trusted-runner.mjs --repetitions 3 --timeout-ms 60000
equip improve compare experiment-preservation-001
```

The CLI sends JSON on stdin containing `schema: 1`, `experimentId`, `case`, `configuration`, `arm`, `replicate`, and `environment`. The configuration supplies declared model, harness, settings, and instruction/skill identities. Apply that configuration to actual execution. Resolve its preserved contents privately and verify hashes or revisions before running. `arm` is `baseline` or `candidate`. The runner must return one `RunnerResult` JSON object on stdout. Send diagnostic logs to stderr and keep secrets out of both streams.

```json
{
  "grade": "unknown",
  "evidence": ["Required preservation fixture is unavailable; no quality result was observed"]
}
```

Grades are `pass`, `fail`, and `unknown`. A successful execution can supply `pass` only with actual acceptance evidence. An unavailable model, fixture, tool, or judge produces `unknown`, not a manufactured success. Optional `costUsd` and `humanMinutes` must come from measurements; omit them when unknown. The CLI measures `elapsedMs` itself, including runner execution. This is not necessarily pure model latency.

The runner is arbitrary trusted Node code, not an OS sandbox. Establish isolation before invocation. Total planned slots equal cases times two arms times repetitions. Price and authorize any model calls the runner will make before starting. Deterministic checks can test concrete tool behavior; model behavior requires a runner that actually exercises the model and configuration. No model call is built into this workflow.

Evaluation binds the runner hash and actual Node version, platform, and architecture before execution. A resumed run must match that runtime; otherwise use a separate experiment and report the environment difference. The timeout forcibly stops the runner process; its sandbox must contain any descendant processes and external effects. Evaluation reserves durable trial slots before execution. Finished slots are skipped on rerun. An unfinished `running` slot can represent a crash or an operation whose effects are unknown. Inspect its trial and process state, preserve its evidence, and report it pending rather than replaying it through a new ID. A timeout does not prove an external call had no effect.

After independently reconciling an uncertain trial, `equip improve trial --file <private-trial.json>` can finish its existing reservation. Keep its identity, configuration, runner hash, arm, and replicate unchanged. Supply actual evidence and a grade, or `unknown` when the outcome cannot be established. Completed trial evidence cannot be replaced.

## Decision and local evidence

For efficiency comparisons, inspect `caseMetrics` and `metricRegressions` alongside the pooled medians. Any observed per-case median increase blocks an automatic improvement result; judge measurement noise against the predeclared tolerance and retain the raw trials.

Use agent feedback on the source run for the keep or revert decision. Include exact comparison results in the note, along with experiment and configuration IDs, thresholds, regressions, missing evidence, and remaining uncertainty. For example, use `reasons: ["other"]` and `source: "agent"` with no verdict. This stores an agent decision without claiming user satisfaction.

Use `equip improve show <kind> <id>` to inspect receipts. Kinds include `configuration`, `run`, `feedback`, `case`, `experiment`, `trial`, and `evaluation`. `equip improve export` and `equip improve import --file <private-ledger.json>` move small local ledgers explicitly (JSON input is limited to 2 MiB and 10,000 entries). For backups of any ledger size, use `equip improve export --directory <new-private-directory>`, then `equip improve import --directory <private-directory>`. The chunked format hashes every chunk, preserves dependency and feedback order, and restores one bounded chunk at a time. A failed restore retains earlier successful chunks; resume against the same immutable backup. Conflicting evidence or ambiguous tied feedback in overlapping ledgers is rejected rather than replacing a verdict; restore to a new `EQUIP_HOME` when histories cannot be reconciled. Inspect exports for private paths, prompts, and feedback before any separately authorized sharing. The ledger is separate from Equip's account sync; this skill performs no automatic upload.
