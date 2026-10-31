# Sandboxes

Factories define environments; threads retain immutable parameters; runs provide current authority.

- `create()` applies static source/setup. An explicit `environment` replaces both, including `{}`.
  Dynamic recipes require an execution-resolved environment; providers never invoke resolvers.
- Selection and validation happen before provisioning. Initial source access must be allowed by
  the session network policy. Creation runs setup once; resume never replays it.
- One rule decides whether an agent can run in a factory's sandboxes (`sandboxCredentialIssue` in
  [configuration](./configuration.ts)): the provider must have `supportsRequestCredentials`, since
  the run's token is one of the credentials, and write access needs `auth`. `SixbHost` applies it
  to the factory and its static recipe at construction. The worker applies it again to each recipe a run
  resolves: `resolve` results are unknown at startup, and a worker host is structural.
- Runs without a thread binding explicitly select `{}`; shared env/network defaults remain session
  settings, not an implicit project binding. Unsupported provider capabilities fail explicitly.
- The exception is a workflow step's own `sandbox`: its factory's static recipe (source, setup,
  env, network, auth) applies to a fresh ephemeral sandbox per node run. `params`/`resolve`, a
  `none` network and source access that fails `sandboxCredentialIssue` are rejected when the step
  is defined and again at startup. Before the node's terminal write, also when provisioning
  fails, is cancelled or times out, the worker waits for one attempt to remove injection and
  revoke every grant, and destroys the sandbox only after it. A refused revocation is logged and
  does not fail the node: that grant stays valid until it expires. A lost execution records
  nothing, and its failed acquisition or its release still revokes.

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
- Sixb always adds the API, source and auth request origins to a run's network: an omitted policy
  allows only those, a restricted one lists what the project adds. `none` fails before
  provisioning. Guest-readable `env` is not a Git credential channel.
- Request origins are read from the first grant, so renewals must keep to the same origins: a
  provider rejects a credential for an origin the network does not allow.

## V1 limits

Vercel requests can outlive their worker: storage fencing cannot cancel provider-side work.
Uncertain sandboxes stay blocked; explicit recreation uses a new name without deleting old state.
Saved files remain subject to provider retention.

Source `auth` stays host-side. Providers advertising `supportsRequestCredentials`, as every
agent's provider must, apply execution-prepared credentials; direct create/resume never invoke `auth` implicitly. They apply
initial credentials before setup and expose session-scoped renewal, for ephemeral and named
sandboxes alike. Unsupported providers reject credentials before provisioning. During initial
provisioning/setup, the worker aborts before token expiry if no session handle is available yet;
renewal begins after acquisition. Normal teardown removes injection and revokes grants. A crash
cannot guarantee immediate revocation.

Such a provider's sandboxes also give `credentialedUrl(url)`: the address guest commands use to
reach `url` with the session's credentials added out of its reach. A provider whose firewall adds
them returns `url` itself; one that forwards on the host returns its own address, such as
`unix:/tmp/…/0.sock`, which reaches only `url`. The worker adds every run's own token for the Sixb
API this way, beside a source's credentials, so the run's commands never hold it.
A VM guest does the same from inside: its commands run as an unprivileged user and a root forwarder
holds the credentials (`guestCredentialsCommands`, `unprivilegedGuestArgv`), as smolvm and Apple
Container do. `runSandboxCredentialsContractSuite` in `@sixb/core/testing` is the contract: a command reaches the
origin with the credential added, only matching requests get it, replacing it takes effect, and
nothing a command can read (its env, process lists, `/proc`, its files) holds it.

A grant may also carry a guest-readable `env` (identities, placeholders), validated like recipe
`env` before provisioning; an invalid one fails authentication. It applies on creation and resume
under the recipe's own `env`. Only the first grant of a run is read: the session environment
cannot change once acquired, so renewals rotate requests and their `env` is ignored.
