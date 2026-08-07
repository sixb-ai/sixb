---
name: sixb-workflows
description: Use when discovering, starting, or monitoring authorized declared Sixb workflows.
compatibility: Requires the sandbox bash tool and SIXB_API_BASE_URL.
---

# Sixb Workflows

Use this skill when a declared workflow is the right domain operation or when the user asks about a
workflow run.

## Read And Monitor

1. Discover authorized workflows and inspect the selected workflow's input contract.
2. Build the smallest valid input from live ontology data and complete FileRefs.
3. Monitor runs through the top-level run endpoints. Do not use cancellation, interventions,
   agent execution diagnostics, or node-level file routes.
4. Download top-level input or output FileRefs through the workflow run file route.

## Start A Workflow — Conversation Mode Only

When the execution catalog says `conversation`:

1. Show the user a concise preview of the workflow id, input, and expected effect.
2. Ask for approval and do not start the workflow until the user approves.
3. Start the workflow once and retain its returned run id.

When the execution catalog says `workflow-task`, never start another workflow and never ask the
user for approval. If the gateway rejects a recursive start, report that boundary instead of
retrying it.

## References

- Read [workflows API](references/workflows-api.md) for endpoint and payload shapes.
