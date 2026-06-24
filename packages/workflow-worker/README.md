# @sixb/workflow-worker

Sequential workflow runtime for Sixb.

`WorkflowWorker` consumes `workflow.run.requested` jobs from `queues.workflows`, executes registered
workflow nodes in order, writes `WorkflowRunStorage` records, requests action nodes through the
normal Sixb action path, and waits for terminal action events through `requestActionAndWait(...)`.

Workflows can pause at **intervention** nodes for human-in-the-loop decisions: the worker records a
pending intervention, moves the run to `waiting`, and stops. When an app submits a response, a
`workflow.run.resume.requested` job is enqueued and the worker resumes the run from where it paused.
Each run ends with a final `workflow.run.finished` event. Workers that register intervention nodes
require `storage.workflowInterventions`.

Execution is otherwise linear: V1 does not handle branching, parallel execution, nested workflows,
direct action handler execution inside the workflow worker, or trigger admission mapping.
