import type { InferParams } from "../src"
import { type InferActionParams, optional, param, stringEnum } from "../src"

// Regression proof: widen InferParams or lose the required/optional flag in param().

const definitionParams = {
  clientId: param("string"),
  requestedAt: param("timestamp"),
  note: optional(param("string", { nullable: true })),
  priority: optional(param(stringEnum(["low", "high"]))),
}

type DefinitionParams = InferParams<typeof definitionParams>
type ActionParams = InferActionParams<typeof definitionParams>

const valid: DefinitionParams = {
  clientId: "acme",
  requestedAt: new Date(),
  note: null,
  priority: "high",
}

const actionCompatible: ActionParams = valid
const sharedCompatible: DefinitionParams = actionCompatible

// @ts-expect-error required params cannot be omitted
const missingRequired: DefinitionParams = { clientId: "acme" }

// @ts-expect-error timestamp params are typed as Date after validation
const untypedTimestamp: DefinitionParams = { clientId: "acme", requestedAt: "2026-08-26" }

// @ts-expect-error non-nullable params reject null
const invalidNull: DefinitionParams = { clientId: null, requestedAt: new Date() }

const invalidPriority: DefinitionParams = {
  clientId: "acme",
  requestedAt: new Date(),
  // @ts-expect-error enum params preserve their literal value union
  priority: "urgent",
}

void sharedCompatible
void missingRequired
void untypedTimestamp
void invalidNull
void invalidPriority
