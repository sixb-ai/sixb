# Manual Install

Add Sixb to an existing Bun and TypeScript project. For a new project, use the
[quickstart](../README.md).

## Install Sixb

Use Bun **1.4.2 or later** and install the runtime and CLI:

```bash
bun add @sixb/core @sixb/cli
```

## Define your first object

Create an object type in `ontology/`. Sixb loads it automatically when the project starts.
This example defines a task with an ID and title.

File: `ontology/task.ts`

```ts
import { defineObjectType, prop } from "@sixb/core/ontology"

export const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
  ],
})
```

## Configure your project

Create `sixb.config.ts` at your project root. This local configuration needs no database setup
or additional provider packages.

File: `sixb.config.ts`

```ts
import {
  createSixb,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
} from "@sixb/core"

export const sixb = createSixb({
  id: "my-app",
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})
```

Data is held in memory and resets when the process restarts. Choose
[persistent storage providers](../infrastructure/overview.md) when you need to keep it.

## Start development

Run this from your project root:

```bash
bun sixb dev
```

Open [Atlas](http://localhost:3000) to explore your model, or the
[API documentation](http://localhost:3002/docs) to see its endpoints.

To add a React interface, see [Building apps](../apps/overview.md).
