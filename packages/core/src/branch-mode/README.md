# Branch mode

A branch runs a git branch's code on a copy of what its creator reads in production. It may hold
anything that person can read, and it reaches nothing outside it through Sixb: connectors,
writebacks, effects, syncs, webhooks, emails, cron and directory checks are refused
here, in core, and the project's configuration cannot turn that off. What the project's code
reaches on its own is out of core's sight (see the last section).

## Entering it

The host says so, as it says `NODE_ENV`. `sixb dev --from production` sets both variables; a
project never does.

| Variable | Value |
|---|---|
| `SIXB_BRANCH` | The git branch's name, such as `feature/invoices` |
| `SIXB_BRANCH_DATA_FROM` | `production`, the only source a branch copies |
| `SIXB_BRANCH_RUNTIME` | Optional: who runs it, such as a checkout's id. Its broker streams and queue lanes go by it with the name, so two runtimes of one git branch never share a job |

`mode.ts` captures them once, when core is first evaluated. Core is imported before the body of
`sixb.config.ts` runs, so a project that deletes or changes them afterwards changes nothing.
`SixbHost` resolves the captured values first thing in its constructor (`resolveHostBranch`),
before any provider is wrapped or any report is made. Code reads the result as `host.branch` or
`sixb.branch`: `{ name, dataFrom }`, or `null` in production and plain `sixb dev`.

The CLI checks the other way round: every command loads the project through `loadSixbFromEntry`,
which reads `SIXB_BRANCH` before the project's code runs and refuses to start a host that does not
run as that branch, such as one the project wrapped or built around the variables.

`putOnBranch(options, branch)` puts a host on a branch through its options, for this repo's tests,
which cannot set the variables before core loads. It can only add a branch: a host the environment
put on one stays on it.

Startup fails with a `[Sixb]` error when only one variable is set, when the name is not a git branch
name, or when `NODE_ENV=production`, set before core loads or after: production is never a branch, and a deployment that inherited
the variables must stop rather than run with its gates on.

An environment variable, not a `createSixb` option: the project's `sixb.config.ts` calls
`createSixb`, and a project must not be able to turn the gates off. Every process of a branch
(the API, the orchestrator, each worker) builds its own host from the same environment, so they all
agree without passing anything.

## The gates

Every gate answers with a `branch.refused` error, `[Sixb] Branch "<name>": …`, saying what and what
to do instead (`refusals.ts`). Nothing turned off is a silent no-op. The HTTP API answers it with
409.

| On a branch | Where | Why |
|---|---|---|
| Every connector client refused: static clients, OAuth connection clients, their tokens and token refreshes | `ConnectorService` (`connectors/service.ts`) | Every client is made there, whoever asks: an action's writeback or effects, a sync, a workflow step, a webhook handler, an agent tool, a sandbox's source token. One place refuses them all |
| Connecting, reauthorizing, disconnecting and revoking OAuth connections refused; listing stays | `refuseConnectionChanges` in `connectors/service.ts` | Connections belong to production |
| An action with a writeback fails before its writeback runs, recorded as a failed writeback | `runWritebackPhase` (`actions/run/writeback.ts`) | The writeback writes outside Sixb, and the edits depend on its reply |
| Action effects skipped, recorded as `skipped` on the run | `runActionEffects` (`actions/run/effects.ts`) | Effects notify people; a branch sends nothing |
| Cron schedules off, with a startup notice; `sixb schedules run <id>` (`POST /api/schedules/:scheduleId/runs`, `sixb.schedules.run`) runs one now, and refuses one that starts a sync | `SixbHost.startMaintenance`, `SchedulesRuntime.run` | Nothing starts on its own clock. A sync's dispatch would refuse it only after the run was accepted, out of the caller's sight |
| Event schedules on | Orchestrator routes, untouched | Rule → workflow chains stay testable, inside the branch |
| Syncs off: a trigger's dispatch and a requested run are refused | `SyncRunDispatcher.dispatch`, `requestSyncRun` | Production's data reaches the branch through the copy. The orchestrator reports a refused trigger to `onError` once and drops it |
| Inbound webhooks refused before a run is admitted | `registerWebhookRoutes` (server) | Providers call production |
| Directory checks off, and refused when called | `SixbHost.directoryPasses`, `AuthRuntime.checkDirectory` | They suspend people |
| No invitation and no sign-in link emailed | `withoutEmails` in `auth/runtime.ts` | A branch's members are production's people |
| The projections pass recovers nothing when the branch's lake is no fork of production's | `recoveryPasses` (`maintenance/passes/recovery-passes.ts`) | That lake cannot tell the branch's versions from the ones the copy was derived from: a first pass would re-derive every projection and re-create every object. A forked lake tells them apart itself (`LakeFork.ownsVersion`). The live `dataset.version.committed` path still projects what the branch commits |
| Agent turns and agent steps on | Nothing to gate | A model call writes nothing to production. Their actions, connectors and sandbox tokens hit the gates above; their web tools do not (below) |

## Keeping to itself

- `onError` contexts carry `branch`, the branch's name (`SixbErrorReporter`).
- The broker and the queues get a transport id, `<project>--branch-<slug>-<hash>`, instead of the
  project id (`transport.ts`), so on infrastructure shared with production, plain `sixb dev` or
  another branch, no consumer reads what the branch publishes or enqueues. Storage and events keep
  the project id: a branch's storage is its own namespace already.
- Projection run ids hash the branch's name (`createProjectionRunId`). Production's ids are
  unchanged.

## What core cannot see

- Code that reaches outside without a connector, such as `fetch` or an SDK built from an
  environment variable, is invisible to core. A branch runs with the project's `dev` values, which
  must never be production credentials: that rule, not a gate, covers it.
- The Agent's `web_search` and `web_fetch` reach the web ungated on a branch. They read, through
  the AI Gateway, but a fetched URL can still carry what the Agent puts in it.
