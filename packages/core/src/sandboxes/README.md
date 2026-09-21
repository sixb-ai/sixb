# Sandboxes

The factory defines an environment; a thread stores its parameters; a run supplies execution
authority. Sandbox configuration is registered by the host, not ontology discovery.

## Configuration and validation

- `SandboxConfig` combines the common environment contract with optional `params` and `resolve`.
  Static `source`/`setup` and a resolver are mutually exclusive; `env`/`network` can be defaults.
- Registration validates and snapshots declarative data and captures the resolver. Parameters
  reuse Action schemas; object references validate identity, not authorization.
- Each resolution validates parameters, restores typed values (including dates), and receives
  the execution-scoped SDK. Returned environments are validated and copied; resolved environment
  variables override defaults. Errors must never expose configuration values.
- Source describes initial project contents, not a runtime image or saved snapshot. The common
  contract accepts credential-free HTTPS Git sources; omitting source gives a blank environment.
  Native Vercel archives and clone credentials are low-level options, not managed thread sources.

## Thread binding

- Public `thread.sandbox` contains only validated application parameters. Storage calls the
  column `sandbox_params`: JSONB in PostgreSQL, JSON text in SQLite, constrained to an object.
  Resolved environments and credentials are not persisted there.
- Omitted binding keeps ephemeral behavior; `{}` explicitly binds a static environment.
  Bindings are immutable and follow the thread's owner visibility rules.
- Creating a binding neither resolves the environment nor provisions compute. Admission requires
  a registered definition and a provider implementing `resume`. The SDK receives both as one
  internal dependency (`definition`, `supportsPersistence`).

## Execution boundary

This configuration slice does not execute persistent threads. Requests and retries reject bound
threads with `sandbox_execution_unavailable` (HTTP 409) before writing messages or runs; the
worker also rejects previously queued bound runs before starting compute.

The lifecycle slice must resolve with current authority on every run, including resume, initialize
only fresh environments, and save before releasing a run. Git authentication belongs to the access
slice and must be renewed before source preparation; guest-readable `env` is not its credential
channel. Workflows and child agents remain ephemeral.
