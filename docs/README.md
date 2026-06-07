# Get Started

Sixb is a TypeScript framework for building operational software around real-world systems.

Use it to model your domain, sync live data, and ship workflows, APIs, and apps from one
shared runtime.

## Quickstart

- [Ontology](./concepts/ontology.md)
- [Object Query](./concepts/object-query.md)
- [Dataset](./concepts/datasets.md)
- [Pipeline](./concepts/pipeline.md)
- [Projection](./concepts/projection.md)
- [Connector](./concepts/connector.md)
- [Sync](./concepts/sync.md)
- [Rules](./concepts/rules.md)
- [Workflow](./concepts/workflows.md)

```bash
bun create-sixb my-sixb-app
cd my-sixb-app
bun install
bun run dev
```

Then open the local development UI:

```txt
http://localhost:3000
```

The starter project runs locally and gives you a small working app to edit.

## What gets created

```txt
my-sixb-app/
  ontology/
    counter.ts
  actions/
    reset.ts
  functions/
    tick.ts
  app/
    page.tsx
  sixb.config.ts
```

The default project is small on purpose.

| File or folder | What it is for |
| --- | --- |
| `sixb.config.ts` | Creates the Sixb runtime |
| `ontology/` | Defines the objects in your domain |
| `actions/` | Defines commands users or systems can request |
| `functions/` | Runs scheduled or reactive logic |
| `app/` | Contains the custom app UI |

## How Sixb projects work

A Sixb project is built from a few simple pieces:

- define your domain with an [ontology](./concepts/ontology.md)
- connect to external systems with [connectors](./concepts/connector.md)
- write external data into [datasets](./concepts/datasets.md)
- move data with [syncs](./concepts/sync.md)
- clean or reshape data with [pipelines](./concepts/pipeline.md)
- turn rows into app objects with [projections](./concepts/projection.md)
- run business logic with [rules](./concepts/rules.md) and [workflows](./concepts/workflows.md)

You do not need all of these on day one. Start with the pieces your app needs.

## Next steps

- Read [Ontology](./concepts/ontology.md) to understand how domain objects are modeled.
- Read [Connector](./concepts/connector.md) when you are ready to connect an external system.
- Read [Sync](./concepts/sync.md) when you want to move data into Sixb.
