# `@sixb/cli`

The single, zero-dependency `sixb` CLI used identically by people, CI, and agents.

## Design

- **One CLI, zero modes:** Every caller uses the exact same commands, transport, and error contract. Server grants, run-token policies, and approval gates enforce authorization.
- **One connection chain:** `--api-url` / `--profile` / `--token` flags, then `SIXB_API_URL` (supporting `http(s)://` and `unix:/path.sock`) + `SIXB_API_TOKEN` + `SIXB_RUN_ID`, then saved profiles in `~/.config/sixb/config.json`.
- **Automatic TTY / JSON output:** Non-TTY stdout (pipes, CI, sandboxes), `--json`, and `SIXB_OUTPUT=json` emit strict JSON. Interactive terminals render compact plain-text tables and summaries.
- **Project delegation:** Project-local commands (`dev`, `serve`, `check`, `typegen`, `build`, `run`, `env`, `deploy`, `desktop`, `db`, `lake`, `init`, `agent`, `connect`) delegate cleanly to `@sixb/project-cli` (`sixb-project`) at the version the repo pins.

## Install

```bash
bun add --global @sixb/cli
```

## Development

```bash
bun --filter @sixb/cli typecheck
bun --filter @sixb/cli test
bun --filter @sixb/cli build
bun run generate:cli
```
