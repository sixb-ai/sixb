---
name: sixb-query
description: Use when discovering ontology, reading Sixb objects, filtering, sorting, paging, counting, faceting, traversing links, or expanding object query results.
compatibility: Requires the sandbox bash tool and SIXB_API_BASE_URL.
---

# Sixb Query

Use this skill before reading object data or answering questions about current ontology objects.

## Workflow

1. Discover the live ontology with `curl -sS "$SIXB_API_BASE_URL/api/object-types"`.
2. Use exact object type, property, link, and telemetry ids from the ontology response.
3. Prefer the smallest query that answers the question.
4. Start with a low limit when exploring, then widen only when needed.
5. Use count, exists, and facets endpoints for aggregate questions instead of listing everything.
6. Only use the exact endpoint patterns documented in the references. Do not invent alternative
   URL forms; the agent API gateway only allows documented routes.
7. Inspect API error messages and query plan issues before retrying.

## References

- Read [query API](references/query-api.md) for endpoints and payload envelopes.
- Read [query shapes](references/query-shapes.md) when composing graph/query nodes.
- Read [predicates](references/predicates.md) when building filters.
- Read [examples](references/examples.md) for copyable curl patterns.
