# Project Structure

A Sixb project has one configuration file and folders for its definitions. Sixb automatically loads
the definitions you export from their matching folders.

## Explore a project

Explore a project based on the [Sixb starter](../README.md). Select a file to see how the pieces
fit together.

<div data-project-explorer></div>

## Files and folders

| Path | Purpose |
| --- | --- |
| [`sixb.config.ts`](../runtime/overview.md) | Project configuration and providers, exported as `sixb` |
| [`ontology/`](../ontology/overview.md) | Your domain's types, properties, and relationships |
| [`connectors/`](../connectors/overview.md) | Access to external APIs, databases, and services |
| [`datasets/`](../datasets/overview.md) | The structure of your source and prepared data |
| [`syncs/`](../syncs/overview.md) | Importing data from connectors into datasets |
| [`pipelines/`](../pipelines/overview.md) | Cleaning and combining datasets |
| [`projections/`](../projections/overview.md) | Mapping dataset rows to your domain model |
| [`actions/`](../actions/overview.md) | Operations that change your domain's state |
| [`workflows/`](../workflows/overview.md) | Processes with multiple steps |
| [`rules/`](../rules/overview.md) | Conditions that signal when objects need attention |
| [`schedules/`](../schedules/overview.md) | Timer and event triggers for background work |
| [`security/`](../auth/authorization.md) | Access control in `groups/`, `roles/`, and `policies/` |
| [`shares/`](../auth/shared-access.md) | Permissions that can be granted through a share link |
| [`app/`](../apps/overview.md) | React pages and layouts, with their own routing conventions |
| [`skills/`](../models/tools-and-authorization.md#add-a-skill) | Agent instructions in `<name>/SKILL.md` and supporting resources |
| `lib/` | Shared helpers imported by your project |

## How files are loaded

- Export backend definitions from their matching folders.
- File names are up to you. Sixb also loads definitions from subfolders.
- The starter creates only the folders it needs. Add optional folders as your project grows.
- Keep tests and standalone scripts outside definition folders, since Sixb imports their modules.

See [Organizing your project](organizing-your-project.md) for examples of grouping related files.
