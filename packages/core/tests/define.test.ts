import { describe, expect, test } from "bun:test"
import type { ArraySchema, MapSchema, ObjectSchema } from "../src/ontology"
import {
  defineInterface,
  defineObjectType,
  defineOntology,
  defineValueType,
  integerEnum,
  link,
  prop,
  stringEnum,
} from "../src/ontology"

// ── defineObjectType ────────────────────────────────────────

describe("defineObjectType", () => {
  test("defaults properties and links to empty arrays", () => {
    const ot = defineObjectType({
      id: "room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    expect(ot.properties).toHaveLength(1)
    expect(ot.links).toEqual([])
  })

  test("preserves provided properties and links", () => {
    const ot = defineObjectType({
      id: "thermostat",
      name: "Thermostat",
      properties: [prop("id", "string", { required: true, primary: true }), prop("mode", "string")],
      links: [link("controls", "hvacZone")],
    })
    expect(ot.properties).toHaveLength(2)
    expect(ot.links).toHaveLength(1)
  })

  test("passes through optional fields", () => {
    const ot = defineObjectType({
      id: "sensor",
      name: "Sensor",
      description: "A generic sensor",
      implements: ["measurable"],
      properties: [prop("id", "string", { required: true, primary: true })],
      search: { title: "id", exact: ["id"] },
    })
    expect(ot.description).toBe("A generic sensor")
    expect(ot.implements).toEqual(["measurable"])
    expect(ot.search).toEqual({ title: "id", exact: ["id"] })
  })
})

// ── defineOntology ──────────────────────────────────────────

describe("defineOntology", () => {
  test("defaults objectTypes, valueTypes, and interfaces to empty arrays", () => {
    const ontology = defineOntology({ id: "hvac", version: "1.0.0" })
    expect(ontology.objectTypes).toEqual([])
    expect(ontology.valueTypes).toEqual([])
    expect(ontology.interfaces).toEqual([])
  })

  test("preserves provided collections", () => {
    const room = defineObjectType({
      id: "room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const reading = defineValueType({
      id: "temperatureReading",
      name: "Temperature Reading",
      schema: "double",
      semanticType: "Temperature",
    })
    const measurable = defineInterface({ id: "measurable", name: "Measurable" })

    const ontology = defineOntology({
      id: "hvac",
      version: "1.1.0",
      objectTypes: [room],
      valueTypes: [reading],
      interfaces: [measurable],
    })

    expect(ontology.id).toBe("hvac")
    expect(ontology.version).toBe("1.1.0")
    expect(ontology.objectTypes).toHaveLength(1)
    expect(ontology.valueTypes).toHaveLength(1)
    expect(ontology.interfaces).toHaveLength(1)
  })
})

// ── defineValueType ─────────────────────────────────────────

describe("defineValueType", () => {
  test("returns the input unchanged", () => {
    const vt = defineValueType({
      id: "temperatureReading",
      name: "Temperature Reading",
      schema: "double",
      semanticType: "Temperature",
    })
    expect(vt.id).toBe("temperatureReading")
    expect(vt.schema).toBe("double")
    expect(vt.semanticType).toBe("Temperature")
  })
})

// ── defineInterface ─────────────────────────────────────────

describe("defineInterface", () => {
  test("defaults properties and links to empty arrays", () => {
    const iface = defineInterface({ id: "controllable", name: "Controllable" })
    expect(iface.properties).toEqual([])
    expect(iface.links).toEqual([])
  })
})

// ── prop ────────────────────────────────────────────────────

describe("prop", () => {
  test("uses id as default name", () => {
    const p = prop("serialNumber", "string")
    expect(p.id).toBe("serialNumber")
    expect(p.name).toBe("serialNumber")
  })

  test("allows overriding name", () => {
    const p = prop("currentTemp", "double", { name: "Current Temperature" })
    expect(p.name).toBe("Current Temperature")
  })

  test("passes through all options", () => {
    const p = prop("temperature", "double", {
      description: "Current reading",
      required: true,
      nullable: false,
      semanticType: "Temperature",
      query: { searchable: true, filterable: true, sortable: true },
    })
    expect(p.required).toBe(true)
    expect(p.nullable).toBe(false)
    expect(p.semanticType).toBe("Temperature")
    expect(p.description).toBe("Current reading")
    expect(p.query).toEqual({ searchable: true, filterable: true, sortable: true })
  })
})

// ── link ────────────────────────────────────────────────────

describe("link", () => {
  test("uses id as default name", () => {
    const l = link("locatedIn", "space")
    expect(l.id).toBe("locatedIn")
    expect(l.name).toBe("locatedIn")
    expect(l.targetObjectTypeId).toBe("space")
  })

  test("accepts cardinality and other options", () => {
    const l = link("contains", "room", {
      name: "Contains",
      cardinality: "many",
      description: "Rooms in this building",
    })
    expect(l.name).toBe("Contains")
    expect(l.cardinality).toBe("many")
    expect(l.description).toBe("Rooms in this building")
  })

  // ── Wildcard ────────────────────────────────────────────────

  test("wildcard: no target defaults to '*'", () => {
    const l = link("assignedTo")
    expect(l.id).toBe("assignedTo")
    expect(l.name).toBe("assignedTo")
    expect(l.targetObjectTypeId).toBe("*")
  })

  test("wildcard with options", () => {
    const l = link("assignedTo", { cardinality: "one", description: "Assigned entity" })
    expect(l.targetObjectTypeId).toBe("*")
    expect(l.cardinality).toBe("one")
    expect(l.description).toBe("Assigned entity")
  })

  test("wildcard with name override", () => {
    const l = link("assignedTo", { name: "Assigned To" })
    expect(l.targetObjectTypeId).toBe("*")
    expect(l.name).toBe("Assigned To")
  })

  // ── ObjectType target ──────────────────────────────────────

  test("single ObjectType target extracts id", () => {
    const Room = defineObjectType({
      id: "room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const l = link("locatedIn", Room)
    expect(l.id).toBe("locatedIn")
    expect(l.targetObjectTypeId).toBe("room")
    expect(l.name).toBe("locatedIn")
  })

  test("single ObjectType target with options", () => {
    const Room = defineObjectType({
      id: "room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const l = link("locatedIn", Room, { cardinality: "one" })
    expect(l.targetObjectTypeId).toBe("room")
    expect(l.cardinality).toBe("one")
  })

  test("ObjectType array target extracts ids", () => {
    const Room = defineObjectType({
      id: "room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const Floor = defineObjectType({
      id: "floor",
      name: "Floor",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const l = link("locatedIn", [Room, Floor])
    expect(l.targetObjectTypeId).toEqual(["room", "floor"])
  })

  test("ObjectType array target with options", () => {
    const Room = defineObjectType({
      id: "room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const Floor = defineObjectType({
      id: "floor",
      name: "Floor",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const l = link("locatedIn", [Room, Floor], { cardinality: "many" })
    expect(l.targetObjectTypeId).toEqual(["room", "floor"])
    expect(l.cardinality).toBe("many")
  })

  // ── Backward compatibility ─────────────────────────────────

  test("backward compat: string target", () => {
    const l = link("locatedIn", "space")
    expect(l.targetObjectTypeId).toBe("space")
  })

  test("backward compat: string target with options", () => {
    const l = link("locatedIn", "space", { cardinality: "one" })
    expect(l.targetObjectTypeId).toBe("space")
    expect(l.cardinality).toBe("one")
  })

  test("backward compat: string array target", () => {
    const l = link("controls", ["thermostat", "valve"])
    expect(l.targetObjectTypeId).toEqual(["thermostat", "valve"])
  })

  test("backward compat: explicit wildcard string", () => {
    const l = link("anything", "*")
    expect(l.targetObjectTypeId).toBe("*")
  })
})

// ── enum helpers ────────────────────────────────────────────

describe("stringEnum", () => {
  test("creates a string enum schema", () => {
    const e = stringEnum(["off", "heat", "cool", "auto"])
    expect(e.type).toBe("enum")
    expect(e.valueType).toBe("string")
    expect(e.values).toEqual(["off", "heat", "cool", "auto"])
  })
})

describe("integerEnum", () => {
  test("creates an integer enum schema", () => {
    const e = integerEnum([1, 2, 3])
    expect(e.type).toBe("enum")
    expect(e.valueType).toBe("integer")
    expect(e.values).toEqual([1, 2, 3])
  })
})

// ── Complex schemas in properties ───────────────────────────

describe("nested object schemas", () => {
  test("prop with inline object schema", () => {
    const p = prop("temperatureRange", {
      type: "object",
      properties: {
        min: { required: true, schema: "double", semanticType: "Temperature" },
        max: { required: true, schema: "double", semanticType: "Temperature" },
      },
    })
    const schema = p.schema as ObjectSchema
    expect(schema.type).toBe("object")
    expect(schema.properties.min.semanticType).toBe("Temperature")
    expect(schema.properties.max.required).toBe(true)
  })

  test("prop with array schema", () => {
    const p = prop("faultCodes", { type: "array", items: "string" })
    const schema = p.schema as ArraySchema
    expect(schema.type).toBe("array")
    expect(schema.items).toBe("string")
  })

  test("prop with map schema", () => {
    const p = prop("metadata", {
      type: "map",
      keySchema: "string",
      valueSchema: "string",
    })
    const schema = p.schema as MapSchema
    expect(schema.type).toBe("map")
    expect(schema.keySchema).toBe("string")
    expect(schema.valueSchema).toBe("string")
  })

  test("prop with valueTypeRef schema", () => {
    const p = prop("reading", { type: "valueTypeRef", valueTypeId: "temperatureReading" })
    expect(p.schema).toEqual({ type: "valueTypeRef", valueTypeId: "temperatureReading" })
  })

  test("deeply nested: array of objects with enums", () => {
    const p = prop("schedule", {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: {
            required: true,
            schema: stringEnum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
          },
          setpoint: {
            required: true,
            schema: "double",
            semanticType: "Temperature",
          },
          fanSpeed: {
            schema: integerEnum([1, 2, 3, 4, 5]),
          },
        },
      },
    })
    const arr = p.schema as ArraySchema
    const obj = arr.items as ObjectSchema
    expect(obj.properties.day.required).toBe(true)
    expect(obj.properties.day.schema).toEqual({
      type: "enum",
      valueType: "string",
      values: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    })
    expect(obj.properties.setpoint.semanticType).toBe("Temperature")
    expect(obj.properties.fanSpeed.schema).toEqual({
      type: "enum",
      valueType: "integer",
      values: [1, 2, 3, 4, 5],
    })
  })

  test("map with nested object values", () => {
    const p = prop("phaseReadings", {
      type: "map",
      keySchema: "string",
      valueSchema: {
        type: "object",
        properties: {
          voltage: { required: true, schema: "double", semanticType: "Voltage" },
          current: { required: true, schema: "double", semanticType: "Current" },
        },
      },
    })
    const map = p.schema as MapSchema
    const valueObj = map.valueSchema as ObjectSchema
    expect(valueObj.properties.voltage.semanticType).toBe("Voltage")
    expect(valueObj.properties.current.semanticType).toBe("Current")
  })
})

// ── Links with properties ───────────────────────────────────

describe("links with properties", () => {
  test("link carries metadata properties", () => {
    const l = link("installedIn", "room", {
      name: "Installed In",
      cardinality: "one",
      properties: [
        prop("installedAt", "timestamp", { required: true }),
        prop("commissionedBy", "string"),
        prop("confidence", "double", {
          semanticType: "Concentration",
          description: "Installation confidence score",
        }),
      ],
    })
    expect(l.properties).toHaveLength(3)
    expect(l.properties![0].id).toBe("installedAt")
    expect(l.properties![0].schema).toBe("timestamp")
    expect(l.properties![0].required).toBe(true)
    expect(l.properties![2].semanticType).toBe("Concentration")
  })
})

// ── Interface with properties and links ─────────────────────

describe("interface composition", () => {
  test("defines a full interface with properties and links", () => {
    const sensor = defineInterface({
      id: "sensor",
      name: "Sensor",
      description: "Base contract for all sensors",
      properties: [
        prop("manufacturer", "string", { required: true }),
        prop("model", "string", { required: true }),
        prop("serialNumber", "string"),
        prop("firmwareVersion", "string", { nullable: true }),
      ],
      links: [link("locatedIn", "space", { cardinality: "one" })],
    })
    expect(sensor.properties).toHaveLength(4)
    expect(sensor.links).toHaveLength(1)
    expect(sensor.properties[0].required).toBe(true)
    expect(sensor.properties[3].nullable).toBe(true)
    expect(sensor.links[0].targetObjectTypeId).toBe("space")
  })
})

// ── ValueType with complex schemas ──────────────────────────

describe("value type with complex schemas", () => {
  test("value type with object schema", () => {
    const vt = defineValueType({
      id: "geoCoordinate",
      name: "Geographic Coordinate",
      schema: {
        type: "object",
        properties: {
          latitude: { required: true, schema: "double", semanticType: "Latitude" },
          longitude: { required: true, schema: "double", semanticType: "Longitude" },
          altitude: { schema: "double", semanticType: "Length" },
        },
      },
    })
    const schema = vt.schema as ObjectSchema
    expect(Object.keys(schema.properties)).toEqual(["latitude", "longitude", "altitude"])
    expect(schema.properties.altitude.required).toBeUndefined()
    expect(schema.properties.altitude.semanticType).toBe("Length")
  })

  test("value type with enum schema", () => {
    const vt = defineValueType({
      id: "hvacMode",
      name: "HVAC Mode",
      schema: stringEnum(["off", "heat", "cool", "auto", "fan_only", "dry"]),
    })
    expect(vt.schema).toEqual({
      type: "enum",
      valueType: "string",
      values: ["off", "heat", "cool", "auto", "fan_only", "dry"],
    })
  })
})

// ── Realistic full ontology ─────────────────────────────────

describe("realistic ontology", () => {
  test("HVAC system with buildings, rooms, and thermostats", () => {
    const temperatureReading = defineValueType({
      id: "temperatureReading",
      name: "Temperature Reading",
      schema: "double",
      semanticType: "Temperature",
    })

    const building = defineObjectType({
      id: "building",
      name: "Building",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { required: true }),
        prop("address", "string"),
        prop("floorCount", "integer"),
        prop("totalArea", "double", { semanticType: "Area" }),
      ],
      links: [link("contains", "floor", { cardinality: "many" })],
    })

    const floor = defineObjectType({
      id: "floor",
      name: "Floor",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("level", "integer", { required: true }),
        prop("area", "double", { semanticType: "Area" }),
      ],
      links: [
        link("contains", "room", { cardinality: "many" }),
        link("partOf", "building", { cardinality: "one" }),
      ],
    })

    const room = defineObjectType({
      id: "room",
      name: "Room",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { required: true }),
        prop("area", "double", { semanticType: "Area" }),
        prop("currentTemperature", { type: "valueTypeRef", valueTypeId: "temperatureReading" }),
        prop("occupancy", "boolean"),
      ],
      links: [
        link("partOf", "floor", { cardinality: "one" }),
        link("hasThermostat", "thermostat", { cardinality: "one" }),
      ],
    })

    const thermostat = defineObjectType({
      id: "thermostat",
      name: "Thermostat",
      description: "Smart thermostat with temperature control",
      implements: ["sensor", "controllable"],
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("currentTemperature", "double", {
          name: "Current Temperature",
          semanticType: "Temperature",
          required: true,
        }),
        prop("targetTemperature", "double", {
          name: "Target Temperature",
          semanticType: "Temperature",
        }),
        prop("mode", stringEnum(["off", "heat", "cool", "auto"]), { required: true }),
        prop("fanSpeed", integerEnum([0, 1, 2, 3]), { name: "Fan Speed" }),
        prop("humidity", "double", { semanticType: "RelativeHumidity" }),
      ],
      links: [link("controls", "room", { cardinality: "one" })],
    })

    // Verify the full graph
    expect(building.links[0].targetObjectTypeId).toBe("floor")
    expect(floor.links[0].targetObjectTypeId).toBe("room")
    expect(room.links[1].targetObjectTypeId).toBe("thermostat")
    expect(thermostat.links[0].targetObjectTypeId).toBe("room")

    // Verify thermostat shape
    expect(thermostat.implements).toEqual(["sensor", "controllable"])
    expect(thermostat.properties).toHaveLength(6)
    expect(thermostat.properties[1].semanticType).toBe("Temperature")
    expect(thermostat.properties[3].schema).toEqual({
      type: "enum",
      valueType: "string",
      values: ["off", "heat", "cool", "auto"],
    })

    // Verify room references the value type
    const roomTempProp = room.properties.find((p) => p.id === "currentTemperature")!
    expect(roomTempProp.schema).toEqual({
      type: "valueTypeRef",
      valueTypeId: "temperatureReading",
    })

    // Verify value type
    expect(temperatureReading.semanticType).toBe("Temperature")
  })

  test("electrical metering with nested telemetry", () => {
    const meter = defineObjectType({
      id: "electricMeter",
      name: "Electric Meter",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("model", "string", { required: true }),
        prop("phases", {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { required: true, schema: "string" },
              voltage: { required: true, schema: "double", semanticType: "Voltage" },
              current: { required: true, schema: "double", semanticType: "Current" },
              power: { required: true, schema: "double", semanticType: "Power" },
              powerFactor: { schema: "double" },
            },
          },
        }),
        prop("totalEnergy", "double", { semanticType: "Energy", required: true }),
        prop("alarms", {
          type: "map",
          keySchema: "string",
          valueSchema: {
            type: "object",
            properties: {
              severity: {
                required: true,
                schema: stringEnum(["info", "warning", "critical"]),
              },
              triggeredAt: { required: true, schema: "timestamp" },
              acknowledged: { schema: "boolean" },
            },
          },
        }),
      ],
    })

    expect(meter.properties).toHaveLength(5)
    expect(meter.links).toEqual([])

    // Verify phases array → object structure
    const phases = meter.properties[2].schema as ArraySchema
    expect(phases.type).toBe("array")
    const phaseObj = phases.items as ObjectSchema
    expect(Object.keys(phaseObj.properties)).toEqual([
      "id",
      "voltage",
      "current",
      "power",
      "powerFactor",
    ])
    expect(phaseObj.properties.voltage.semanticType).toBe("Voltage")
    expect(phaseObj.properties.power.semanticType).toBe("Power")

    // Verify alarms map → object structure
    const alarms = meter.properties[4].schema as MapSchema
    expect(alarms.type).toBe("map")
    const alarmObj = alarms.valueSchema as ObjectSchema
    expect(alarmObj.properties.severity.schema).toEqual({
      type: "enum",
      valueType: "string",
      values: ["info", "warning", "critical"],
    })
  })

  test("object types implementing shared interfaces", () => {
    const measurable = defineInterface({
      id: "measurable",
      name: "Measurable",
      properties: [
        prop("lastObservedAt", "timestamp"),
        prop("dataQuality", stringEnum(["good", "uncertain", "bad"]), { nullable: true }),
      ],
      links: [],
    })

    const tempSensor = defineObjectType({
      id: "temperatureSensor",
      name: "Temperature Sensor",
      implements: [measurable.id],
      properties: [
        prop("id", "string", { required: true, primary: true }),
        ...measurable.properties,
        prop("temperature", "double", { semanticType: "Temperature", required: true }),
        prop("accuracy", "double", { semanticType: "Temperature" }),
      ],
      links: [link("locatedIn", "room", { cardinality: "one" })],
    })

    const co2Sensor = defineObjectType({
      id: "co2Sensor",
      name: "CO2 Sensor",
      implements: [measurable.id],
      properties: [
        prop("id", "string", { required: true, primary: true }),
        ...measurable.properties,
        prop("concentration", "double", { semanticType: "Concentration", required: true }),
      ],
      links: [link("locatedIn", "room", { cardinality: "one" })],
    })

    // Both implement measurable
    expect(tempSensor.implements).toEqual(["measurable"])
    expect(co2Sensor.implements).toEqual(["measurable"])

    // Both inherit measurable's properties (after id)
    expect(tempSensor.properties[1].id).toBe("lastObservedAt")
    expect(tempSensor.properties[2].id).toBe("dataQuality")
    expect(co2Sensor.properties[1].id).toBe("lastObservedAt")

    // Each has its own domain properties
    expect(tempSensor.properties[3].id).toBe("temperature")
    expect(tempSensor.properties[3].semanticType).toBe("Temperature")
    expect(co2Sensor.properties[3].id).toBe("concentration")
    expect(co2Sensor.properties[3].semanticType).toBe("Concentration")
  })
})

// ── Property mode ───────────────────────────────────────────

describe("property mode", () => {
  test("mode defaults to undefined (treated as static)", () => {
    const p = prop("serialNumber", "string")
    expect(p.mode).toBeUndefined()
  })

  test("mode can be set to telemetry", () => {
    const p = prop("currentTemperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    })
    expect(p.mode).toBe("telemetry")
    expect(p.semanticType).toBe("Temperature")
  })

  test("mode can be explicitly set to static", () => {
    const p = prop("manufacturer", "string", { mode: "static" })
    expect(p.mode).toBe("static")
  })
})

// ── Property primary ────────────────────────────────────────

describe("property primary", () => {
  test("primary defaults to undefined", () => {
    const p = prop("serialNumber", "string")
    expect(p.primary).toBeUndefined()
  })

  test("primary can be set to true", () => {
    const p = prop("externalId", "string", { primary: true })
    expect(p.primary).toBe(true)
  })

  test("primary coexists with other options", () => {
    const p = prop("externalId", "string", {
      name: "External ID",
      primary: true,
      required: true,
      description: "Unique external identifier",
    })
    expect(p.primary).toBe(true)
    expect(p.required).toBe(true)
    expect(p.name).toBe("External ID")
    expect(p.description).toBe("Unique external identifier")
  })
})
