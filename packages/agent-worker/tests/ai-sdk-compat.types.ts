/**
 * Type-only contract between Sixb's `ai`-free message types and the AI SDK v6 shapes the worker
 * actually feeds. This file is never executed; it fails the build if the contract drifts.
 */
import type { AgentInboundUiMessage, AgentMessage } from "@sixb/core"
import { toModelMessages } from "@sixb/core"
import type { ModelMessage, UIMessage } from "ai"

// A real v6 `UIMessage` must assign to `fromAiSdk`'s inbound shape *without a cast* — this is the
// safety net at the SDK boundary and the reason the worker can pass `responseMessage` straight in.
declare const sdkMessage: UIMessage
const _inbound: AgentInboundUiMessage = sdkMessage

// `toModelMessages` is core's mirror of `convertToModelMessages`. Its output is fed to
// `streamText({ messages })` via a single boundary cast in `run-agent-turn.ts`; the only gap is
// `providerOptions`, typed wider as `JsonValue` in core (it cannot depend on `ai`). This locks the
// cast as a width-only relaxation, not a structural lie.
declare const history: readonly AgentMessage[]
const _model: ModelMessage[] = toModelMessages(history) as ModelMessage[]

void _inbound
void _model
