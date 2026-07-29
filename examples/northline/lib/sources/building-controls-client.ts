import { createHmac, timingSafeEqual } from "node:crypto"
import { pageRows, runIdempotently } from "./client-utils"
import type { AlarmRow, EquipmentRow, ReadingRow, SourceListInput, SourcePage } from "./contracts"
import { controlsStore, initializeDemoSources } from "./source-state"

const webhookSecret = "northline-local-controls-secret"

export interface RaiseAlarmInput {
  readonly alarmId: string
  readonly equipmentId: string
  readonly message: string
  readonly severity: AlarmRow["severity"]
  readonly category: AlarmRow["category"]
}

export interface ControlsAlarmDelivery {
  readonly deliveryId: string
  readonly event: "alarm.raised" | "alarm.cleared"
  readonly alarm: AlarmRow
  readonly facilityId: string
}

export interface SignedControlsDelivery {
  readonly body: string
  readonly signature: string
  readonly deliveryId: string
}

export interface BuildingControlsClient {
  listEquipment(input?: SourceListInput): Promise<SourcePage<EquipmentRow>>
  listReadings(input?: SourceListInput): Promise<SourcePage<ReadingRow>>
  listAlarms(input?: SourceListInput): Promise<SourcePage<AlarmRow>>
  raiseAlarm(input: RaiseAlarmInput, idempotencyKey: string): Promise<AlarmRow>
  clearAlarm(alarmId: string, idempotencyKey: string): Promise<AlarmRow>
  recordRecovery(equipmentId: string, idempotencyKey: string): Promise<ReadingRow>
  createSignedDelivery(
    alarmId: string,
    deliveryId: string,
    event?: ControlsAlarmDelivery["event"]
  ): Promise<SignedControlsDelivery>
}

export async function createBuildingControlsClient(): Promise<BuildingControlsClient> {
  await initializeDemoSources()

  return {
    async listEquipment(input) {
      return pageRows((await controlsStore.read()).equipment, input)
    },
    async listReadings(input) {
      return pageRows((await controlsStore.read()).readings, input)
    },
    async listAlarms(input) {
      return pageRows((await controlsStore.read()).alarms, input)
    },
    async raiseAlarm(input, idempotencyKey) {
      return controlsStore.update((state) =>
        runIdempotently(
          state.idempotency,
          idempotencyKey,
          "raiseAlarm",
          input,
          (id) => state.alarms.find((alarm) => alarm.alarm_id === id),
          () => {
            const now = new Date().toISOString()
            const existing = state.alarms.find((alarm) => alarm.alarm_id === input.alarmId)
            if (existing) {
              Object.assign(existing, {
                message: input.message,
                severity: input.severity,
                category: input.category,
                status: "active" as const,
                observed_at: now,
                updated_at: now,
                acknowledged_at: undefined,
                cleared_at: undefined,
              })
              return existing
            }
            const alarm: AlarmRow = {
              alarm_id: input.alarmId,
              equipment_id: input.equipmentId,
              message: input.message,
              severity: input.severity,
              category: input.category,
              status: "active",
              observed_at: now,
              updated_at: now,
            }
            state.alarms.push(alarm)
            return alarm
          },
          (alarm) => alarm.alarm_id
        )
      )
    },
    async clearAlarm(alarmId, idempotencyKey) {
      return controlsStore.update((state) =>
        runIdempotently(
          state.idempotency,
          idempotencyKey,
          "clearAlarm",
          { alarmId },
          (id) => state.alarms.find((alarm) => alarm.alarm_id === id),
          () => {
            const alarm = state.alarms.find((item) => item.alarm_id === alarmId)
            if (!alarm) throw new Error(`[NorthlineSource] Alarm '${alarmId}' was not found.`)
            alarm.status = "cleared"
            alarm.cleared_at = new Date().toISOString()
            alarm.updated_at = alarm.cleared_at
            return alarm
          },
          (alarm) => alarm.alarm_id
        )
      )
    },
    async recordRecovery(equipmentId, idempotencyKey) {
      return controlsStore.update((state) =>
        runIdempotently(
          state.idempotency,
          idempotencyKey,
          "recordRecovery",
          { equipmentId },
          (id) => state.readings.find((reading) => reading.reading_id === id),
          () => {
            if (!state.equipment.some((equipment) => equipment.equipment_id === equipmentId)) {
              throw new Error(`[NorthlineSource] Equipment '${equipmentId}' was not found.`)
            }
            const reading: ReadingRow = {
              reading_id: `${equipmentId}-recovery`,
              equipment_id: equipmentId,
              recorded_at: new Date().toISOString(),
              supply_temp: 55,
              return_temp: 72,
              temperature_unit: "degreeFahrenheit",
              compressor_current: 13.2,
              current_unit: "ampere",
            }
            state.readings.push(reading)
            return reading
          },
          (reading) => reading.reading_id
        )
      )
    },
    async createSignedDelivery(alarmId, deliveryId, event = "alarm.raised") {
      const state = await controlsStore.read()
      const alarm = state.alarms.find((item) => item.alarm_id === alarmId)
      if (!alarm) throw new Error(`[NorthlineSource] Alarm '${alarmId}' was not found.`)
      const equipment = state.equipment.find((item) => item.equipment_id === alarm.equipment_id)
      if (!equipment) {
        throw new Error(`[NorthlineSource] Equipment '${alarm.equipment_id}' was not found.`)
      }
      const body = JSON.stringify({
        deliveryId,
        event,
        alarm,
        facilityId: equipment.facility_id,
      } satisfies ControlsAlarmDelivery)
      return {
        body,
        deliveryId,
        signature: signControlsDelivery(body),
      }
    },
  }
}

export function signControlsDelivery(body: string): string {
  return createHmac("sha256", webhookSecret).update(body).digest("hex")
}

export function verifyControlsSignature(rawBody: Uint8Array, signature: string | null): boolean {
  if (!signature) return false
  const expected = signControlsDelivery(new TextDecoder().decode(rawBody))
  const actualBytes = Buffer.from(signature, "hex")
  const expectedBytes = Buffer.from(expected, "hex")
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}
