import { posix } from "node:path"
import { openFileRef } from "../blob-storage/file-content"
import type { JsonObject, JsonValue } from "../json"
import type { Logger } from "../logging/types"
import { schemaRecordToJsonSchema } from "../ontology/json-schema"
import type { ValueType } from "../ontology/types"
import type { AgentMessageRecord, SubagentRunFile } from "../storage/agents"
import { attachmentKeyMessageId, findMessageAttachment } from "./attachment-keys"
import { AgentToolPublicError } from "./errors"
import type { AgentRunFileStore } from "./run-session"
import { type AgentToolCallFile, SANDBOX_CONTEXT_DIRECTORY, storeAgentToolFile } from "./tool-files"
import type {
  AgentToolAttachments,
  AgentToolDefinition,
  AgentToolRunInfo,
  AgentToolRuntimeFacade,
} from "./types"
import { validateAndNormalizeAgentToolInput } from "./validation"

// A project tool is the project's code, so it runs where the project is: in the worker for a run
// it holds, on the server for a run on a computer. Either way it runs here, as the run: its input
// checked against the tool's schema, its handler given the run's SDK and attachments, and the
// files it puts stored for its runner to copy into the sandbox.

/** A project tool as the model is offered it. */
export interface AgentToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject
}

/** A call the model made to a project tool. */
export interface AgentToolCall {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: unknown
}

/** What a project tool returned, and the files it stored for the run's sandbox. */
export interface AgentToolCallResult {
  readonly output: JsonValue
  /** Each at its path in the sandbox's context directory. */
  readonly files: readonly AgentToolCallFile[]
}

/** The spec the model gets for a project tool: its input as JSON Schema. */
export function agentToolSpec(
  definition: AgentToolDefinition,
  valueTypesById: ReadonlyMap<string, ValueType>
): AgentToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: schemaRecordToJsonSchema({ shape: definition.input, valueTypesById }),
  }
}

/**
 * Run one call of a project tool as the run. Input the tool's schema refuses is an
 * {@link AgentToolPublicError}, which the model reads. Whatever the handler throws is thrown as it
 * is: its runner decides what the model may read of it.
 */
export async function runAgentTool(input: {
  readonly definition: AgentToolDefinition
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly call: AgentToolCall
  readonly signal: AbortSignal
  readonly run: AgentToolRunInfo
  /** The run's SDK, bound as its requester. */
  readonly sixb: AgentToolRuntimeFacade
  readonly logger: Logger
  readonly attachments: AgentToolAttachments
  /** Where the files it puts are stored. */
  readonly files: Pick<AgentRunFileStore, "put">
}): Promise<AgentToolCallResult> {
  const { definition, call, signal } = input
  let toolInput: Readonly<Record<string, JsonValue>>
  try {
    toolInput = validateAndNormalizeAgentToolInput(
      definition.name,
      definition.input,
      call.input,
      input.valueTypesById
    )
  } catch (error) {
    throw new AgentToolPublicError(
      error instanceof Error
        ? error.message
        : `[Sixb] Agent tool '${definition.name}' input is invalid.`
    )
  }

  const stored: AgentToolCallFile[] = []
  const output = await definition.handler({
    input: toolInput,
    toolCallId: call.toolCallId,
    signal,
    run: input.run,
    sixb: input.sixb,
    logger: input.logger,
    files: {
      async put(file) {
        const { fileRef, path } = await storeAgentToolFile({
          toolName: definition.name,
          toolCallId: call.toolCallId,
          file,
          store: input.files,
          signal,
        })
        stored.push({ fileRef, path })
        // Where the runner copies it, in a sandbox that keeps its run files in the usual place.
        return { fileRef, sandboxPath: posix.join(SANDBOX_CONTEXT_DIRECTORY, path) }
      },
    },
    attachments: input.attachments,
  })
  return { output: output as JsonValue, files: stored }
}

/**
 * A chat's attachments: files of its thread's messages, by the key `$SIXB_ATTACHMENTS` lists. A key
 * resolves only in a message of the run's own thread.
 */
export function threadToolAttachments(input: {
  readonly threadId: string
  readonly message: (messageId: string) => Promise<AgentMessageRecord | null>
  readonly files: Pick<AgentRunFileStore, "stat" | "open">
}): AgentToolAttachments {
  return {
    async open(key) {
      const messageId = attachmentKeyMessageId(key)
      const message = messageId && (await input.message(messageId))
      const fileRef =
        message && message.threadId === input.threadId ? findMessageAttachment(message, key) : null
      if (!fileRef) throw unknownAttachment(key)
      return openFileRef(input.files, fileRef)
    },
  }
}

/** A child Agent's attachments: the files its parent handed over, by their path such as `q3.pdf`. */
export function handedToolAttachments(input: {
  readonly files: readonly SubagentRunFile[]
  readonly store: Pick<AgentRunFileStore, "stat" | "open">
}): AgentToolAttachments {
  const fileRefs = new Map(input.files.map((file) => [file.path, file.fileRef]))
  return {
    async open(key) {
      const fileRef = fileRefs.get(key)
      if (!fileRef) throw unknownAttachment(key)
      return openFileRef(input.store, fileRef)
    },
  }
}

function unknownAttachment(key: string): AgentToolPublicError {
  return new AgentToolPublicError(
    `[SixbAgent] '${key}' is not an attachment of this run. Pass a key listed in $SIXB_ATTACHMENTS.`
  )
}
