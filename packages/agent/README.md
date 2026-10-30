# @sixb/agent

The Sixb agent harness: the prompt, the model loop and the tools of every agent run, the same code
whichever runner runs it. A runner claims a run, opens its session and its environment, and hands
both to the harness.

```text
runner (the cloud worker today)          harness (@sixb/agent)
claims the run → AgentRunSession         builds the prompt and tools, runs the loop, finishes
opens its environment → openSandbox      bash · read · view_file · publish_artifact · children
```

```text
runAgentTurn                 a conversation turn
runSubagent                  a child agent's run
runWorkflowAgentNode         a workflow agent step: the loop, then the structured finalizer
create*AgentEnvironment      the run's prompt, tools and files, in the environment its runner opens
SubagentCoordinator          spawn_agent, wait_agent, message_agent, and the children's questions
```

A run reaches shared state only through its session (see
[run sessions](../core/src/agents/README.md)): this package never reads storage, a queue or the
broker. The one exception is `publish_artifact`, which writes artifact versions through the
storage its runner passes as `artifactPublishing`, until artifacts publish through the API.

The environment is a `RunSandbox` ([run-sandbox.ts](./src/run-sandbox.ts)) that the runner opens
through `openSandbox`: the cloud worker opens a sandbox from its factory, with the run's token
added outside it. The harness installs the run's files under its context directory and the `sixb`
CLI the run's commands call.

How the agent uses its sandbox, its children and their questions: [runtime design](./docs/runtime-design.md).

The harness runs on Bun.
