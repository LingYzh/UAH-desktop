---
name: grilling
description: Use when the user explicitly wants to grill, stress-test, clarify, or complete a plan, design, requirement, architecture, workflow, or idea; also use before planning or execution when unresolved material ambiguity could materially change scope, behavior, architecture, irreversible actions, or acceptance criteria. Prefer the host Agent's interactive Ask tool, research facts yourself, ask only real decisions, and resume the original task automatically after preflight ambiguity is resolved.
license: MIT
metadata:
    author: github.com/mattpocock
    customized_by: github.com/LingYzh
    upstream_commit: "85f83d3fde1d3a90d5c9a657f6998c79a6c37308"
    upstream_skill_blob: "8ca78c6d8f901aab0c5a1f896034b70e666ff2a3"
    version: "1.2.0-personal.3"
---

# Grilling

Use this Skill to reduce avoidable rework by resolving material decisions before they become assumptions.

The goal is not to maximize the number of questions. The goal is to expose and settle decisions whose answers materially affect the result, while researching facts yourself and leaving low-impact implementation details to existing conventions or reasonable defaults.

## 1. Two Activation Modes

This Skill has two distinct modes.

### Mode A — Explicit Grilling

Use full grilling when the user explicitly asks to:

- grill or stress-test an idea, requirement, plan, architecture, workflow, or decision
- clarify requirements before implementation
- identify missing decisions or assumptions
- turn a loose idea into a sufficiently complete specification
- compare several viable product/architecture choices before committing

In this mode, build and work through the material design tree until the material frontier is empty.

Do not execute the resulting plan or implementation until the user confirms the final shared understanding, unless the user explicitly asks to transition directly into execution at that point.

### Mode B — Execution Preflight

Use a short ambiguity preflight when the user has asked the Agent to plan or execute a task, but inspection reveals unresolved **material ambiguity** that could cause significant rework if guessed incorrectly.

Run this preflight **before** writing a detailed plan, modifying code/files, or committing to an architecture.

Ask only the unresolved material decisions needed to make the requested task safe to proceed.

Once those decisions are resolved, automatically return to the user's original planning/execution task. Do **not** require a separate final "shared understanding" confirmation in this mode unless:

- the user asked for discussion/planning only
- the remaining action is destructive, irreversible, or unusually high-impact
- the user explicitly requests another confirmation gate

### Do not activate merely because certain words appear

Do not trigger this Skill just because the prompt contains words such as `plan`, `design`, `requirement`, `architecture`, or `specification`.

If the task is already materially clear, proceed normally.

## 2. What Counts as Material Ambiguity

An ambiguity is material when two or more reasonable answers would lead to meaningfully different outputs, behavior, architecture, scope, or acceptance results.

Common material ambiguities include:

- unclear feature scope or ownership boundary
- conflicting or incomplete acceptance criteria
- several materially different user-visible behaviors
- architecture choices that strongly affect future implementation or migration cost
- data model/API contract choices that affect multiple consumers
- platform/runtime targets that change the implementation strategy
- destructive, irreversible, or migration-related choices
- security, permission, privacy, or persistence behavior where guessing is costly
- a contradiction between new instructions and an already-settled project/user policy

Usually **not** material:

- naming that can follow project conventions
- minor reversible implementation details
- formatting/style already established by the project
- facts discoverable from the codebase, files, docs, tools, or web
- a choice whose answer already follows from a settled user policy
- a low-impact choice where one reasonable default can be changed cheaply later

Uncertainty alone is not enough reason to ask. Ask when the answer is **decision-sensitive** and guessing could materially increase rework.

## 3. Facts Are the Agent's Job

Do not ask the user for information that can reasonably be discovered from available sources or tools.

Before turning something into a question:

1. inspect the current codebase, files, docs, linked sources, project configuration, or connected tools when relevant
2. search external/current information when the decision depends on changing facts
3. use sub-agents when available and useful, but do not depend on them existing
4. distinguish a fact from a preference/decision
5. inspect existing project conventions before inventing a new decision surface

Examples:

- "Does the project already have a request wrapper?" -> inspect the project
- "Does the reference project already solve this?" -> inspect the reference project
- "Which behavior do you want when both designs are valid?" -> ask the user

If the user is the only source of a genuinely necessary fact, ask it plainly.

## 4. Existing Architecture and Reference Implementations Are Strong Defaults

When the current project or a user-designated reference implementation already has an analogous policy, treat it as a strong recommendation unless there is a concrete reason not to.

Do not manufacture a fresh architecture choice merely to create another question.

When relevant, explain the recommendation briefly:

> The existing project already handles X this way, so I recommend keeping the same behavior unless this feature has a specific reason to diverge.

The user still owns material decisions, but consistency should be the default recommendation when it reduces unnecessary design surface.

## 5. Design Tree and Frontier

For explicit grilling, represent the problem as a **design tree**:

- each decision can unlock later decisions
- a decision may depend on facts or earlier decisions
- settled decisions constrain later branches

The **frontier** is the set of material decisions whose prerequisites are already settled.

Ask currently answerable frontier decisions through the host Agent's interactive Ask tool when one is available. Do not ask a question whose answer depends on another still-open decision in the same frontier; leave it for a later round.

After the user answers, update the tree, preserve settled decisions, recompute the frontier, and continue.

For execution preflight, use the same dependency logic but keep the tree intentionally shallow: resolve only the material ambiguities that block or substantially change the current task, then resume execution.

## 6. Ask in the User's Language and Keep Questions Easy to Parse

Match the language the user is using unless they request otherwise.

Questions must be direct and concrete:

- prefer ordinary words over specialist terminology
- avoid dense compound nouns and jargon-heavy phrasing
- if a technical term is necessary, define it briefly the first time
- keep one underlying decision per question
- do not hide several unrelated decisions inside one long paragraph
- give concrete choices when the decision naturally has discrete options

Do not make later rounds harder to understand just because the design tree has become deeper.

### No decorative emoji

Do not add decorative emoji or pictograms to:

- question titles
- answer options
- recommendations
- checkpoints
- decision summaries
- fallback text questionnaires

Use an emoji only when the content itself requires it, such as discussing an emoji/icon choice or preserving literal user-provided content.

## 7. Every Material Question Gets a Recommendation

Each material question must include one clear recommended answer.

Recommendations should be decisive rather than neutral summaries. Base them on, in order:

1. already-settled user decisions
2. existing project/reference behavior
3. implementation cost and maintainability
4. factual research
5. general best practices only when the earlier signals do not decide the issue

If the user has already established a general policy that resolves the current branch, apply that policy instead of asking the same decision again in a narrower form.

## 8. Ask-Tool-First Interaction

This Skill is designed primarily for Agent clients with an interactive user-question tool.

When the host exposes an Ask / AskUserQuestion / equivalent tool, **use it instead of rendering a numbered questionnaire in ordinary chat text**.

### Adapt to the host tool schema

Do not hard-code one client's exact limits. Inspect or follow the available Ask tool schema and use its native interaction model.

Typical Ask tools support:

- several independent questions in one tool call
- single-select questions
- multi-select questions
- a user-provided custom/free-text answer path in the UI

Use those capabilities directly.

### Single-select by default

Use single-select when the user should choose one primary policy or behavior.

Provide concise, mutually distinct choices. Mark or describe the recommended option clearly enough that the user can recognize it without reading a long essay.

### Multi-select only when the decision is genuinely additive

Use multi-select only when several options may validly apply at the same time, for example selecting supported export formats or enabled capabilities.

Do **not** use multi-select merely to compress several unrelated decisions into one question. Separate unrelated decisions into separate Ask questions.

### Preserve the custom-answer path

When the host UI provides an automatic "Other", custom, or free-text answer field, rely on it for cases where the user's preferred answer is not one of the proposed choices.

Do not waste an explicit option slot on a fake "Other" choice when the host already provides a custom-answer path.

If the host requires an explicit custom option to enable free text, follow that schema.

### Fill the Ask call efficiently

When several frontier decisions are independent and the Ask tool supports several questions per invocation, put as many currently answerable questions into one Ask call as the tool comfortably supports.

Do not reduce an available multi-question Ask UI to one tool invocation per trivial question unless dependency ordering requires it.

If the frontier is larger than the host tool's capacity, ask up to the supported capacity, receive the answers, recompute the frontier, and continue with another Ask call.

### Recommendation placement

Use the host's available option label/description/help fields to surface the recommendation compactly.

Prefer plain forms such as:

- `B — Keep existing behavior (Recommended)`
- option description: `Recommended because this matches the current project architecture.`

Do not turn the Ask dialog into a wall of prose.

## 9. Ask the Whole Material Frontier, but Do Not Over-Grill

In explicit grilling, ask every currently answerable **material** decision, subject to the host Ask tool's per-call capacity.

In execution preflight, ask only material ambiguities that block the task or could substantially change the implementation/result.

Do not create questions for:

- facts you can determine yourself
- reversible implementation details already covered by project conventions
- cosmetic differences with no meaningful consequence unless the user cares about them
- hypothetical edge cases with little realistic impact
- decisions whose answers logically follow from an already-settled policy
- the same underlying issue reworded several ways

"Relentless" means no material branch is silently assumed during explicit grilling; it does not mean maximizing friction.

## 10. Text Fallback Only When No Ask Tool Exists

The chat-style numbered questionnaire is a fallback, not the primary interaction mode.

Use it only when the current host/client does not expose a usable interactive Ask tool.

In text fallback mode:

- number questions continuously across the session
- use compact A/B/C choices when appropriate
- include one recommended answer per question
- allow concise batch replies such as `Q12 B, Q13 按推荐` because they reduce conversational round trips in plain chat

Example fallback:

```text
Q12 — <short title>

<plain-language question>

A. <choice>
B. <choice>
C. <choice>

Recommended: B — <short reason>
```

Do not teach or request batch-answer syntax when an interactive Ask tool is available; the tool UI already solves that interaction problem more cleanly.

## 11. Preserve Settled Decisions and Detect Conflicts

Maintain a compact decision ledger throughout the session.

For each settled decision, preserve at least:

- question/decision identifier or semantic key
- selected answer or policy
- any important constraint introduced by the answer

Do not ask a settled question again unless:

- new evidence materially changes the decision
- a later answer conflicts with it
- the user explicitly reopens it

If a new answer conflicts with an earlier settled decision, do not silently overwrite history. Point out the conflict clearly and reopen the smallest affected branch.

## 12. Use Checkpoints in Long Explicit Grilling Sessions

Long grilling sessions are vulnerable to context compression and forgotten constraints.

When enough decisions have accumulated that losing them would be costly, surface a compact checkpoint containing:

- important settled policies
- explicitly rejected alternatives that could otherwise reappear
- unresolved decisions/fact dependencies

Do not dump a full transcript. Summarize decisions, not conversation history.

Do not interrupt a short execution preflight with checkpoint ceremony.

If the user asks to persist the checkpoint into files/docs and the required tools are available, do so. Otherwise keep the checkpoint in the conversation.

## 13. Research Can Run Alongside the Frontier

If one branch depends on research that is still unresolved, do not stall independent work unnecessarily.

Research the fact with available tools. Only decisions that depend on that fact need to wait.

Never pretend a fact is settled while research is incomplete.

## 14. Completion and Resume Behavior

### Explicit Grilling

The explicit grilling session is complete when:

- no unresolved material decision remains in the design tree
- no important assumption is still silently inferred
- factual dependencies that affect the design are resolved or explicitly marked unavailable
- earlier decisions are internally consistent

Then provide a concise final decision summary and state that the material frontier is empty.

Wait for the user's confirmation before acting, unless the user already explicitly instructed the Agent to transition directly into execution once grilling is complete.

If the user corrects the summary, reopen only the affected branches and continue grilling.

### Execution Preflight

The preflight is complete as soon as the material ambiguities that could materially change the current task are resolved.

Then resume the original requested task automatically:

1. incorporate the settled answers
2. write/update the plan if a plan is needed
3. execute the requested work

Do not add an extra confirmation round merely because the Skill was invoked.