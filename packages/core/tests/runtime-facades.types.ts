import type { OntologySource, Sixb } from "../src"

declare const sixb: Sixb<readonly OntologySource[]>

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
void sixb.connectors.list()
void sixb.blobs.stat("blob-id")

// Primitive operations belong to their domain facade; the runtime root has no compatibility API.
// @ts-expect-error Use sixb.objects.list(...).
void sixb.listObjects({})
// @ts-expect-error Use sixb.actions.list().
void sixb.listActions()
// @ts-expect-error Use sixb.workflows.requestById(...).
void sixb.requestWorkflowRun({ workflowId: "workflow-id" })
// @ts-expect-error Use sixb.connector(...).
void sixb.connectors.connect
// @ts-expect-error Use sixb.connectors.disconnectAll().
void sixb.disconnectConnectors()
// @ts-expect-error Use sixb.blobs.
void sixb.blobStorage
// @ts-expect-error Use sixb.schedules.list().
void sixb.listSchedules()
// @ts-expect-error Use sixb.schedules.start().
void sixb.startScheduler()
// @ts-expect-error Use sixb.rules.list().
void sixb.listRules()
// @ts-expect-error Use sixb.projections.list().
void sixb.listObjectProjections()
