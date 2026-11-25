# Branch mode

A branch runs a git branch's code on a copy of what its creator reads in production. It may hold
anything that person can read, and it never reaches anything outside it: core refuses it, here,
whatever the project's code or configuration says.

## Entering it

The host says so, as it says `NODE_ENV`. `sixb dev --from production` sets both variables; a
project never does.

| Variable | Value |
|---|---|
| `SIXB_BRANCH` | The git branch's name, such as `feature/invoices` |
| `SIXB_BRANCH_DATA_FROM` | `production`, the only source a branch copies |

`SixbHost` reads them first thing in its constructor (`resolveBranchMode`), before any provider is
wrapped or any report is made. Code reads the result as `host.branch` or `sixb.branch`:
`{ name, dataFrom }`, or `null` in production and plain `sixb dev`.

Startup fails with a `[Sixb]` error when only one variable is set, when the name is not a git branch
name, or when `NODE_ENV=production`: production is never a branch, and a deployment that inherited
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
| Action effects skipped, recorded as `skipped` on the run, with a line in the run's logs | `runActionEffects` (`actions/run/effects.ts`) | Effects notify people; a branch sends nothing |
| Cron schedules off; `host.runSchedule(id)` runs one now | `SixbHost.startMaintenance` | Nothing starts on its own clock |
| Event schedules on | Orchestrator routes, untouched | Rule → workflow chains stay testable, inside the branch |
| Syncs off: a trigger's dispatch and a requested run are refused | `SyncRunDispatcher.dispatch`, `requestSyncRun` | Production's data reaches the branch through the copy. The orchestrator reports a refused trigger to `onError` once and drops it |
| Inbound webhooks refused before a run is admitted | `registerWebhookRoutes` (server) | Providers call production |
| Directory checks off, and refused when called | `SixbHost.directoryPasses`, `AuthRuntime.checkDirectory` | They suspend people |
| No invitation and no sign-in link emailed | `withoutEmails` in `auth/runtime.ts` | A branch's members are production's people |
| Lake retention off, and refused when called; a dry run still answers | `LakeRetention` (`maintenance/lake-retention.ts`) | It deletes files, and a branch's lake reads production's |
| The projections pass recovers no dataset | `recoveryPasses` (`maintenance/passes/recovery-passes.ts`) | Its first pass would re-derive every projection from production's data and re-create every object. The live `dataset.version.committed` path still projects what the branch commits |
| Agent turns and agent steps on | Nothing to gate | A model call writes nothing to production. Their actions and tools hit the gates above |

## Keeping to itself

- `onError` contexts carry `branch`, the branch's name (`SixbErrorReporter`).
- The broker and the queues get a transport id, `<project>--branch-<slug>-<hash>`, instead of the
  project id (`transport.ts`), so on infrastructure shared with production, plain `sixb dev` or
  another branch, no consumer reads what the branch publishes or enqueues. Storage and events keep
  the project id: a branch's storage is its own namespace already.
- Projection run ids hash the branch's name (`createProjectionRunId`). Production's ids are
  unchanged.

## What core cannot see

Code that reaches outside without a connector, such as `fetch` or an SDK built from an environment
variable, is invisible to core. A branch runs with the project's `dev` values, which must never be
production credentials: that rule, not a gate, covers it.
