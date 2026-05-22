import { z } from "zod"

// ============================================================================
// Configuration Schemas
// ============================================================================

/** Schema for a single Panasonic device configuration */
export const PanasonicDeviceConfigSchema = z.object({
  /** Unique name for this device (used in stream paths) */
  name: z.string().min(1, "Device name is required"),
  /** Device GUID from Panasonic API (auto-discovered if omitted) */
  guid: z.string().optional(),
})

/** Validation ranges for control parameters */
export const ControlRanges = {
  /** Operation mode: 0=Auto, 1=Dry, 2=Cool, 3=Heat, 4=Fan */
  mode: { min: 0, max: 4 },
  /** Fan speed: 0=Auto, 1=Low, 2=LowMid, 3=Mid, 4=HighMid, 5=High */
  fanSpeed: { min: 0, max: 5 },
  /** Air swing position: 0=Auto, 1-5=Fixed positions */
  swingPosition: { min: 0, max: 5 },
  /** Temperature range in Celsius */
  temperature: { min: 16, max: 30 },
} as const

/** Temperature value indicating sensor unavailable */
export const TEMPERATURE_UNAVAILABLE = 126

// ============================================================================
// API Response Validation Schemas
// ============================================================================

/** Schema for device parameters from API responses */
export const DeviceParametersSchema = z.object({
  operate: z.number(),
  operationMode: z.number(),
  temperatureSet: z.number(),
  fanSpeed: z.number(),
  fanAutoMode: z.number(),
  airSwingLR: z.number(),
  airSwingUD: z.number(),
  ecoMode: z.number(),
  ecoNavi: z.number(),
  nanoe: z.number(),
  iAuto: z.number(),
  airDirection: z.number(),
  ecoFunctionData: z.number(),
  insideTemperature: z.number(),
  outTemperature: z.number(),
  lastSettingMode: z.number().optional(),
  airQuality: z.number().optional(),
  insideCleaning: z.number().optional(),
  fireplace: z.number().optional(),
  offTimerTimeLeft: z.number().optional(),
  actualNanoe: z.number().optional(),
})

/** Schema for mode availability */
export const ModeAvailabilitySchema = z.object({
  autoMode: z.number(),
  fanMode: z.number().optional(),
  dryMode: z.number().optional(),
  coolMode: z.number().optional(),
  heatMode: z.number().optional(),
})

/** Schema for device status response from /deviceStatus/{guid} */
export const DeviceStatusSchema = z.object({
  timestamp: z.number(),
  permission: z.number(),
  summerHouse: z.number(),
  iAutoX: z.boolean(),
  nanoe: z.boolean(),
  nanoeStandAlone: z.boolean(),
  autoMode: z.boolean(),
  heatMode: z.boolean(),
  fanMode: z.boolean(),
  dryMode: z.boolean(),
  coolMode: z.boolean(),
  ecoNavi: z.boolean(),
  powerfulMode: z.boolean(),
  quietMode: z.boolean(),
  airSwingLR: z.boolean(),
  ecoFunction: z.number(),
  temperatureUnit: z.number(),
  modeAvlList: ModeAvailabilitySchema,
  parameters: DeviceParametersSchema,
  autoSwingUD: z.boolean().optional(),
  clothesDrying: z.boolean().optional(),
  insideCleaning: z.boolean().optional(),
  fireplace: z.boolean().optional(),
  offTimer: z.boolean().optional(),
  powerConsumptionFlg: z.boolean().optional(),
  pairedFlg: z.boolean().optional(),
  deviceNanoe: z.number().optional(),
})

/** Schema for device list item from /device/group */
export const DeviceListItemSchema = z.object({
  deviceGuid: z.string(),
  deviceType: z.string(),
  deviceName: z.string(),
  deviceModuleNumber: z.string(),
  deviceHashGuid: z.string(),
  permission: z.number(),
  temperatureUnit: z.number(),
  summerHouse: z.number(),
  nanoeStandAlone: z.boolean(),
  autoMode: z.boolean(),
  powerConsumptionFlg: z.boolean(),
  modeAvlList: ModeAvailabilitySchema,
  coordinableFlg: z.boolean(),
  pairedFlg: z.boolean(),
  parameters: z.object({
    operate: z.number(),
    operationMode: z.number(),
    temperatureSet: z.number(),
    fanSpeed: z.number(),
    fanAutoMode: z.number(),
    airSwingLR: z.number(),
    airSwingUD: z.number(),
    ecoMode: z.number(),
    ecoNavi: z.number(),
    nanoe: z.number(),
    iAuto: z.number(),
    airDirection: z.number(),
    ecoFunctionData: z.number(),
    lastSettingMode: z.number().optional(),
    airQuality: z.number().optional(),
  }),
  modelVersion: z.number().optional(),
  devicePositionId: z.number().optional(),
})

/** Schema for device group from /device/group */
export const DeviceGroupSchema = z.object({
  groupId: z.number(),
  groupName: z.string(),
  deviceList: z.array(DeviceListItemSchema).optional(),
})

/** Schema for /device/group API response */
export const GroupResponseSchema = z.object({
  uiFlg: z.boolean(),
  groupCount: z.number(),
  groupList: z.array(DeviceGroupSchema),
})

/** Schema for energy history response */
export const EnergyHistoryResponseSchema = z.object({
  energyConsumption: z.array(z.number()),
  estimatedCost: z.number(),
  currencyUnit: z.string().optional(),
})
