import { describe, expect, test } from "bun:test"
import * as core from "@sixb/core"
import * as context from "@sixb/core/agents/context"
import * as streams from "@sixb/core/agents/streams"
import * as internalActions from "@sixb/core/internal/actions"
import * as internalStreams from "@sixb/core/internal/agents/streams"
import * as internalStorage from "@sixb/core/internal/storage"
import * as logging from "@sixb/core/logging"
import * as ontology from "@sixb/core/ontology"
import * as query from "@sixb/core/query"
import * as storage from "@sixb/core/storage"
import pkg from "../package.json"

// Regression check: re-export requestAction from src/index.ts and run this file;
// the first test must fail. Re-export publishAgentRunCancel from agents/streams/index.ts,
// normalizeObjectProperties from ontology/index.ts, or createTransactionStorageProxy
// from storage/index.ts to reproduce the corresponding boundary failures.
describe("public core export boundaries", () => {
  test("run orchestration is internal while application authoring remains public", () => {
    for (const name of [
      "requestAction",
      "requestActionAndWait",
      "waitForActionRun",
      "requestAgentRun",
      "requestSyncRun",
      "requestPipelineRun",
      "requestWorkflowRun",
      "emptyGrantIndex",
      "validateSchemaOrRefValue",
    ])
      expect(Object.hasOwn(core, name)).toBe(false)
    expect(internalActions.requestAction).toBeFunction()
    expect(core.createSixb).toBeFunction()
    expect(core.defineAction).toBeFunction()
    expect(core.ActionRunFailedError).toBeFunction()
  })

  test("agent stream readers do not expose the worker control protocol", () => {
    expect(streams.isAgentRunStreamEvent).toBeFunction()
    expect(streams.isAgentRunActivityEvent).toBeFunction()
    for (const name of [
      "publishAgentRunActivity",
      "publishAgentRunCancel",
      "publishAgentRunFinished",
      "subscribeAgentRunCancel",
      "agentRunStreamIdempotencyKey",
      "agentRunFinishedEvent",
      "agentRunStreamEventBase",
      "agentRunControlStreamId",
      "agentRunControlStreamDefinition",
    ])
      expect(Object.hasOwn(streams, name)).toBe(false)
    expect(internalStreams.publishAgentRunCancel).toBeFunction()
  })

  test("public modeling and readers do not expose runtime normalization", () => {
    expect(ontology.defineObjectType).toBeFunction()
    expect(ontology.objectRef).toBeFunction()
    expect(query.createObjectQueryBuilder).toBeFunction()
    for (const name of [
      "normalizeObjectProperties",
      "validateSchemaValue",
      "assertObjectTypeRegistered",
      "validateSchemaOrRefValue",
      "assertRequiredProperties",
      "isRecord",
    ])
      expect(Object.hasOwn(ontology, name)).toBe(false)
    expect(Object.hasOwn(query, "normalizeObjectQuery")).toBe(false)
    expect(Object.hasOwn(context, "normalizeAgentContextEntries")).toBe(false)
    expect(Object.hasOwn(logging, "normalizeLogError")).toBe(false)
    expect(context.agentContext.object({ id: "invoice" }, "1")).toEqual({
      kind: "object",
      ref: { objectTypeId: "invoice", primaryId: "1" },
    })
  })

  test("storage exposes providers and errors without internal mutation helpers", () => {
    expect(storage.InMemoryStorage).toBeFunction()
    expect(storage.StorageTransactionError).toBeFunction()
    for (const name of [
      "createTransactionStorageProxy",
      "throwNestedStorageTransaction",
      "assertTransactionActive",
      "finishActionRunPhase",
      "canRequeueActionRunAfterEnqueueFailure",
      "canRequeuePipelineRunAfterEnqueueFailure",
      "canRequeueSyncRunAfterEnqueueFailure",
      "normalizeAiModelCallRecord",
      "normalizeAiModelCallUsage",
      "createFileUploadId",
      "zeroProjectionRunProgress",
      "projectionRunObjectTypesVisible",
    ])
      expect(Object.hasOwn(storage, name)).toBe(false)
    expect(internalStorage.createTransactionStorageProxy).toBeFunction()
    expect(internalStorage.finishActionRunPhase).toBeFunction()
  })

  test("worker edit recording and event routing have internal subpaths", () => {
    expect(Object.hasOwn(pkg.exports, "./actions/worker")).toBe(false)
    expect(Object.hasOwn(pkg.exports, "./events/scope")).toBe(false)
    expect(Object.hasOwn(pkg.exports, "./internal/action-edits")).toBe(true)
    expect(Object.hasOwn(pkg.exports, "./internal/event-scope")).toBe(true)
  })
})
