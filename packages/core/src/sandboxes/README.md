# Sandboxes

Factories define environments; threads retain immutable parameters; runs provide current authority.

- [Configuration](./configuration.ts) validates and snapshots recipes, sharing Action parameter
  schemas. Resolvers receive the execution-scoped SDK. Only parameters are stored in `sandbox_params`.
- [Initialization](./environment.ts) runs once, after session settings are applied. Git uses
  `repository/`; source-free environments use the provider root. Vercel skips native cloning on this
  path to avoid preparing the source twice. Confirmed loss starts a new generation and replays setup.
- The worker resolves each run, acquires fenced ownership, executes, cleans transient files and
  confirms preservation before finalizing. Source identity/revision cannot change on resume.
- Confirmed missing/expired state allows one replacement attempt under the current execution fence.
  A durable reset timestamp informs subsequent model calls; conversation history is preserved.
- Omitted network policy permits API/source access. Explicit policies are never widened; incompatible
  policies fail before provisioning. Guest-readable `env` is not a Git credential channel.

## V1 limits

Vercel requests can outlive their worker: storage fencing cannot cancel provider-side work.
Uncertain generations stay blocked; explicit recreation uses a new name without deleting old state.
Saved files remain subject to provider retention. Git authentication is a separate slice.
