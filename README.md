<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/brand/sixb-wordmark-white.svg">
  <img alt="Sixb" src="./docs/brand/sixb-wordmark-black.svg" width="320">
</picture>

Sixb: For something between [Palantir Foundry](https://www.palantir.com/platforms/foundry/)
and [Mastra](https://mastra.ai/).

<h3>

[Documentation](https://docs.sixb.ai) | [Examples](https://docs.sixb.ai/examples) | [Contributing](./CONTRIBUTING.md)

</h3>

[![CI](https://github.com/sixb-ai/sixb/actions/workflows/ci.yml/badge.svg)](https://github.com/sixb-ai/sixb/actions/workflows/ci.yml)
[![Docs](https://github.com/sixb-ai/sixb/actions/workflows/docs.yml/badge.svg)](https://github.com/sixb-ai/sixb/actions/workflows/docs.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)
[![License](https://img.shields.io/badge/license-MIT-black)](./LICENSE)

</div>

---

## What is Sixb?

Sixb gives operational systems a shared backbone:

- **Ontology** — typed objects, links, properties, telemetry, and value types.
- **Actions** — commands that people, apps, and agents can request.
- **Data** — connectors, datasets, syncs, pipelines, and projections.
- **Runtime** — functions, schedules, workflows, rules, events, and authorization.
- **Interfaces** — HTTP/WebSocket API, generated client, Atlas UI, and custom React apps.

Everything starts with `createSixb()`. It discovers your project folders and gives you a
typed runtime API like `sixb.objects(Invoice)`.

## Quick start

Install [Bun](https://bun.sh), then run the Acme example:

```bash
git clone https://github.com/sixb-ai/sixb.git
cd sixb
bun install
bun --filter @sixb/example-acme-corp dev
```

Open:

- Atlas: `http://localhost:3000`
- App: `http://localhost:3001`
- API docs: `http://localhost:3002/docs`

## Learn

- [Get started](https://docs.sixb.ai)
- [Project structure](https://docs.sixb.ai/fundamentals/project-structure)
- [Ontology](https://docs.sixb.ai/ontology)
- [Objects](https://docs.sixb.ai/objects)
- [Actions](https://docs.sixb.ai/actions)
- [Data integrations](https://docs.sixb.ai/data)
- [Apps](https://docs.sixb.ai/apps)
- [Deployment](https://docs.sixb.ai/deployment)

## Develop this repo

```bash
bun run build
bun run typecheck
bun run test
bun run check
```

Bun is the only package manager and runtime used by this repository.

## Repo map

- `packages/core` — runtime, ontology builders, providers, validation, and functions
- `packages/server` — HTTP/WebSocket API and OpenAPI generation
- `packages/atlas` — built-in React UI
- `packages/client` — generated typed client
- `packages/cli` — `sixb` and `create-sixb`
- `docs/` — documentation source, hosted at [docs.sixb.ai](https://docs.sixb.ai)
- `examples/` — runnable sample projects

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and keep changes
small, typed, tested, and readable.
