import { createBuildingControlsClient } from "../lib/sources/building-controls-client"
import { apiBaseUrl } from "./api"

const alarmId = "alarm-harbor-rtu-7-vfd"
const deliveryId = `demo-${Date.now()}`
const controls = await createBuildingControlsClient()

await controls.raiseAlarm(
  {
    alarmId,
    equipmentId: "equipment-harbor-newark-rtu-7",
    message: "RTU-7 cannot maintain supply temperature; compressor current is elevated.",
    severity: "high",
    category: "equipment",
  },
  `raise-${deliveryId}`
)
const delivery = await controls.createSignedDelivery(alarmId, deliveryId)
const response = await fetch(`${apiBaseUrl()}/webhooks/building-controls/alarm-events`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-northline-signature": delivery.signature,
  },
  body: delivery.body,
})

if (!response.ok) {
  throw new Error(
    `[Northline] Alarm delivery failed (${response.status}): ${await response.text()}`
  )
}
console.log(`[Northline] Delivered ${alarmId} as ${deliveryId}.`)
