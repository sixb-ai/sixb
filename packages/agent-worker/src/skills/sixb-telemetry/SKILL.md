---
name: sixb-telemetry
description: Use when reading Sixb telemetry latest values or history for ontology telemetry properties.
compatibility: Requires the sandbox bash tool and SIXB_API_BASE_URL.
---

# Sixb Telemetry

Use this skill when a question asks about measurements, signals, readings, time series, latest
values, or historical telemetry for an object.

## Workflow

1. Discover the object type with `curl -sS "$SIXB_API_BASE_URL/api/object-types"`.
2. Confirm the object type has the telemetry property id you need.
3. Use latest for current state and history for trends or time windows.
4. Use bulk history when comparing multiple object/property series.
5. Treat telemetry through the agent gateway as read-only.

## References

- Read [telemetry API](references/telemetry-api.md) for endpoints and request shapes.
