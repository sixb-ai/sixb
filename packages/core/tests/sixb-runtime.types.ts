import {
  defineObjectType,
  defineOntology,
  link,
  type ObjectQueryLinksInput,
  type ObjectQueryLinksResult,
  prop,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("name", "string", { required: true }),
    prop("currentTemperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    }),
  ],
  links: [link.ref("hasThermostat", "Thermostat", { cardinality: "one" })],
})

const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("name", "string", { required: true }),
  ],
})

const Buildings = defineOntology({
  id: "buildings",
  version: "1.0.0",
  objectTypes: [Room, Thermostat],
})

const sixb = createTestSixb({ ontology: [Buildings], ...createTestRuntimeDeps() })

async function contract(): Promise<void> {
  await sixb.objects(Room).upsert({
    properties: {
      id: "room:101",
      externalId: "RM-101",
      name: "Conference 101",
    },
  })

  await sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
    value: 22.4,
    unit: "degreeCelsius",
    at: new Date(),
  })

  const room = await sixb
    .objects(Room)
    .query()
    .where((r) => r.p.externalId.eq("RM-101"))
    .first()

  void room

  const roomQuery = sixb
    .objects(Room)
    .query()
    .where((r) => r.and(r.p.externalId.eq("RM-101"), r.p.name.contains("Conference")))
    .search("conference", { fields: [Room.p.name, Room.p.externalId] })
    .orderBy(Room.p.name, "asc")
    .limit(10)

  void roomQuery.ir

  sixb
    .objects(Room)
    .query()
    .where((r) => r.p.name.eq("Conference 101"))
    .validate()

  sixb.objects(Room).query().search("conference").explain()

  sixb.objects(Room).query().limit(10).formatExplanation()

  const roomsWithTotal = await sixb.objects(Room).query().limit(10).list()
  const _roomsTotal: number = roomsWithTotal.total
  void _roomsTotal

  const roomsWithoutTotal = await sixb.objects(Room).query().limit(10).list({ includeTotal: false })
  const _roomsOmittedTotal: undefined = roomsWithoutTotal.total
  void _roomsOmittedTotal
  // @ts-expect-error includeTotal: false omits total from the result type
  const _roomsMissingTotal: number = roomsWithoutTotal.total
  void _roomsMissingTotal

  const roomCount: number = await sixb.objects(Room).query().count()
  void roomCount

  const roomExists: boolean = await sixb.objects(Room).query().exists()
  void roomExists

  const linkQuery: ObjectQueryLinksInput = {
    query: {
      kind: "refs",
      refs: [{ objectTypeId: Room.id, primaryId: "room:101" }],
    },
    direction: "both",
    includeObjects: true,
  }
  const linkQueryResult: ObjectQueryLinksResult = await sixb.objects.queryLinks(linkQuery)
  void linkQueryResult

  const roomFacets = await sixb
    .objects(Room)
    .query()
    .facets([{ property: Room.p.externalId, limit: 10 }])
  const _facetValue: unknown = roomFacets[0]?.buckets[0]?.value
  const _facetCount: number | undefined = roomFacets[0]?.buckets[0]?.count
  void _facetValue
  void _facetCount

  await sixb
    .objects(Room)
    .query()
    // @ts-expect-error facets accept only property tokens from the current object type
    .facets([{ property: Thermostat.p.externalId, limit: 10 }])

  sixb
    .objects(Room)
    .query()
    // @ts-expect-error search fields accept only property tokens from the current object type
    .search("conference", { fields: [Thermostat.p.name] })

  sixb.objects(Room).list({
    // @ts-expect-error list is storage browsing; use query().where(...).list()
    where: (r) => r.p.name.eq("Conference 101"),
  })

  await sixb
    .objects(Room)
    .query()
    .where((r) =>
      r.and(
        r.p.externalId.eq("RM-101"),
        r.or(r.p.name.contains("Conference"), r.p.name.in(["Conference 101"])),
        r.not(r.p.externalId.neq("RM-404")),
        r.p.currentTemperature.gt(20)
      )
    )
    .first()

  await sixb
    .objects(Room)
    .query()
    // @ts-expect-error contains on string properties requires a string
    .where((r) => r.p.name.contains(123))
    .first()

  await sixb
    .objects(Room)
    .query()
    // @ts-expect-error contains is not valid for numeric properties
    .where((r) => r.p.currentTemperature.contains(22))
    .first()

  const tstatQuery = sixb
    .objects(Room)
    .query()
    .where((r) => r.and(r.p.externalId.eq("RM-101"), r.p.name.contains("Conference")))
    .traverse(Room.l.hasThermostat)
    .where((t) => t.p.externalId.eq("device-123"))

  const tstatFromQuery = await tstatQuery.first()
  const _thermostatObjectTypeId: "Thermostat" | undefined = tstatFromQuery?.objectTypeId
  void _thermostatObjectTypeId

  const tstat = await sixb.objects(Thermostat).upsert({
    properties: {
      id: "tstat:abc",
      externalId: "device-123",
      name: "Tstat 101",
    },
  })

  await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

  await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, {
    // @ts-expect-error hasThermostat must point to Thermostat
    objectTypeId: "Room",
    primaryId: "room:999",
  })

  // @ts-expect-error non-telemetry properties are not valid telemetry tokens
  sixb.objects(Room).byId("room:101").telemetry(Room.p.name)

  await sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
    // @ts-expect-error currentTemperature expects numeric values
    value: "hot",
    unit: "degreeCelsius",
    at: new Date(),
  })
}

void contract
