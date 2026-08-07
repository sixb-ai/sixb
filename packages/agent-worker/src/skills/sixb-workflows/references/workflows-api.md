# Workflows API

All requests go through `$SIXB_API_BASE_URL`. Do not add Authorization or Cookie headers.

## Discover Workflows

```bash
curl -sS "$SIXB_API_BASE_URL/api/workflows"
curl -sS "$SIXB_API_BASE_URL/api/workflows/workflowId"
```

Only workflows you may run are returned. Inspect the workflow's `input` contract before composing a
request.

## Start A Workflow — Conversation Mode Only

Only use this route when the execution catalog says `conversation`. Before calling it, show the
user a concise preview and ask for approval. Do not request the workflow until the user approves.
In `workflow-task` mode, do not call this route.

```bash
curl -sS \
  -H "Content-Type: application/json" \
  -X POST "$SIXB_API_BASE_URL/api/workflows/workflowId/runs" \
  --data '{"input":{}}'
```

## Inspect Workflow Runs

```bash
curl -sS "$SIXB_API_BASE_URL/api/workflow-runs?workflowId=workflowId&limit=20&order=desc"
curl -sS "$SIXB_API_BASE_URL/api/workflow-runs/workflow_run_id"
```

Use the returned status, output, and error information. Stay on these top-level run routes.

## Read Workflow Run Files

The `path` query parameter is a JSON Pointer and must start with `/input/` or `/output/`.

```bash
curl -sS \
  "$SIXB_API_BASE_URL/api/workflow-runs/workflow_run_id/files/content?path=%2Finput%2Fdocument" \
  -o input.pdf

curl -sS \
  "$SIXB_API_BASE_URL/api/workflow-runs/workflow_run_id/files/content?path=%2Foutput%2Freport" \
  -o report.pdf
```
