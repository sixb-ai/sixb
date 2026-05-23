# @sixb/workflow-worker

Sequential workflow runtime for Sixb.

`WorkflowWorker` consumes `workflow.run.requested` jobs from `queues.workflows`, executes registered
workflow nodes in order, writes `WorkflowRunStorage` records, requests action nodes through the
normal Sixb action path, waits for terminal action events through `requestActionAndWait(...)`, and emits one final `workflow.run.finished` event.

V1 is intentionally linear. It does not handle branching, parallel execution, nested workflows, suspension, direct action handler execution inside the workflow worker, or trigger admission mapping.
