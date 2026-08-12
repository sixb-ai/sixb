import type { OntologySource, Sixb, SixbHostView } from "../src"

declare const sixb: Sixb<readonly OntologySource[]>
declare const host: SixbHostView

// The host owns validated definitions and process lifecycle, not domain operations.
void host.definitions.actions.list()
void host.definitions.workflows.list()
void host.definitions.connectors.list()
void host.definitions.ontology.listObjectTypes()
void host.blobStorage.stat("blob-id")
void host.logging.startExecution({ kind: "action", id: "run-id" })
void host.scheduler.start()
void host.closeConnectors()
void host.closeBlobs()
// @ts-expect-error Bind an execution before requesting an action.
void host.actions
// @ts-expect-error Bind an execution before accessing objects.
void host.objects
// @ts-expect-error Bind an execution before resolving a connector client.
void host.connector
// @ts-expect-error Connector definitions live under host.definitions.
void host.connectors
// @ts-expect-error The host exposes the configured provider as blobStorage.
void host.blobs

void sixb.objects.list({})
void sixb.actions.list()
void sixb.workflows.list()
void sixb.agents.list()
void sixb.datasets.list()
void sixb.syncs.list()
void sixb.pipelines.list()
void sixb.schedules.list()
void sixb.rules.list()
void sixb.projections.list()
void sixb.events.read()
void sixb.connector
void sixb.blobs.stat("blob-id")

// Primitive operations belong to their domain facade; the runtime root has no compatibility API.
// @ts-expect-error Use sixb.objects.list(...).
void sixb.listObjects({})
// @ts-expect-error Use sixb.actions.list().
void sixb.listActions()
// @ts-expect-error Use sixb.workflows.requestById(...).
void sixb.requestWorkflowRun({ workflowId: "workflow-id" })
// @ts-expect-error Connector definitions belong to host.definitions; execution only resolves one.
void sixb.connectors
// @ts-expect-error Connector lifecycle belongs to host.closeConnectors().
void sixb.disconnectConnectors()
// @ts-expect-error Use sixb.blobs.
void sixb.blobStorage
// @ts-expect-error Use sixb.schedules.list().
void sixb.listSchedules()
// @ts-expect-error Scheduler lifecycle belongs to host.scheduler.start().
void sixb.startScheduler()
// @ts-expect-error Use sixb.rules.list().
void sixb.listRules()
// @ts-expect-error Use sixb.projections.list().
void sixb.listObjectProjections()
