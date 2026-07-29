import { defineConnector, defineWebhook } from "@sixb/core"
import { z } from "zod"
import {
  createBuildingControlsClient,
  verifyControlsSignature,
} from "../lib/sources/building-controls-client"
import { alarmRowSchema } from "../lib/sources/contracts"

const deliverySchema = z.object({
  deliveryId: z.string().min(1),
  event: z.enum(["alarm.raised", "alarm.cleared"]),
  alarm: alarmRowSchema,
  facilityId: z.string().min(1),
})

export const buildingControlsConnector = defineConnector("building-controls", {
  type: "northline-file-backed-building-controls",
  webhooks: [
    defineWebhook("alarm-events")
      .post()
      .json({ parse: (value) => deliverySchema.parse(value) })
      .verify(({ rawBody, request }) => {
        if (!verifyControlsSignature(rawBody, request.headers.get("x-northline-signature"))) {
          throw new Error("[Northline] Invalid building-controls webhook signature.")
        }
      })
      .idempotencyKey(({ body }) => body.deliveryId)
      .handle(async ({ body, sixb }) => {
        const result = await sixb.actions.request({
          actionId: "record-building-alarm",
          runId: `alarm-delivery-${body.deliveryId}`,
          params: {
            alarmId: body.alarm.alarm_id,
            equipmentId: body.alarm.equipment_id,
            facilityId: body.facilityId,
            message: body.alarm.message,
            severity: body.alarm.severity,
            category: body.alarm.category,
            status: body.alarm.status,
            observedAt: body.alarm.observed_at,
          },
        })
        return { status: 202, body: { actionRunId: result.runId } }
      }),
  ],
  connect: createBuildingControlsClient,
})
