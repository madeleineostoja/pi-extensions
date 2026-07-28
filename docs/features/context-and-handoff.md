# Context and Handoff

Long coding sessions accumulate two different kinds of weight: tool output that is no longer worth carrying verbatim, and history that belongs to a model you are about to leave. Pipkin handles both without pretending the work never happened.

## Context: deterministic pruning with recall

Context shows a tool result in full when it is first produced. On a later model request it may replace stale, superseded, repeated, covered, or already-consumed low-risk bash output with a reasoned stub. The original session entry is never changed.

Pruning happens in deterministic branch-local epochs. Context evaluates every eligible unlatched result, chooses at most one earliest qualifying suffix, persists its complete decisions, and only then changes the outgoing message copies. Existing epoch decisions replay after reload, resume, fork, and compaction while their source calls remain in active context. Every stub is stable and includes its source ID:

```text
[read result elided: covered by a later read of PATH at user entry 8. Call context_recall("TOOL_CALL_ID") to retrieve.]
```

A successful result can qualify because it is stale after four later user entries and large enough, because a later edit or write supersedes a read, because a later read returns the same or covering lines without an intervening mutation, or because a later assistant consumed low-risk bash output. Read comparisons use Pi's returned-line truncation details, not requested bounds.

Epochs prefer a matching fresh model transition with at least 8k savings, then a qualified warm-cache opportunity with at least 32k savings after eight user entries, then a small changed tail. Context does not measure pressure, invoke compaction, alter Pi's compaction settings, or make a compaction decision. Native Pi compaction remains the sole owner of context-window pressure.

### Recall exactly what you need

Pass the ID printed in a stub:

```json
{ "id": "TOOL_CALL_ID" }
```

The full call returns the original stored content blocks unchanged. For one-text-block results, request a positive 1-indexed line or range:

```json
{ "id": "TOOL_CALL_ID", "lines": "40-80" }
```

Missing IDs, invalid ranges, non-text or multi-block slices, unavailable content, and empty slices are real tool failures. Recall does not alter the original pruning decision.

## Handoff: continue in a focused child session

After switching to a different model in a persisted TUI session, run:

```text
/handoff [optional focus]
```

Pipkin records the live source and target of that model transition. The recorded source model—not the selected target—generates a concise continuation prompt from the current session context. Review and edit that prompt before anything changes.

On approval, Pipkin atomically creates a same-working-directory child session linked to the parent. The child contains only the target model selection and a hidden, recoverable draft; it contains no parent transcript, compaction summary, or retained tail. Pi then switches to that child. When its live model matches the recorded target, the reviewed prompt is placed in the editor for review. It is never submitted automatically.

A handoff is available only for the latest active-branch transition, before the target has responded. Switching again, changing branch, responding with the target, an unavailable source model, failed authentication, cancellation, or an empty generated prompt leaves no child attempt. Handoff requires TUI mode and a persisted parent session.

A fixed startup `--model` can override the child's saved target. Pipkin withholds the draft if the live model does not match; reopen the child with its recorded target to recover it. This is also the recovery path for an unexpected replacement failure: both the intact parent and durable child remain available.

### Recover a draft

If editor text is lost, reopen the empty child under its recorded target and run:

```text
/handoff-recover
```

Recovery copies the child draft into the editor without submitting it. It refuses children with user or assistant history, a different live model, or no matching draft. A cancelled switch removes its child before releasing the original transition for retry; if cleanup cannot be verified, the committed child path remains the durable recovery path.

Handoff does not compact or delete the parent, infer a source model from history, fall back to the target model, or transfer the parent transcript into the child.

### Persistence boundary

Handoff assumes one Pi runtime is the sole writer for a parent session file while a handoff is in progress. Concurrent, separate Pi processes writing the same parent file are unsupported; use one runtime per parent file.
