# Model execution accounting

Internal execution and accounting shared by language, embedding, decision, reranking, image and speech calls. Application usage is
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

An Agent run binds its own recorder to its SDK, so calls from its tools share the run's admission,
failure state and cancellation. A request through the agent API gateway is served by the server,
not by the run's worker: it gets its own recorder on the run's execution and current attempt, and
only its own request cancels it. Direct provider calls bypass this session. Webhook handlers have no
bound model execution attempt; they must dispatch an action for accounted calls. A process crash
before accounting is captured can still leave provider billing outside the ledger.

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

Provider charges remain distinct from token usage: absent tokens stay unknown. Token limits
neither admit nor count reranking, transcription, image or speech calls (`aiLimitMeterApplies` in
the limit storage helpers), so their unmetered records cannot make a token meter unavailable. Reported
costs reconcile monetary reservations; missing tariffs fail admission under cost limits. Recovery
remains the existing accounting-only replay.

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

## Image flow

Image generation in `../image/runtime.ts` snapshots the request, resolves only a permitted catalog
binding and checks it against the definition's sizes, counts and reference-image limits before
reading any file. Reference images are read with the same size and digest checks as transcription
audio (`../input-file.ts`).

Admission reserves the binding's `estimateReservation`, keyed by the request's size, quality and
style; without one, cost limits refuse the call. The call is recorded before its images are
validated or written: `outputImages` is the number the provider actually returned, whatever its
own usage says, and the same dimensions select the rate-card variant. Generated images are written
to blob storage only after accounting, so a cancelled call is billed but stores nothing.

## Speech flow

Speech generation in `../audio/speech.ts` follows the image flow. A request without a voice takes
the binding's `defaultVoice`, and voice, format, length and instructions are checked against the
definition before admission. Sixb never transcodes: a reply in a format other than the one requested
is an invalid response, recorded but not stored.

Characters and voice tiers are provider rules, so the binding owns both: `estimateReservation`
receives the text and voice and counts characters itself, providers report `inputCharacters` in
usage, and `pricingDimensions` in the reply names the tier the provider billed, which selects the
rate-card variant.
