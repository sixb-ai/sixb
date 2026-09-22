# Sandboxes

Factories define environments; threads retain immutable parameters; runs provide current authority.

- `create()` applies static source/setup. An explicit `environment` replaces both, including `{}`.
  Dynamic recipes require an execution-resolved environment; providers never invoke resolvers.
- Selection and validation happen before provisioning. Initial source access must be allowed by
  the session network policy. Creation runs setup once; resume never replays it.
- Runs without a thread binding explicitly select `{}`; shared env/network defaults remain session
  settings, not an implicit project binding. Unsupported provider capabilities fail explicitly.

- [Configuration](./configuration.ts) validates and snapshots recipes, sharing Action parameter
  schemas. Resolvers receive the execution-scoped SDK. Only parameters are stored in `sandbox_params`.
- [Initialization](./environment.ts) runs once, after session settings are applied. Git uses
  `repository/`; source-free environments use the provider root. Vercel skips native cloning on this
  path to avoid preparing the source twice. Confirmed loss uses a fresh name and replays setup.
- Threads expose immutable `sandboxParams` and worker-owned `sandboxState`; its `name` is the
  provider's exact persistent name, also checked during transitions and explicit recreation.
- The conversation environment owns acquisition and preservation, including preparation failures.
  It resolves access before compaction, drains operations, cleans transient files and confirms
  preservation before the worker finalizes. Source identity/revision cannot change on resume.
- Git checkouts exclude `.sixb/agent/` locally before run files are written. Tracked runtime files,
  redirected metadata and repository rules overriding this exclusion block acquisition or saving.
  This prevents accidental staging, not deliberate publication with `git add -f`.
- Confirmed missing/expired state allows one replacement attempt under the current execution fence.
  A durable reset timestamp informs subsequent model calls; conversation history is preserved.
- Omitted network policy permits API/source access. Explicit policies are never widened; incompatible
  policies fail before provisioning. Guest-readable `env` is not a Git credential channel.

## V1 limits

Vercel requests can outlive their worker: storage fencing cannot cancel provider-side work.
Uncertain sandboxes stay blocked; explicit recreation uses a new name without deleting old state.
Saved files remain subject to provider retention.

Source `auth` stays host-side. Named providers advertising `supportsRequestCredentials` must apply
initial credentials before setup and expose session-scoped renewal. Unsupported providers reject
credentials before provisioning. During initial provisioning/setup, the worker aborts before token
expiry if no session handle is available yet; renewal begins after acquisition. Normal teardown
removes injection and revokes grants. A crash cannot guarantee immediate revocation.
