import type { DomainEvent } from "@sixb/core"
import { requestAction } from "./generated/sdk.gen"
import type {
  GetProjectInfoResponse,
  GetTelemetryHistoryResponse,
  ListObjectsResponse,
  ListObjectTypesResponse,
} from "./generated/types.gen"

export * from "./generated"
export { client } from "./generated/client.gen"

type ObjectTypeDefinition = ListObjectTypesResponse extends Array<infer T> ? T : never
type ObjectListItem = ListObjectsResponse extends {
  objects: Array<infer T>
}
  ? T
  : never

export interface RelationshipEdge {
  source: string
  target: string
  type: string
  properties?: Record<string, unknown>
}

export interface ActionParam {
  type: "string" | "number" | "boolean" | "fileRef"
  required?: boolean
  nullable?: boolean
  description?: string
  enum?: Array<string | number | boolean>
}

export interface ObjectAction {
  id: string
  description?: string
  params?: Record<string, ActionParam>
  timeout?: number
}

export interface TelemetryProperty {
  source: string
  class?: string
  dataType?: "number" | "string" | "boolean"
  unit?: string
  writable?: boolean
  currentValue?: number | string | boolean
  timestamp?: string
  quality?: "good" | "uncertain" | "bad"
}

export interface ProjectInfo {
  name: string
}

export type ObjectSummary = {
  id: string
  primaryId: string
  objectTypeId: string
  name: string
  class: string
  properties: Record<string, unknown>
  telemetry: Record<string, TelemetryProperty>
  actions: Record<string, ObjectAction>
  location?: Record<string, string> | string
  telemetryCount: number
  createdAt: string
  updatedAt: string
}

export type ObjectDetail = ObjectSummary

export type TelemetryHistory = {
  objectId: string
  propertyId: string
  range: {
    start: string
    end: string
  }
  data: Array<{
    value: number | string | boolean
    timestamp: string
    quality?: "good" | "uncertain" | "bad"
  }>
}

export interface EventStreamServerMessage {
  type: "connected" | "subscribed" | "unsubscribed" | "error" | "event"
  channel?: string
  message?: string
  topic?: string | null
  afterCursor?: string | null
  types?: string[] | null
  event?: DomainEvent & { readonly cursor: string }
}

export function encodeObjectId(objectTypeId: string, primaryId: string): string {
  return `${encodeURIComponent(objectTypeId)}~${encodeURIComponent(primaryId)}`
}

export function decodeObjectId(objectId: string): {
  objectTypeId: string
  primaryId: string
} | null {
  const separatorIndex = objectId.indexOf("~")
  if (separatorIndex <= 0 || separatorIndex >= objectId.length - 1) {
    return null
  }

  const decodeSegment = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  return {
    objectTypeId: decodeSegment(objectId.slice(0, separatorIndex)),
    primaryId: decodeSegment(objectId.slice(separatorIndex + 1)),
  }
}

function normalizePrimitive(value: unknown): number | string | boolean | undefined {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value
  }
  return undefined
}

function parseLocation(
  properties: Record<string, unknown>
): Record<string, string> | string | undefined {
  const location = properties.location
  if (typeof location === "string") return location

  if (location && typeof location === "object") {
    const entries = Object.entries(location as Record<string, unknown>).filter(
      ([, value]) => typeof value === "string"
    )

    if (entries.length > 0) {
      return Object.fromEntries(entries) as Record<string, string>
    }
  }

  if (typeof properties.zone === "string") {
    return properties.zone
  }

  return undefined
}

function inferPrimitiveType(schema: unknown): "string" | "number" | "boolean" | "fileRef" {
  if (typeof schema === "string") {
    if (schema === "integer" || schema === "double" || schema === "decimal") return "number"
    if (schema === "boolean") return "boolean"
    if (schema === "fileRef") return "fileRef"
    return "string"
  }

  if (!schema || typeof schema !== "object") return "string"
  const type = (schema as { type?: unknown }).type
  if (type === "number" || type === "integer") return "number"
  if (type === "boolean") return "boolean"
  if (type === "fileRef") return "fileRef"
  return "string"
}

function isPrimitiveEnumValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function getEnumValues(schema: unknown): Array<string | number | boolean> | undefined {
  if (!schema || typeof schema !== "object") return undefined

  const enumValues = (schema as { enum?: unknown }).enum
  if (!Array.isArray(enumValues)) return undefined

  const primitiveEnumValues = enumValues.filter(isPrimitiveEnumValue)
  return primitiveEnumValues.length === enumValues.length ? primitiveEnumValues : undefined
}

function mapActionParams(
  action: ObjectTypeDefinition["actions"][number]
): Record<string, ActionParam> {
  const result: Record<string, ActionParam> = {}

  for (const param of action.params ?? []) {
    const enumValues = getEnumValues(param.schema)

    result[param.id] = {
      type: inferPrimitiveType(param.schema),
      required: param.required,
      nullable: param.nullable,
      description: param.description,
      enum: enumValues,
    }
  }

  return result
}

function mapActions(objectType: ObjectTypeDefinition | undefined): Record<string, ObjectAction> {
  if (!objectType) return {}

  const result: Record<string, ObjectAction> = {}
  for (const action of objectType.actions ?? []) {
    result[action.id] = {
      id: action.id,
      description: action.description,
      params: mapActionParams(action),
    }
  }

  return result
}

function mapTelemetryProperties(
  objectType: ObjectTypeDefinition | undefined,
  properties: Record<string, unknown>
): Record<string, TelemetryProperty> {
  if (!objectType) return {}

  const streams = objectType.properties.filter((property) => property.mode === "telemetry")
  const result: Record<string, TelemetryProperty> = {}

  for (const stream of streams) {
    const schemaType =
      stream.schema && typeof stream.schema === "object"
        ? ((stream.schema as { type?: unknown }).type ?? undefined)
        : undefined
    const dataType =
      schemaType === "number" || schemaType === "integer"
        ? "number"
        : schemaType === "boolean"
          ? "boolean"
          : "string"

    result[stream.id] = {
      source: `${objectType.id}.${stream.id}`,
      class: stream.semanticType ?? stream.name,
      dataType,
      currentValue: normalizePrimitive(properties[stream.id]),
      writable: false,
    }
  }

  return result
}

export function toProjectInfo(project: GetProjectInfoResponse): ProjectInfo {
  return {
    name: project.id,
  }
}

export function toObjectSummary(
  object: ObjectListItem,
  objectType: ObjectTypeDefinition | undefined
): ObjectSummary {
  const properties = (object.properties ?? {}) as Record<string, unknown>
  const name =
    typeof properties.name === "string" && properties.name.length > 0
      ? properties.name
      : object.primaryId
  const telemetry = mapTelemetryProperties(objectType, properties)

  return {
    id: encodeObjectId(object.objectTypeId, object.primaryId),
    primaryId: object.primaryId,
    objectTypeId: object.objectTypeId,
    name,
    class: objectType?.id ?? object.objectTypeId,
    properties,
    telemetry,
    actions: mapActions(objectType),
    location: parseLocation(properties),
    telemetryCount: Object.keys(telemetry).length,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  }
}

export function toObjectDetail(
  object: ObjectListItem,
  objectType: ObjectTypeDefinition | undefined
): ObjectDetail {
  return toObjectSummary(object, objectType)
}

export function toTelemetryHistoryWithRange(input: {
  objectId: string
  propertyId: string
  history: GetTelemetryHistoryResponse
  rangeStart: string
  rangeEnd: string
}): TelemetryHistory {
  return {
    objectId: input.objectId,
    propertyId: input.propertyId,
    range: {
      start: input.rangeStart,
      end: input.rangeEnd,
    },
    data: input.history
      .map((sample) => ({
        value: normalizePrimitive(sample.value),
        timestamp: sample.at,
      }))
      .filter(
        (sample): sample is { value: number | string | boolean; timestamp: string } =>
          sample.value !== undefined
      ),
  }
}

export async function executeAction(options: {
  path: {
    objectId: string
    actionId: string
  }
  body: {
    params?: Record<string, unknown>
    runId?: string
  }
}): Promise<{
  data: {
    success: boolean
    runId?: string
    error?: string
  }
}> {
  const parsed = decodeObjectId(options.path.objectId)
  if (!parsed) {
    return {
      data: {
        success: false,
        error: `Invalid object id: ${options.path.objectId}`,
      },
    }
  }

  try {
    const response = await requestAction({
      path: {
        actionId: options.path.actionId,
      },
      body: {
        subject: {
          kind: "object",
          objectTypeId: parsed.objectTypeId,
          primaryId: parsed.primaryId,
        },
        params: options.body.params,
        runId: options.body.runId,
      },
      throwOnError: true,
    })

    return {
      data: {
        success: true,
        runId: response.data.runId,
      },
    }
  } catch (error) {
    return {
      data: {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

export async function executeGlobalAction(options: {
  path: {
    actionId: string
  }
  body: {
    params?: Record<string, unknown>
    runId?: string
  }
}): Promise<{
  data: {
    success: boolean
    runId?: string
    error?: string
  }
}> {
  try {
    const response = await requestAction({
      path: {
        actionId: options.path.actionId,
      },
      body: {
        params: options.body.params,
        runId: options.body.runId,
      },
      throwOnError: true,
    })

    return {
      data: {
        success: true,
        runId: response.data.runId,
      },
    }
  } catch (error) {
    return {
      data: {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
