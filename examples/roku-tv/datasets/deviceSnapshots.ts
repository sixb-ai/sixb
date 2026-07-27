import { col, defineDataset } from "@sixb/core"

export const rokuDeviceSnapshots = defineDataset("roku.device-snapshots", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("platform", "string"),
    col("controlHost", "string"),
    col("manufacturer", "string"),
    col("modelName", "string"),
    col("modelNumber", "string"),
    col("serialNumber", "string"),
    col("softwareVersion", "string"),
    col("powerState", "string"),
    col("activeApp", "string", { nullable: true }),
    col("mediaState", "string", { nullable: true }),
    col("observedAt", "timestamp"),
  ],
})
