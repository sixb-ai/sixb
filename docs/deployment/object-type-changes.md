# Changing object types

A deploy checks every object type against the objects already stored. A change those objects no
longer fit stops the deploy before anything is written, and says what holds it back.

```text
✗ Job: 'gate' was removed, and 2,140 objects hold it.
  Declare it again until a migration removes it.
```

## What a deploy checks

Storage keeps, for each object type, the shape its stored objects fit: each property's schema,
`required`, `nullable`, mode, `unique` and primary, and each link's cardinality and the types it
accepts, subtypes included. `sixb db migrate` and `sixb check --migrate` compare it with your
code's.

| Change | Stops the deploy when |
|---|---|
| New optional property, new type, new link, link widened (a target added, a supertype, `link.any`), name or description | Never |
| Property removed | An object, an edit or a projection's row still holds it |
| New required property, or optional made required | An object created by an action lacks it, or an edit cleared it |
| Schema narrowed (other type, enum value removed, `nullable` removed) | An edit holds a value the new schema refuses |
| Link removed | A link or a link edit of that kind exists |
| `unique` added, or its values compared another way (schema changed) | Two objects share a value: they are named before anything is written |
| Mode changed (static ↔ telemetry), telemetry property removed or narrowed, link retargeted (a type it accepted no longer is, such as a subtype that left the hierarchy; a removed type's own row decides for it) or cardinality changed, primary property changed, type removed | Any data holds it: these aren't supported yet |

Widening needs nothing: new enum values, `integer` to `double`, `nullable` added, `required`
dropped. Values a projection writes aren't checked: the projection rebuilds them under the new
definition.

## The first deploy

With no shape stored yet, the first `sixb db migrate` reads every object and edit once and records
what they hold, so a key the code renamed shows as removed. A property, link or telemetry series no
definition declares, a value its schema refuses, or a required property some objects lack shows up
as a change, like any other. A type that already holds objects stops the live release for its first
shape, which the old code may not fit.

## During a deploy

| `sixb db migrate --check` | Means | The SSH target |
|---|---|---|
| `0` | Nothing to change, or only widenings | Keeps the live release serving |
| `3` | A storage migration, a narrowing no stored object is left out of, or a first shape | Stops the live release, then migrates |
| `1` | Stored objects don't fit the code | Fails before stopping anything |

`sixb check --migrate` builds unique values and records the new shapes last, once every other check
passed, so a deploy that fails restarts the old release on data it still fits. A property made
unique pauses writes like any narrowing: the old release would otherwise write a value another
object holds while the values are built, so building them is part of the deploy's pause.

## Roles and `sixb dev`

- A role (`api`, `orchestrator`, workers) compares the recorded shapes with its code,
  `--no-migrate` included. It never reads objects:
  - code that only adds or widens starts, and records the change;
  - the previous release starts again after a deploy, a failed one included. What the deploy
    added stays recorded, so the next deploy still checks its removal. It can't edit an object
    holding what the newer release added: the edit fails with `Unknown property`;
  - anything else stops it, a property made unique included: run `sixb db migrate` first.
- A role that finds a type holding objects and no recorded shape starts as before and says so:
  `sixb db migrate` records it.
- `sixb dev` warns instead of refusing, and leaves the recorded shape, and that type's unique
  values, as they were.
- `sixb check` without `--migrate` prints the same result on its **Stored objects** row.
