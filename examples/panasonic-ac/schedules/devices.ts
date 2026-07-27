import { defineSchedule } from "@sixb/core"

export const panasonicDeviceSnapshotsSchedule = defineSchedule(
  "panasonic-device-snapshots-schedule"
).cron("* * * * *")
