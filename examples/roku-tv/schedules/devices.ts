import { defineSchedule } from "@sixb/core"

export const rokuDeviceSnapshotsSchedule = defineSchedule("roku-device-snapshots-schedule").cron(
  "* * * * *"
)
