---
name: sixb-actions
description: Use when requesting declared Sixb ontology actions as the preferred mutation path.
compatibility: Requires the sandbox bash tool and SIXB_API_BASE_URL.
---

# Sixb Actions

Use this skill when the user asks you to make a domain change and an ontology action exists for it.
Actions are the preferred mutation path.

## Workflow

1. Discover available actions with `curl -sS "$SIXB_API_BASE_URL/api/actions"`.
2. Match the requested operation to an action id and inspect required params.
3. Use ontology object ids from live data for action subjects.
4. Before calling the action request route, show the user a concise preview of the action id, subject, params, and expected effect, then ask for approval.
5. Only call the action request route after the user approves. Send the smallest valid params object. Do not invent fields.
6. Use the returned run id to inspect action run detail when the user needs status, errors, or commit effects.
7. Use action run history when you need to find an earlier authorized run.
8. Download FileRefs from action params or writeback results through the contextual file route.
9. Report the action request result back to the user.

## References

- Read [actions API](references/actions-api.md) for endpoints and payload shapes.
