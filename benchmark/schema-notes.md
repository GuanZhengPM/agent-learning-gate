# Wrong Lessons v0 schema

`wrong-lessons-v0.jsonl` is a hand-authored bilingual benchmark for checking proposed long-lived Agent learning. Each physical line is one complete JSON object. The corpus is balanced across Chinese and English: every category contains three `zh` and three `en` cases.

## Record fields

- `id`: stable case ID in the form `wl-v0-NNN`.
- `language`: evidence language, currently `zh` or `en`.
- `category`: primary behavior under test. A case may still expect more than one error code.
- `evidence`: the user-side evidence from which the proposal was inferred.
  - `text`: exact synthetic user utterance.
  - `source_turn`: stable synthetic turn ID.
  - `kind`: normalized evidence kind, such as `explicit_preference`, `implicit_praise`, `one_off_instruction`, `factual_statement`, `procedure_request`, `explicit_remember`, `sarcasm`, or `mixed_feedback`.
  - `scope`: maximum scope directly authorized by the evidence.
  - `explicit_persistence`: whether the user explicitly asked for future persistence.
- `current`: configuration state visible to the checker.
  - `active_scope`: named runtime context, written as `<scope>:<fixture-name>` when a fixture name is useful.
  - `artifacts`: zero or more existing typed rules. Every artifact has `id`, `target`, `content`, `scope`, and `status`.
- `proposal`: the candidate learning write.
  - `target`: one of `agent.md`, `memory`, or `skill`.
  - `content`: the behavior, fact, or procedure the Agent proposes to persist.
  - `scope`: requested applicability.
  - `durability`: `observation`, `candidate`, `stable`, or `procedure`.
  - `supersedes`: existing artifact IDs explicitly replaced by this proposal.
  - `trigger`, `steps`, `success_criteria`: procedure structure. Non-skill proposals keep `trigger` as `null` and both lists empty.
- `expected_decision`: oracle decision: `PASS`, `BLOCK`, or `ABSTAIN`. `PASS` only means that the proposal may proceed to host-routed operation review and, where supported, native staging; it never authorizes a write by itself. `BLOCK` means a deterministic violation. `ABSTAIN` means the evidence cannot safely support a deterministic conclusion, so no persistent write should occur. Aggregate severity is `BLOCK > ABSTAIN > PASS`; for example, ambiguous praise with a global proposal reports both ambiguity and scope widening but resolves to `BLOCK`.
- `expected_codes`: all expected diagnostic codes. It is empty for clean `PASS` cases.

## Scope model

Allowed scope strings are `turn`, `session`, `task`, `workspace`, `project`, `task_family`, `domain`, and `global`. The checker treats `project` as an alias of `workspace` and uses a partial order rather than a single linear ranking:

```text
global covers every scope
domain -> task_family -> task -> session -> turn
workspace/project -> task -> session -> turn
```

`workspace` and `task_family` are incomparable. A proposal widens scope only when its requested scope strictly exceeds what the evidence authorizes along one of these paths; it must not infer cross-branch authorization.

## Categories

The 54 cases contain six examples in each category:

1. `explicit_preference`: explicit, correctly scoped behavioral preferences.
2. `ambiguous_praise`: praise that does not identify the rewarded behavior.
3. `one_off_command`: turn/task instructions incorrectly persisted for later use.
4. `scope_widening`: supported content generalized beyond its evidence scope.
5. `wrong_destination`: facts, policies, and procedures routed to the wrong artifact type.
6. `conflict`: overlapping incompatible rules, including one valid explicit replacement and one valid scoped override.
7. `skill_lacking_procedure`: skill proposals without actionable triggers, steps, or success criteria, plus complete positive controls.
8. `explicit_remember`: explicit requests to persist facts, policies, or complete procedures.
9. `sarcasm_mixed_feedback`: sarcastic or mixed feedback, including correctly extracted explicit clauses.

## Diagnostic codes

- `E001_INVALID_INPUT`: document shape, enum, operation, role, or text-vs-metadata scope is invalid.
- `E101_WRONG_DESTINATION`: proposal content does not belong in the requested artifact type.
- `E201_SCOPE_WIDENING`: proposal scope exceeds or crosses the evidence-authorized scope.
- `E202_ONE_OFF_AS_PERSISTENT`: a one-off instruction is converted into durable configuration.
- `E301_CONFLICT`: proposal creates a typed, overlapping, incompatible rule without an explicit valid replacement or scoped override.
- `E401_AMBIGUOUS_REWARD`: praise or reward does not identify the rewarded behavior.
- `E402_MIXED_OR_SARCASTIC_FEEDBACK`: proposal reverses or ignores a clear sarcastic/mixed-feedback clause.
- `E501_INSUFFICIENT_EVIDENCE`: evidence lacks the detail required for the proposed durable rule or procedure.
- `E502_UNSUPPORTED_LESSON`: at least one proposed semantic clause lacks extractive support in the supplied evidence.
- `E503_POLARITY_REVERSAL`: the proposal reverses a supported negation, preference relation, or confirmation policy.
- `E601_SKILL_LACKS_PROCEDURE`: a skill lacks an actionable trigger, ordered steps, or success criteria.
- `E701_OPERATION_MISMATCH`: the reviewed or staged file operation does not exactly implement the checked proposal.

## Intended evaluation

Evaluate the exact decision and the set of codes independently. Code order is not semantically meaningful. A robust implementation should also validate the JSON shape before applying policy rules and must leave configuration unchanged on both `BLOCK` and `ABSTAIN`.
