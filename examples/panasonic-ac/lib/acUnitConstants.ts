export const acUnitObjectTypeId = "panasonic:AcUnit"

export const acUnitProps = {
  name: "deviceName",
  guid: "guid",
  deviceName: "deviceName",
  power: "power",
  mode: "operatingMode",
  temperatureIndoor: "indoorTemperature",
  temperatureOutdoor: "outdoorTemperature",
  temperatureTarget: "targetTemperature",
  fanSpeed: "fanSpeed",
  swingHorizontal: "swingHorizontal",
  swingVertical: "swingVertical",
  eco: "ecoMode",
  nanoe: "nanoeMode",
  econavi: "ecoNaviMode",
  iauto: "iAutoMode",
} as const

export const MODE_NAMES: Record<number, string> = {
  0: "Auto",
  1: "Dry",
  2: "Cool",
  3: "Heat",
  4: "Fan",
}

export const FAN_SPEED_NAMES: Record<number, string> = {
  0: "Auto",
  1: "Low",
  2: "LowMid",
  3: "Mid",
  4: "HighMid",
  5: "High",
}
