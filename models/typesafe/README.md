# @sixb/typesafe

Optional TypeSafe Jev decision provider for Sixb actions and workflows.

```sh
bun add @sixb/typesafe
export TYPESAFE_API_KEY="..."
```

```ts
import { typesafe } from "@sixb/typesafe"

const jev = typesafe("jev-1.13.0")
// In your createSixb() options:
const models = { decision: [jev] }
```

Use `sixb.models.decision.evaluate({ input, questions })` from an action writeback/effects
handler or an ordinary workflow step. [Decision models](../../docs/models/configuration.md#decision-models).

## Configuration

```ts
import { createTypesafe } from "@sixb/typesafe"

const provider = createTypesafe({
  apiKey: () => process.env.TYPESAFE_API_KEY,
  timeoutMs: 30_000,
})
const jev = provider("jev-1.13.0")
```

Options: `apiKey` (string or getter; defaults to the environment), `timeoutMs`,
`fetch` for instrumentation/testing, and `baseUrl` for an explicitly configured compatible
endpoint (default `https://api.typesafe.ai/v1`).

Each evaluation sends one `POST /systemone`. There are no automatic inference retries.
HTTP errors preserve status, request ID and numeric Retry-After where supplied, without
copying provider error bodies into logs. Cancellation reaches the transport.

## Context limits

For Jev 1.13, TypeSafe documents 64k tokens per request and 32k for the state plus the longest
question. Sixb has no exact TypeSafe tokenizer, so the service performs authoritative context
validation. A rejection is surfaced without truncation, summarization or chunking. Select
relevant fields and prepare oversized inputs explicitly. See the
[model limits](https://docs.typesafe.ai/models).

## Model and cost identity

Use a versioned model when application thresholds depend on its behavior. The adapter rejects
a response that changes an explicitly versioned Jev model, while retaining its usage evidence.
Aliases preserve the actual returned model ID.

Local cost estimates cover only `jev-1.13.0` on the standard endpoint: USD 0.042 per million
input tokens and zero per output token, verified on 2026-09-22 against the
[TypeSafe model reference](https://docs.typesafe.ai/models). Output usage is retained.
Unknown versions and custom endpoints have unavailable estimates, not zero cost.
Aliases cannot reserve a catalog-estimated cost before their version is known; use a pinned
model with an enforced cost policy.

The adapter translates the protocol; Sixb owns admission, validation, usage accounting and
recovery. Calling the provider's `evaluate()` method directly bypasses those runtime guarantees.

## Validation

Deterministic protocol tests use an injected HTTP transport. They do not assert model quality
or production latency. Any live test needs an explicit credential and a bounded evaluation
corpus/budget. No live inference runs as part of the default test suite.
