import { afterEach, describe, expect, test } from "bun:test"
import type { AceIotGateway } from "../src"
import { parseAceIotTimestamp } from "../src"
import { captureFetch, createTestClient, page } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const GATEWAY: AceIotGateway = {
  name: "acme_gw_0001",
  site: "acme_south_campus",
  client: "acme",
  hw_type: null,
  software_type: null,
  primary_mac: "02-00-00-00-00-01",
  vpn_ip: "100.64.0.1",
  device_token: "example-gateway-token",
  // Space-separated, unlike every other ACE timestamp.
  device_token_expires: "2027-03-04 19:34:54.114795",
  interfaces: { discovered_interfaces: { enp1s0: {} } },
  deploy_config: { hostname: "acme-south-campus", enable_collection: true },
  archived: false,
  updated: "2026-07-21T12:11:27.817913",
}

describe("gateways", () => {
  test("list forwards show_archived and returns the gateway shape", async () => {
    const { urls } = captureFetch(page([GATEWAY], { per_page: 100, total: 5 }))
    const ace = await createTestClient()

    const result = await ace.gateways.list({ perPage: 100, showArchived: true })

    expect(urls[0].pathname).toBe("/api/gateways/")
    expect(urls[0].searchParams.get("show_archived")).toBe("true")
    expect(result.items[0]).toEqual(GATEWAY)
    expect(result.items[0].interfaces).toEqual({ discovered_interfaces: { enp1s0: {} } })
  })

  test("the gateway token expiry parses despite its space-separated format", () => {
    expect(parseAceIotTimestamp(GATEWAY.device_token_expires as string).toISOString()).toBe(
      "2027-03-04T19:34:54.114Z"
    )
  })

  test("update uses PATCH", async () => {
    const { urls, inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.gateways.update("gw-1", { archived: true })

    expect(inits[0].method).toBe("PATCH")
    expect(urls[0].pathname).toBe("/api/gateways/gw-1")
    expect(JSON.parse(String(inits[0].body))).toEqual({ archived: true })
  })

  test("createToken posts to the token route", async () => {
    const { urls, inits } = captureFetch({ auth_token: "token-value" })
    const ace = await createTestClient()

    const token = await ace.gateways.createToken("gw-1")

    expect(inits[0].method).toBe("POST")
    expect(urls[0].pathname).toBe("/api/gateways/gw-1/token")
    expect(token.auth_token).toBe("token-value")
  })

  test("agent config listing forwards identity, active, and hash encoding", async () => {
    const { urls } = captureFetch(page([]))
    const ace = await createTestClient()

    await ace.gateways.listAgentConfigs("gw-1", {
      perPage: 10,
      agentIdentity: "platform.driver",
      active: false,
      useBase64Hash: true,
    })

    expect(urls[0].pathname).toBe("/api/gateways/gw-1/agent_configs")
    expect(urls[0].searchParams.get("agent_identity")).toBe("platform.driver")
    expect(urls[0].searchParams.get("active")).toBe("false")
    expect(urls[0].searchParams.get("use_base64_hash")).toBe("true")
  })

  test("agent configs and volttron agents post under their own envelopes", async () => {
    const { inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.gateways.createAgentConfigs("gw-1", [
      { agent_identity: "platform.driver", blob: "{}", active: true },
    ])
    await ace.gateways.createVolttronAgents("gw-1", [
      { identity: "platform.driver", package_name: "driver", active: true },
    ])

    expect(JSON.parse(String(inits[0].body))).toEqual({
      agent_configs: [{ agent_identity: "platform.driver", blob: "{}", active: true }],
    })
    expect(JSON.parse(String(inits[1].body))).toEqual({
      volttron_agents: [{ identity: "platform.driver", package_name: "driver", active: true }],
    })
  })

  test("hawke routes nest the agent identity in the path", async () => {
    const { urls, inits } = captureFetch(page([]))
    const ace = await createTestClient()

    await ace.gateways.listHawkeConfigurations("gw-1", { perPage: 10, hash: "abc" })
    await ace.gateways.getHawkeAgentConfiguration("gw-1", "hawke.one", { useBase64Hash: true })
    await ace.gateways.listHawkeAgentConfigurations("gw-1", "hawke.one", { perPage: 10 })
    await ace.gateways.setHawkeAgentConfiguration("gw-1", "hawke.one", { content_blob: "{}" })
    await ace.gateways.createHawkeConfigurations("gw-1", [
      { hawke_identity: "hawke.one", content_blob: "{}" },
    ])

    expect(urls[0].pathname).toBe("/api/gateways/gw-1/hawke_configuration")
    expect(urls[0].searchParams.get("hash")).toBe("abc")
    expect(urls[1].pathname).toBe("/api/gateways/gw-1/hawke_configuration/hawke.one")
    expect(urls[1].searchParams.get("use_base64_hash")).toBe("true")
    expect(urls[2].pathname).toBe("/api/gateways/gw-1/hawke_configuration/hawke.one/list")
    expect(JSON.parse(String(inits[3].body))).toEqual({ content_blob: "{}" })
    expect(JSON.parse(String(inits[4].body))).toEqual({
      hawke_agents: [{ hawke_identity: "hawke.one", content_blob: "{}" }],
    })
  })

  test("the combined agent/config/package route takes the identity as a query parameter", async () => {
    const { urls, inits } = captureFetch({
      volttron_agent_package: {},
      volttron_agent: {},
      agent_config: {},
    })
    const ace = await createTestClient()

    await ace.gateways.getVolttronAgentConfigPackage("gw-1", "platform.driver", {
      useAgentConfigBase64Hash: true,
    })
    await ace.gateways.createVolttronAgentConfigPackage("gw-1", {
      volttron_agent: { identity: "platform.driver" },
      agent_config: { agent_identity: "platform.driver", blob: "{}" },
    })

    expect(urls[0].pathname).toBe("/api/gateways/gw-1/volttron_agent_config_package")
    expect(urls[0].searchParams.get("volttron_agent_identity")).toBe("platform.driver")
    expect(urls[0].searchParams.get("use_agent_config_base64_hash")).toBe("true")
    expect(JSON.parse(String(inits[1].body))).toEqual({
      volttron_agent: { identity: "platform.driver" },
      agent_config: { agent_identity: "platform.driver", blob: "{}" },
    })
  })

  test("pcap listing requires a time range and returns file names", async () => {
    const { urls } = captureFetch(page(["capture-1.pcap"], { pages: null }))
    const ace = await createTestClient()

    const result = await ace.gateways.listPcapFiles("gw-1", {
      perPage: 10,
      startTime: "2026-08-01T00:00:00Z",
      endTime: "2026-08-07T00:00:00Z",
    })

    expect(urls[0].pathname).toBe("/api/gateways/gw-1/pcap/list")
    expect(urls[0].searchParams.get("start_time")).toBe("2026-08-01T00:00:00Z")
    expect(result.items).toEqual(["capture-1.pcap"])
    expect(result.pages).toBeNull()
  })

  test("pcap download and upload use the file routes", async () => {
    const { urls, inits } = captureFetch(undefined)
    const ace = await createTestClient()

    await ace.gateways.downloadPcap("gw-1", "capture-1.pcap")
    await ace.gateways.uploadPcap("gw-1", new File(["bytes"], "capture-2.pcap"))

    expect(urls[0].pathname).toBe("/api/gateways/gw-1/pcap")
    expect(urls[0].searchParams.get("file_name")).toBe("capture-1.pcap")
    expect(inits[1].method).toBe("POST")
    expect(((inits[1].body as FormData).get("file") as File).name).toBe("capture-2.pcap")
  })

  test("gateway der events forward their filters", async () => {
    const { urls } = captureFetch(page([]))
    const ace = await createTestClient()

    await ace.gateways.listDerEvents("gw-1", { perPage: 10, getPastEvents: true })

    expect(urls[0].pathname).toBe("/api/gateways/gw-1/der_events")
    expect(urls[0].searchParams.get("get_past_events")).toBe("true")
  })
})
