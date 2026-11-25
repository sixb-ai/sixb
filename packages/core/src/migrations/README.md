# Ontology migrations

`defineMigration(id, Type)` declares steps that move one object type's stored objects; discovery
loads them from `migrations/`. When the host loads, `validateMigrationsAtStartup` refuses only a
migration that can never be right (duplicate id, rename into itself, primary or telemetry target,
one subject twice). One the code has moved past is inert: `inertMigrations` names it for
`sixb check`, and it never stops a role. Nothing here touches storage.

## Pending by shape

`planPendingSteps` (`pending.ts`) decides, for one concrete type, which steps the shape its stored
objects fit still needs. There is no ledger: a step is pending exactly while its condition holds.

1. **Candidates.** Every step of every migration of the type or of an ancestor on its `extends`
   chain, kept when it concerns the type (`appliesTo`): a removed or renamed-from id the type
   doesn't declare, a `to`, fill or convert property it inherits unchanged.
2. **Fixpoint.** Each round takes the pending steps, refuses pairs that hold one subject, runs the
   first (renames, then values, then removals; then by migration id and index) on the shape, and
   repeats. Identical key steps of two migrations run once. Migrations in `settled` (run, or past
   while not pending, recorded with run history in 2b) are left out: a migration runs at most once
   per database, so an old convert doesn't re-arm on a second narrowing.
3. **Result.** The ordered steps, the shape they leave, the steps the stored shape blocks with
   why, the conflicts, and `storedKey`, which maps a property of the code back through renames.

Termination: removed and `from` ids are undeclared, `to`, fill and convert ids are declared, so no
step recreates what another consumes; each runs at most once.

`coverChanges` (`coverage.ts`) diffs the shape left with the code's. What is still not compatible
is missing a migration and is probed under its stored key; what the steps covered is probed as
before. A change is matched by its subject and what it asks of the data, so "added as required" and
"now required" are one. The gate (`storage/migrations/type-shapes.ts`) turns only the changes data
holds into findings.

## Step kinds

`steps/` holds one `StepKind` per step: its phase, its conditions and effect on a shape, why it is
refused or inert, its subjects and the call `sixb check` suggests for the changes it resolves. The
algorithm, the validation and the messages only call these, so the steps that apply data add their
own members next to them.

| Subject role | Steps |
| --- | --- |
| `property` | `removeProperty`, the `from` of `renameProperty` |
| `renamedTo` | the `to` of `renameProperty` |
| `fill`, `convert` | `fillProperty`, `convertProperty`: one of each may be pending together |
| `link` | `removeLink` |

`convertProperty` is pending only on a narrowing, not on any schema difference: a convert kept in
the repo doesn't rewrite values again when its property later widens.
