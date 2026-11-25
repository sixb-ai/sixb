import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  link,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { createTestingScope } from "../src/execution/scopes"
import type { AppliedMarkings } from "../src/security/applied-markings"
import { appliedLinkKey } from "../src/security/applied-markings-snapshot"
import { exportSnapshot, hostSnapshotSource } from "../src/snapshots"
import { createTestSixb } from "../src/testing"
import { readAll } from "./helpers/snapshot-desk"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// What a snapshot leaves in production besides objects and properties: links to a type the person
// cannot read, links a marking seals, and the telemetry a marking hides.

const projectId = "snapshot-boundaries"
const sealed = defineMarking("sealed")

const Vault = defineObjectType({
  id: "vault",
  name: "Vault",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const Site = defineObjectType({
  id: "site",
  name: "Site",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const Sensor = defineObjectType({
  id: "sensor",
  name: "Sensor",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
    prop("pressure", "double", { mode: "telemetry", semanticType: "Pressure" }),
  ],
  links: [
    link("site", Site, { cardinality: "one" }),
    link("backup", Site, { cardinality: "one" }),
    link("vault", Vault, { cardinality: "one" }),
  ],
})

const operators = defineGroup("operators")
const roles = [
  defineRole("operators", { grantedTo: [operators], grants: [can.view([Sensor, Site])] }),
]

/**
 * Applied markings in which a projection's version marks the sensor's pressure, and a link
 * projection's version seals `sensor.backup`.
 */
const backupSealed: AppliedMarkings = {
  affects: (clearances) => !clearances.has(sealed.id),
  current: async () => ({
    properties: new Map([[Sensor.id, new Map([["pressure", new Set([sealed.id])]])]]),
    types: new Map(),
    links: new Map([
      [
        appliedLinkKey(Sensor.id, "backup"),
        {
          objectTypeId: Sensor.id,
          linkId: "backup",
          targetObjectTypeId: Site.id,
          seals: [
            { projectionId: "backups", markings: new Set([sealed.id]), reason: "column 'site'" },
          ],
        },
      ],
    ]),
    markings: new Set([sealed.id]),
    notices: [],
  }),
  invalidate: () => {},
  forEventOrigin: async (snapshot) => snapshot,
  forEarlierValues: (snapshot) => snapshot,
}

async function operatorSnapshot() {
  const host = new SixbHost({
    id: projectId,
    ontology: [Vault, Site, Sensor],
    markings: [sealed],
    groups: [operators],
    roles,
    ...createTestRuntimeDeps(),
  })
  const trusted = createTestSixb(host)
  await host.storage.auth?.users.create({ projectId, id: "usr_ops", email: "ops@example.com" })

  await trusted.objects(Site).upsert({ properties: { id: "site-1" } })
  await trusted.objects(Vault).upsert({ properties: { id: "vault-1" } })
  await trusted.objects(Sensor).upsert({ properties: { id: "sensor-1" } })
  const sensor = trusted.objects(Sensor).byId("sensor-1")
  await sensor.link(Sensor.l.site, { objectTypeId: Site.id, primaryId: "site-1" })
  await sensor.link(Sensor.l.backup, { objectTypeId: Site.id, primaryId: "site-1" })
  await sensor.link(Sensor.l.vault, { objectTypeId: Vault.id, primaryId: "vault-1" })
  const at = new Date("2026-11-25T10:00:00.000Z")
  await sensor.telemetry(Sensor.p.temperature).append({ value: 21, unit: "degreeCelsius", at })
  await sensor.telemetry(Sensor.p.pressure).append({ value: 990, unit: "hectopascal", at })

  const scope = createTestingScope({
    projectId,
    context: resolveAuthorizationContext({
      principal: { type: "user", id: "usr_ops" },
      groupIds: [operators.id],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
  const { records } = await readAll(
    exportSnapshot({ ...hostSnapshotSource(host), appliedMarkings: backupSealed }, { scope })
  )
  return records
}

describe("a snapshot leaves in production", () => {
  // Reproduce: in AuthorizedObjectReader's snapshotPage, pass every type as
  // `endpointObjectTypeIds`, and drop the target type check of `isLinkViewable` (the first is
  // only the storage's filter, the second the guard): the link to the vault leaves.
  // Reproduce: drop the `unreadableLink` check of `isLinkViewable`: the sealed backup leaves.
  test("the links to a type the person cannot read, and the links a marking seals", async () => {
    const links = (await operatorSnapshot()).flatMap((record) =>
      record.kind === "links" ? record.rows.map((row) => `${row[1]}:${row[3]}`) : []
    )

    expect(links).toEqual(["site:site-1"])
  })

  // Reproduce: in readPoints, keep every latest point the storage returns (drop `visible`): the
  // sealed pressure leaves.
  test("the telemetry a marking hides", async () => {
    const points = (await operatorSnapshot()).flatMap((record) =>
      record.kind === "points" ? record.rows.map((row) => `${row[1]}=${row[2]}`) : []
    )

    expect(points).toEqual(["temperature=21"])
  })
})
