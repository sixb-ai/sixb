# Northline Mechanical

Northline Mechanical is a fictional regional commercial building-services company. **Northline
Operations** connects its business system, field-service platform, and building controls around one
unit of work: restoring customer equipment to reliable operation. This example is Sixb's canonical
reference application.

## Start

From the repository root:

```bash
bun install
bun --filter @sixb/example-northline dev
```

The first start creates deterministic source files and populates Sixb through the real sync,
dataset, pipeline, and projection path. The operations app and data plane do not require external
credentials.

- Northline Operations: <http://localhost:3001>
- Atlas: <http://localhost:3000>
- API documentation: <http://localhost:3002/docs>

### Optional Operations Assistant

The button at the bottom-right opens an embedded agent panel with the current route and detail
object attached as context. Agent turns use Vercel AI Gateway and require its optional key:

```bash
AI_GATEWAY_API_KEY=your_key bun --filter @sixb/example-northline dev
```

Without `AI_GATEWAY_API_KEY`, Northline still starts, syncs, and runs normally; only model-backed
assistant turns are unavailable. Agent commands run through the local sandbox provider.

## Golden scenario

Open service case **SC-1042**.

Harbor Foods Group's Newark Distribution Center has an active alarm on rooftop unit RTU-7. The
PriorityCare 24/7 contract requires a response within 90 minutes. From Northline Operations you can:

1. Acknowledge the service case.
2. Review and approve the deterministic dispatch recommendation.
3. Open Elena Park's technician workspace and start the visit.
4. Record the failed variable-frequency-drive diagnosis.
5. Approve the repair quote for customer authorization.
6. Complete field work, verify telemetry recovery, and close the case.

The same objects, links, action runs, rule state, workflow runs, datasets, and projections remain
inspectable in Atlas.

## Demo commands

Run these from `examples/northline` or through Bun's workspace filter:

```bash
bun run demo:reset          # recreate source and runtime state
bun run demo:sync           # reconcile every source through the data plane
bun run demo:alarm          # deliver the signed RTU-7 alarm webhook
bun run demo:approve-quote  # approve a pending source-system quote
```

Mutable source state lives under `.sixb/demo-sources/` and survives ordinary restarts. Only
`demo:reset` replaces it.

## Source ownership

| System | Owns |
| --- | --- |
| Business system | Customers, facilities, contracts, quotes |
| Field service | Technicians, work orders, visits, field notes |
| Building controls | Equipment, readings, alarms |
| Northline Operations | Cross-system service cases and operational decisions |

The local implementations are typed, validated, atomic file-backed clients. Connectors, syncs,
actions, workflows, and the app use those clients rather than importing fixtures. The data plane
uses a local DuckDB catalog and local DuckLake storage; its pipeline transformations execute as
DuckDB SQL rather than row-by-row TypeScript.

## Read the code in this order

Follow one connected path rather than browsing by feature:

1. [`sixb.config.ts`](./sixb.config.ts)
2. [`ontology/equipment.ts`](./ontology/equipment.ts)
3. [`ontology/service-case.ts`](./ontology/service-case.ts)
4. [`lib/sources/building-controls-client.ts`](./lib/sources/building-controls-client.ts)
5. [`connectors/building-controls.ts`](./connectors/building-controls.ts)
6. [`syncs/building-controls.ts`](./syncs/building-controls.ts)
7. [`pipelines/controls.ts`](./pipelines/controls.ts)
8. [`projections/building-controls.ts`](./projections/building-controls.ts)
9. [`actions/recordBuildingAlarm.ts`](./actions/recordBuildingAlarm.ts)
10. [`actions/dispatchWorkOrder.ts`](./actions/dispatchWorkOrder.ts)
11. [`rules/service-operations.ts`](./rules/service-operations.ts)
12. [`workflows/service-response.ts`](./workflows/service-response.ts)
13. [`agents/operations-assistant.ts`](./agents/operations-assistant.ts)
14. [`app/_components/operations-assistant.tsx`](./app/_components/operations-assistant.tsx)
15. [`app/service-cases/[id]/page.tsx`](./app/service-cases/%5Bid%5D/page.tsx)
16. [`tests/scenario.test.ts`](./tests/scenario.test.ts)

## Why the example is deliberately bounded

Northline demonstrates connected business behavior, not every Sixb capability. It intentionally
omits authentication, accounting, inventory, maps, and route optimization so the primary
integration and operational patterns remain easy to understand and copy.
