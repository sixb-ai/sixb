import { describe, expect, test } from "bun:test"
import type {
  AuthorizationContext,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  TelemetryProjectionDefinition,
} from "../src"
import { canViewProjection, canViewProjectionRun, emptyGrantIndex } from "../src/authorization"
import type { ProjectionRunObjectTypes } from "../src/storage"

function authzViewing(...objectTypeIds: string[]): AuthorizationContext {
  return {
    principal: { type: "user", id: "u1" },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "view:object": new Set(objectTypeIds) },
  }
}

const objectProjection: ObjectProjectionDefinition = {
  _tag: "ObjectProjectionDefinition",
  id: "rooms",
  objectTypeId: "room",
  datasetId: "ds",
  properties: {},
  links: {},
}

const telemetryProjection: TelemetryProjectionDefinition = {
  _tag: "TelemetryProjectionDefinition",
  id: "room-temps",
  objectTypeId: "room",
  propertyId: "temperature",
  datasetId: "ds",
  objectIdField: "room_id",
  atField: "at",
  valueField: "value",
}

const linkProjection: LinkProjectionDefinition = {
  _tag: "LinkProjectionDefinition",
  id: "room-sensors",
  linkId: "hasSensors",
  sourceObjectTypeId: "room",
  targetObjectTypeId: "sensor",
  datasetId: "ds",
  sourceField: "room_id",
  targetField: "sensor_id",
}

describe("canViewProjection", () => {
  test("privileged (no authz) sees everything", () => {
    expect(canViewProjection(null, objectProjection)).toBe(true)
    expect(canViewProjection(undefined, linkProjection)).toBe(true)
  })

  test("object and telemetry require viewing their object type", () => {
    expect(canViewProjection(authzViewing("room"), objectProjection)).toBe(true)
    expect(canViewProjection(authzViewing("room"), telemetryProjection)).toBe(true)
    expect(canViewProjection(authzViewing("sensor"), objectProjection)).toBe(false)
  })

  test("links require viewing both ends", () => {
    expect(canViewProjection(authzViewing("room", "sensor"), linkProjection)).toBe(true)
    expect(canViewProjection(authzViewing("room"), linkProjection)).toBe(false)
    expect(canViewProjection(authzViewing("sensor"), linkProjection)).toBe(false)
  })
})

describe("canViewProjectionRun", () => {
  const objectRun: ProjectionRunObjectTypes = { objectTypeId: "room" }
  const linkRun: ProjectionRunObjectTypes = {
    sourceObjectTypeId: "room",
    targetObjectTypeId: "sensor",
  }

  test("checks the object type(s) recorded on the run", () => {
    expect(canViewProjectionRun(authzViewing("room"), objectRun)).toBe(true)
    expect(canViewProjectionRun(authzViewing("sensor"), objectRun)).toBe(false)
    expect(canViewProjectionRun(authzViewing("room", "sensor"), linkRun)).toBe(true)
    expect(canViewProjectionRun(authzViewing("room"), linkRun)).toBe(false)
  })

  test("runs with no recorded object types are hidden from scoped principals", () => {
    expect(canViewProjectionRun(authzViewing("room"), {})).toBe(false)
    expect(canViewProjectionRun(null, {})).toBe(true)
  })
})
