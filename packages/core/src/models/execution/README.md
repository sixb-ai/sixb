# Model execution accounting

Internal execution and accounting shared by language, embedding, decision and reranking calls. Application usage is
documented in [Usage and limits](../../../../../docs/models/usage-and-limits.md).

## Execution boundary

`ModelExecutionSession` binds one execution attempt and cancellation signal. Its lazy recorder
uses the durable execution's requester-group snapshot, so redelivery cannot change attribution.
Language execution and the scoped embedding catalog share that recorder and its failure state.
Object authorization happens before embedding inference; wrapping a catalog does not grant access.

## Embedding flow

```text
Authorized index / text search
  → Scoped embedding model
  → Resolve model and pricing; verify identity and dimensions
  → Reserve capacity atomically
  → Call provider once
  → Record usage, valuation, and reconcile reservation
  → Check cancellation; return for vector validation and object write
```

`embedding.ts` snapshots inputs and combines caller, execution, and 30-second cancellation
signals. Providers must propagate the signal to their transport; cancellation is cooperative.
Input reservation uses UTF-8 bytes divided by four, rounded up per text. Output allowance and
actual output tokens are zero. Missing input usage remains unknown.

An optional provider `resolve()` pins pricing before admission. The response can include `usage`,
`providerIds`, `responseModelId`, `reportedCost`, and `route`. Provider charges take precedence;
the local estimate is retained separately. `EmbeddingModelResponseError` preserves this evidence
when a provider rejects an invalid response.

Accounting precedes cancellation propagation, vector validation, and the optimistic object write:
a rejected result or stale write does not erase a billable call. Ambiguous provider failures retain
unknown input usage and unresolved capacity. Inference is never retried here.

## Recovery and boundaries

`AiModelCallRecorder` retries the atomic accounting write, then hands persistent failures to
`queues.agents`. Its failure state prevents further billable calls in the session. Recovery
replays accounting only, never inference; see the
[worker recovery contract](../../../../agent-worker/docs/usage-accounting.md).

Direct provider calls bypass this session. Webhook handlers have no bound model execution attempt;
they must dispatch an action for accounted calls. A process crash before accounting is captured
can still leave provider billing outside the ledger.

## Reranking flow

`reranking.ts` binds the registered catalog to the same session. Object queries resolve only that
catalog, after semantic authorization and before query embedding. The query executor retrieves
authorized vector candidates first and sends only profile source text; inference holds no storage
transaction. Outer limits and property selection apply after ranking.

Admission estimates the UTF-8 bytes of each query/document pair divided by four, rounded up, with
zero output allowance. Actual provider meters are preserved. This is a heuristic, not a tokenizer or provider context guarantee. Calls have
the shared 30-second cancellation bound, with no inference retry. Accounting precedes cancellation
and ranking validation. A complete permutation with finite scores is required; ties preserve the
candidate order. `RerankingModelResponseError` carries metadata from malformed billable responses.

Provider charges remain distinct from token usage: absent tokens stay unknown. Reported costs
can reconcile monetary reservations; missing token usage cannot reconcile a token limit and makes
that meter unavailable. Missing tariffs fail admission under cost limits. Recovery remains the
existing accounting-only replay.

## Decision flow

Decision evaluation in `../decision/runtime.ts` uses the same session and recorder. It snapshots JSON input/questions
before yielding, resolves only a permitted catalog binding, checks primitive capabilities,
admits one call, invokes the provider, and records usage before validating or returning answers.
The original question snapshot defines valid answer keys, labels and score levels.

Input reservation uses serialized UTF-8 bytes divided by four; output reserves the shared
4,096-token estimate. Neither is a tokenizer or a provider-enforced ceiling. Decision providers
must preserve their actual output-token meters even when their output price is zero.

`DecisionModelResponseError` carries accounting metadata when protocol translation fails after
a billable response. Other errors retain unknown usage. Recovery replays accounting, never
inference. Decision-only projects use the existing recovery worker without an agent sandbox.
