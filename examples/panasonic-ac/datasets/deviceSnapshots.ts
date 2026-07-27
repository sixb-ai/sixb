import { col, defineDataset } from "@sixb/core"

export const panasonicDeviceSnapshots = defineDataset("panasonic.device-snapshots", {
  schema: [
    col("id", "string"),
    col("guid", "string"),
    col("deviceName", "string"),
    col("observedAt", "timestamp"),
    col("temperatureUnit", "string"),
    col("power", "boolean"),
    col("operatingMode", "int64"),
    col("indoorTemperature", "float64", { nullable: true }),
    col("outdoorTemperature", "float64", { nullable: true }),
    col("targetTemperature", "float64"),
    col("fanSpeed", "int64"),
    col("swingHorizontal", "int64"),
    col("swingVertical", "int64"),
    col("ecoMode", "boolean"),
    col("nanoeMode", "boolean"),
    col("ecoNaviMode", "boolean"),
    col("iAutoMode", "boolean"),
  ],
})
