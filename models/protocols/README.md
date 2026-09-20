# @sixb/model-protocols

Shared request serialization and streaming decoders for Sixb model providers.

> **Internal package.** Applications should use a provider such as `@sixb/anthropic`,
> `@sixb/vercel-ai-gateway`, or `@sixb/azure-ai-foundry`. Provider packages depend on this
> package with `workspace:*` (published as an exact version). No independent compatibility promise.

## Protocols at a glance

| Import subpath | API format | Official documentation |
| --- | --- | --- |
| `/responses` | OpenAI Responses | [Reference][responses-api] · [Streaming][responses-streaming] |
| `/messages` | Anthropic Messages | [Reference][messages-api] · [Streaming][messages-streaming] |
| `/chat` | OpenAI-compatible Chat Completions | [Streaming reference][chat-streaming] |

```text
Sixb ModelMessage[] → input serializer → native request fields
HTTP response body → SSE decoder      → AsyncIterable<LanguageModelStreamEvent>
```

| This package owns | The provider owns |
| --- | --- |
| Message/file/tool serialization | HTTP, endpoints, authentication, retries |
| Stream parsing and fragment assembly | Model capabilities, schemas, request options |
| Provider-namespaced replay data | Replay-scope validation, catalogs, caching, pricing |
| Raw usage collection and normalization hooks | Provider-specific accounting assumptions |

Only the three subpaths are exported; there is no root API. All use a shared, bounded SSE
decoder that handles fragmented UTF-8 and closes unfinished streams on abort or consumer return.

## Responses

```ts
import {
  responsesInput,
  responsesEvents,
  responsesUsage,
  type ResponsesStreamOptions,
} from "@sixb/model-protocols/responses"
```

| Function | Purpose |
| --- | --- |
| `responsesInput(messages, providerId)` | Serialize messages, files, tools, phases, and encrypted reasoning replay. |
| `responsesEvents(body, signal, options)` | Assemble text/reasoning/tool events and validate terminal completion. |
| `responsesUsage(raw)` | Preserve reported counters and raw usage; missing counters stay unknown. |

- **Completion:** requires a terminal response event, such as `response.completed`.
- **Interrupted responses:** retain their truncation/filter reason even after tool arguments close;
  Sixb's model loop rejects local tool execution on unsuccessful finishes while retaining usage.
- **Replay:** retains ordered native items under the calling provider's ID.
- **Hooks:** `ResponsesStreamOptions` supports usage normalization, provider IDs, and finish metadata
  (provider data, reported cost, route). Event parsing stays in the decoder.

## Messages

```ts
import {
  messagesInput,
  messagesEvents,
  type MessagesStreamOptions,
} from "@sixb/model-protocols/messages"
```

| Function | Purpose |
| --- | --- |
| `messagesInput(messages, providerId, errorPrefix)` | Return system/content blocks; serialize images/PDFs and tools; merge adjacent roles. |
| `messagesEvents(body, signal, options)` | Assemble text, tools, thinking/signatures, citations, and opaque native blocks. |

```text
message_start
  content_block_start → content_block_delta* → content_block_stop  (repeated per block)
  message_delta*       (stop reason and cumulative usage)
message_stop
```

- **Replay:** preserves signed/redacted thinking and native blocks; foreign thinking is not synthesized.
- **Usage:** recursively merges cumulative snapshots, ignoring null updates. Raw meters are retained.
- **Hook:** `MessagesStreamOptions.usage` replaces the default Anthropic normalizer.

| Default Anthropic accounting | Behavior |
| --- | --- |
| Input total | Uncached `input_tokens` + cache reads + cache writes. |
| Missing cache counters | Default to zero when uncached input is reported. |
| Cache TTL splits | Remain unknown for nonzero aggregate writes without a breakdown. |
| Text output | Total output minus thinking tokens; missing thinking is treated as zero. |

Foundry overrides these defaults to keep absent cache/thinking counters unknown.
See [prompt caching][messages-caching] for meter definitions and [tool streaming][messages-tools]
for partial JSON assembly.

## Chat Completions

```ts
import {
  chatInput,
  chatEvents,
  type ChatInputOptions,
  type ChatStreamOptions,
} from "@sixb/model-protocols/chat"
```

| Function | Purpose |
| --- | --- |
| `chatInput(messages, options)` | Serialize system/developer messages, images, function calls, and tool results. |
| `chatEvents(body, signal, options)` | Decode one choice, text/reasoning, fragmented tools, refusals, usage, and Azure filters. |

```text
choice deltas → choice finish → final usage / delayed filter annotations → [DONE]
```

- **Completion:** waits for `[DONE]`; a choice finish alone is insufficient. Malformed or incomplete
  streams fail. Truncated/filtered tool calls are not emitted as executable calls.
- **Usage:** passes the last non-null snapshot to the required `ChatStreamOptions.usage` callback.
- **Replay:** omitted by default. Optional `tool-continuation` replays only this provider's reasoning
  on tool-call messages after the latest user message. Providers validate replay scope first.
- **Limits:** single choice; bounded replay/tool and annotation buffers. Opaque state and
  provider-executed tools are unsupported. Literal `<think>` tags remain ordinary text.

## Hosting-specific behavior

Matching an API format does not establish feature or billing parity. For Azure, also consult:

- [Claude endpoints and authentication][azure-claude]
- [Claude models, hosting, and capabilities][azure-claude-models]
- [Chat reasoning and `reasoning_content`][azure-chat]

[responses-api]: https://developers.openai.com/api/reference/responses/overview
[responses-streaming]: https://developers.openai.com/api/docs/guides/streaming-responses
[messages-api]: https://platform.claude.com/docs/en/api/messages
[messages-streaming]: https://platform.claude.com/docs/en/build-with-claude/streaming
[messages-caching]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[messages-tools]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
[chat-streaming]: https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
[azure-claude]: https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-claude
[azure-claude-models]: https://learn.microsoft.com/azure/foundry/foundry-models/concepts/claude-models
[azure-chat]: https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-chat-reasoning
