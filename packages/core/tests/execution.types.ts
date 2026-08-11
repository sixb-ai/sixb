import type {
  AuthorizationRef,
  ExecutionContext,
  ExecutionScope,
  RuntimeAuthorization,
  TrustedPrimitiveRef,
} from "../src"
import * as core from "../src"
import { createTestExecutionScope } from "../src/testing"

declare const authorization: RuntimeAuthorization

const execution: ExecutionContext = {
  id: "execution-1",
  projectId: "project-1",
  requestedBy: { type: "user", id: "user-1" },
  executor: { type: "request", requestId: "request-1" },
  source: { type: "http", requestId: "request-1" },
  correlationId: "correlation-1",
}

const scope: ExecutionScope = { execution, authorization }
const ref: AuthorizationRef = {
  type: "principal",
  principal: { type: "serviceAccount", id: "service-account-1" },
  credential: { type: "accessToken", id: "token-1" },
}

const invalidTrustedPrimitive: TrustedPrimitiveRef = {
  // @ts-expect-error Agents execute with service-account authority, not trusted primitive authority.
  kind: "agent",
  id: "agent-1",
  runId: "agent-run-1",
}

// @ts-expect-error Runtime authority cannot be constructed structurally.
const forgedAuthorization: RuntimeAuthorization = {}

const invalidExecution: ExecutionContext = {
  ...execution,
  // @ts-expect-error System identity is provenance, not an authorizable caller.
  requestedBy: { type: "system", id: "system" },
}

// @ts-expect-error Privileged scope factories are intentionally absent from the package root.
core.createTrustedPrimitiveScope

// @ts-expect-error The raw capability allocator is private to Core.
core.createRuntimeAuthorizationCapability

// @ts-expect-error Test scope creation is available only from @sixb/core/testing.
core.createTestExecutionScope

void createTestExecutionScope("project-1")
void scope
void ref
void forgedAuthorization
void invalidExecution
void invalidTrustedPrimitive
