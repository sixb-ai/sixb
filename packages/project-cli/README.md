# `@sixb/project-cli`

Local project runtime, dev server, deployment, storage, and interactive terminal app (`sixb-project`) for Sixb projects.

Developers invoke these commands through `sixb` (`@sixb/cli`), which automatically delegates project commands to the repo's pinned `node_modules/.bin/sixb-project`:

- `sixb dev`, `sixb check`, `sixb typegen`, `sixb build`, `sixb run`
- `sixb serve <api|app|orchestrator|rules|worker|worker-group>`
- `sixb deploy`, `sixb env`, `sixb db`, `sixb lake`, `sixb desktop`, `sixb init`
- `sixb` (interactive TUI), `sixb agent`, `sixb connect`
