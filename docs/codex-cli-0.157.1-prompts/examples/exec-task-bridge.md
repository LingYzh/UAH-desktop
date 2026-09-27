# Delegated task

This is a user-level task template for an external caller launching a standalone
`codex exec` process. It is an authored integration example, not an upstream
Codex system prompt. Replace the fields before sending it as stdin.

Task: {{TASK}}
Context and prior decisions: {{TASK_CONTEXT}}
Working directory and allowed scope: {{WORK_SCOPE}}
Acceptance criteria: {{ACCEPTANCE_CRITERIA}}
Actions already authorized: {{AUTHORIZED_ACTIONS}}
Constraints and actions requiring a new decision: {{CONSTRAINTS}}

Complete the assigned task using the actual Codex tools and permissions available.
Treat this process as a standalone execution. The external caller will collect
stdout/events and the final result file; do not assume native parent-agent
messaging exists merely because this work was delegated.

Your final result should state the outcome, files or artifacts changed, checks
actually performed and their outcomes, and any remaining blockers or required
caller decisions. Do not report unperformed checks as passing. Follow any more
specific output schema provided by the caller.
