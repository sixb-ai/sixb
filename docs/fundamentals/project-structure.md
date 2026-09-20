# Project Structure

A Sixb project has one configuration file and folders for its definitions. Export a definition
from the matching folder and Sixb loads it automatically; no central registration file is needed.

## Explore a project

Browse an example based on the [starter project](../README.md). Select a file to read its code. The CelesTrak client is separated into `lib/` to keep the connector declaration easy to read.
The example follows one path: connector → sync → dataset → projection → object → app.

<div data-project-explorer></div>

The starter only creates the folders it needs. Add the other folders below as your app grows.

## Discovered folders

Each folder contains one kind of definition. `skills/` holds instructions and resources for the
Agent; `app/` holds the React interface and follows its own routing conventions.

| Folder | Holds | Related page |
| --- | --- | --- |
| `ontology/` | Object types and value types | [Ontology](../ontology/overview.md) |
| `actions/` | Action definitions | [Actions](../actions/overview.md) |
| `datasets/` | Dataset definitions | [Datasets](../datasets/overview.md) |
| `connectors/` | Connector definitions | [Connectors](../connectors/overview.md) |
| `syncs/` | Sync definitions | [Syncs](../syncs/overview.md) |
| `projections/` | Object, link, and telemetry projections | [Projections](../projections/overview.md) |
| `schedules/` | Schedule definitions | [Schedules](../schedules/overview.md) |
| `pipelines/` | Pipeline definitions | [Pipelines](../pipelines/overview.md) |
| `rules/` | Rule definitions | [Rules](../rules/overview.md) |
| `workflows/` | Workflow definitions | [Workflows](../workflows/overview.md) |
| `skills/` | Agent Skills (`<name>/SKILL.md` plus references/assets/scripts) read by the agent worker | [Tools and Authorization](../models/tools-and-authorization.md) |
| `security/groups/` | Group definitions | [Authorization](../auth/authorization.md) |
| `security/roles/` | Role definitions | [Authorization](../auth/authorization.md) |
| `security/policies/` | Membership-policy definitions | [Authorization](../auth/authorization.md) |

## Discovery rules

- Export definitions from the matching folder. File names and nesting are up to you.
- Subfolders are scanned recursively. One file may export several definitions or an array of them.
- Sixb loads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` modules. Avoid import-time side effects.
- Keep tests and scripts outside definition folders. An `_` prefix does not exclude backend files.
- Moving a file does not change its definition ID; update any imports of the old path.
- Optional folders can be absent. Your project needs at least one object type in `ontology/`.

## The entry file

`sixb.config.ts` exports your project configuration as `sixb`. The CLI loads it on startup.
Configure storage, messaging, authentication, and models here; see [Runtime](../runtime/overview.md).

For tests or programmatic setups, definitions can also be passed as arrays to `createSixb()`:
`ontologies`, `actions`, `datasets`, `connectors`, `syncs`, `pipelines`, `projections`, `schedules`,
`rules`, `workflows`, `groups`, `roles`, and `membershipPolicies`. Duplicate IDs are rejected.

## app/ is not discovered

The `app/` folder holds your custom UI and is **not** part of `createSixb()` discovery.
`@sixb/app` (`createCustomApp`) builds and serves it separately, so nothing in `app/` is
treated as a backend definition. Route conventions and data access for `app/` are documented
under [Apps](../apps/overview.md).

## Related

- [Organizing your project](organizing-your-project.md) — adaptable examples for grouping definitions
  and growing a project's structure.
- [Get started](../README.md) — scaffold and run a project end to end.
- [Manual install](manual-install.md) — set up the folders by hand.
- [Runtime](../runtime/overview.md) — what `createSixb()` accepts and returns.
