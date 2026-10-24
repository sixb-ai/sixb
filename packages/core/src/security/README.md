# View conditions

`can.view(Type).where(...)` grants a principal only the objects of `Type` its condition matches.
This note follows a condition from the role that declares it to every surface that names an
object. The public contract is in `docs/auth/authorization.md`.

## Startup

1. `view-conditions.ts` validates each condition as a filter over the type and the subtypes the
   grant covers. It refuses marked properties and ordered text comparisons, and keeps the
   validated predicate, scalar kinds resolved and frozen.
2. `registry.ts` resolves them per role with `resolveRoleViewConditions`
   (`authorization/resolve.ts`): one predicate per concrete type, subtypes included, `or` across
   the role's conditions. A type the role also views whole drops them.
3. The `SixbHost` constructor compiles each one through the object storage's conditional scope
   (`assertViewConditionsReadable`), so a predicate the provider cannot read fails startup and
   not every read of its type.

## Resolution: closed by default

`resolveAuthorizationContext` (`authorization/resolve.ts`) unions roles. A conditional grant never
reaches `view:object`: its types land in `viewConditions`, one predicate per role, and a type any
role views whole leaves `viewConditions`.

Every check that decides on `view:object` therefore denies a conditioned type. That is the safe
default: a surface that does not know about conditions shows nothing, never everything.

## Reading through the reader

`ObjectReaderSecurity` (`execution/object-reader-security.ts`) turns the context's conditions into
one compiled conditional scope, `or` across roles. `currentUser()` binds to the context's principal
when it is a user, and to no one otherwise: never to `execution.requestedBy`, the user an agent's
service account may run for. Queries keep binding it to the requester.

`AuthorizedObjectReader` reads through `createConditionalReadScope` for that scope, so get, list,
query, count, facets, search, links and traversals see only matching objects, before `LIMIT` and
totals. A condition reading a property the reader's clearance hides (a marking a
dataset version applied) hides the whole type.

`viewsThroughCondition(type)` tells the other surfaces when to read through the reader instead of
deciding on the type:

| Surface | Where | How |
| --- | --- | --- |
| Events | `events/view-conditions.ts` | Object events match the state they carry with `matchesPredicate`; an update that reveals an object loses the values it replaced. Link, telemetry and rule events read their objects through the reader, one batch per call (`visibleObjects`). One of them since deleted is decided on what it held when the event happened: storage tells which unseen objects still exist, and the log's last event of each other one gives its state then (`ObjectEventHistory`). |
| Telemetry reads | `execution/authorized-object-reader.ts` | Property checks by id read the objects through the reader. |
| Action runs | `actions/run-authorization.ts`, `actions/execution.ts` | A run shows while its subject reads. Run storage cannot filter by a condition: a listing that names the subject reads it first; any other listing leaves the type out. |
| Rule matches | `rules/execution.ts` | Same rule as runs: listed per object. |
| Actions | `actions/request.ts`, `actions/run/context.ts`, `actions/execution.ts` | The subject and `ref()` params must read, or the request fails as not found. Each attempt of the run confirms its requester sees the subject at the version it loaded, so handlers never run on a hidden state. Actions on the type are listed as the reader's ontology lists it. |
| Writes | `objects/conditional-writes.ts` | Each named object is read first; the commit expects it as read, so one hidden meanwhile is never written. A hidden id reports as taken. |
| Share issuance | `shares/execution.ts` | The target is read through the issuer's reader; a hidden one is not found. Each type the share's links reach needs `view:object`: a link keeps showing whatever it reaches. The issued link holds its own grants, so it keeps the target after the target stops matching. |

Restores, telemetry appends and projection runs keep deciding on `view:object`, so they stay
closed to a conditioned type.

## Adding a surface

A surface that names an object must never treat a conditioned type as viewable by its type alone:
neither `isAllowed(..., { kind: "object.view" })` nor a type list built from `view:object` can
answer for one object of it. Read the object through the principal's `AuthorizedObjectReader`, as
the surfaces above do, or leave the type closed. Readers that view a type whole should keep
answering without a read.
