import type { RestClient } from "@sixb/connector-rest"
import { DeviceStatusSchema, GroupResponseSchema, TEMPERATURE_UNAVAILABLE } from "./schema"
import type { ControlParameters, DeviceGroup, DeviceListItem, DeviceStatus } from "./types"

export { TEMPERATURE_UNAVAILABLE }

/**
 * Typed facade over the Panasonic Comfort Cloud REST API.
 *
 * Uses a `RestClient` (provided by the `rest()` connector) for all HTTP calls.
 * The transport layer handles headers, retry, rate-limiting, and 401 refresh.
 * This service handles endpoint mapping, response parsing, and domain errors.
 */
export class PanasonicApiService {
  constructor(private readonly client: RestClient) {}

  /**
   * Get all device groups and their devices.
   */
  async getDeviceGroups(): Promise<DeviceGroup[]> {
    const response = await this.client.request("/device/group")
    const data = await this.parseResponse(response, "getDeviceGroups")

    const result = GroupResponseSchema.safeParse(data)
    if (!result.success) {
      const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")
      console.warn(`[Panasonic] Response validation warning for /device/group: ${errors}`)
    }

    interface ApiDeviceGroup {
      groupId: number
      groupName: string
      deviceList?: DeviceListItem[]
    }

    const groupList: ApiDeviceGroup[] = (data as { groupList?: ApiDeviceGroup[] }).groupList ?? []

    return groupList.map((group) => ({
      groupId: group.groupId,
      groupName: group.groupName,
      devices: group.deviceList ?? [],
    }))
  }

  /**
   * Get the current status of a device.
   */
  async getDeviceStatus(deviceGuid: string): Promise<DeviceStatus> {
    const response = await this.client.request(`/deviceStatus/${deviceGuid}`)
    const data = await this.parseResponse(response, `getDeviceStatus(${deviceGuid.slice(0, 8)}...)`)

    const result = DeviceStatusSchema.safeParse(data)
    if (!result.success) {
      const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")
      console.warn(
        `[Panasonic] Response validation warning for /deviceStatus/${deviceGuid.slice(0, 8)}...: ${errors}`
      )
    }

    return data as DeviceStatus
  }

  /**
   * Set device control parameters.
   */
  async setDeviceControl(deviceGuid: string, parameters: ControlParameters): Promise<void> {
    const response = await this.client.request("/deviceStatus/control", {
      method: "POST",
      body: JSON.stringify({ deviceGuid, parameters }),
    })
    await this.parseResponse(response, `setDeviceControl(${deviceGuid.slice(0, 8)}...)`)
  }

  async powerOn(deviceGuid: string): Promise<void> {
    await this.setDeviceControl(deviceGuid, { operate: 1 })
  }

  async powerOff(deviceGuid: string): Promise<void> {
    await this.setDeviceControl(deviceGuid, { operate: 0 })
  }

  async setTemperature(deviceGuid: string, temperature: number): Promise<void> {
    await this.setDeviceControl(deviceGuid, { temperatureSet: temperature })
  }

  async setOperationMode(
    deviceGuid: string,
    mode: ControlParameters["operationMode"]
  ): Promise<void> {
    await this.setDeviceControl(deviceGuid, { operationMode: mode })
  }

  async setFanSpeed(deviceGuid: string, speed: ControlParameters["fanSpeed"]): Promise<void> {
    await this.setDeviceControl(deviceGuid, { fanSpeed: speed })
  }

  async setEcoMode(deviceGuid: string, enabled: boolean): Promise<void> {
    await this.setDeviceControl(deviceGuid, { ecoMode: enabled ? 2 : 0 })
  }

  async setNanoe(deviceGuid: string, enabled: boolean): Promise<void> {
    await this.setDeviceControl(deviceGuid, { nanoe: enabled ? 2 : 1 })
  }

  /**
   * Parse a response, throwing descriptive errors for known failure modes.
   */
  private async parseResponse(response: Response, context: string): Promise<unknown> {
    if (response.status === 403) {
      throw new Error(
        `[Panasonic] ${context}: Access forbidden (403). Check x-app-version or API access rights.`
      )
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(
        `[Panasonic] ${context}: API error ${response.status}: ${response.statusText}. ${errorText}`
      )
    }

    return response.json()
  }
}
