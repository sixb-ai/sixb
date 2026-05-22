/** Configuration for a single Panasonic device */
export interface PanasonicDeviceConfig {
  /** Unique name for this device (used in stream paths) */
  name: string
  /** Device GUID from Panasonic API (auto-discovered if omitted) */
  guid?: string
}

/** OAuth2 authentication tokens */
export interface AuthTokens {
  /** Access token for API requests */
  accessToken: string
  /** Refresh token for token renewal */
  refreshToken: string
  /** Token expiration timestamp (Unix ms) */
  expiresAt: number
  /** ACC client ID for API requests (obtained from /auth/v2/login) */
  clientId?: string
}

/** Device group from /device/group API */
export interface DeviceGroup {
  groupId: number
  groupName: string
  devices: DeviceListItem[]
}

/**
 * Device from /device/group API (deviceList).
 * Note: This is a simplified structure. Full device capabilities
 * are available in DeviceStatus from /deviceStatus/{guid}.
 */
export interface DeviceListItem {
  deviceGuid: string
  deviceType: string
  deviceName: string
  deviceModuleNumber: string
  deviceHashGuid: string
  permission: number
  temperatureUnit: number
  summerHouse: number
  nanoeStandAlone: boolean
  autoMode: boolean
  powerConsumptionFlg: boolean
  modeAvlList: ModeAvailability
  coordinableFlg: boolean
  pairedFlg: boolean
  modelVersion?: number
  devicePositionId?: number
  /** Current parameters (partial, no temperatures) */
  parameters: DeviceParametersPartial
}

/** Mode availability flags */
export interface ModeAvailability {
  autoMode: number
  fanMode?: number
  dryMode?: number
  coolMode?: number
  heatMode?: number
}

/**
 * Device parameters from /device/group (no temperatures).
 *
 * Note on boolean-like numeric values (Panasonic API quirk):
 * - operate: 0 = off, 1 = on
 * - ecoMode: 0 = off, 2 = on
 * - ecoNavi: 0 = off, 2 = on
 * - nanoe: 1 = off, 2 = on (note: 1 is off, not 0)
 * - iAuto: 0 = off, 1 = on
 */
export interface DeviceParametersPartial {
  /** Power state: 0 = off, 1 = on */
  operate: number
  operationMode: OperationMode
  temperatureSet: number
  fanSpeed: FanSpeed
  fanAutoMode: FanAutoMode
  airSwingLR: AirSwingLR
  airSwingUD: AirSwingUD
  /** Eco mode: 0 = off, 2 = on */
  ecoMode: number
  /** EcoNavi: 0 = off, 2 = on */
  ecoNavi: number
  /** Nanoe: 1 = off, 2 = on (note: 1 is off, not 0) */
  nanoe: number
  /** iAuto: 0 = off, 1 = on */
  iAuto: number
  airDirection: number
  ecoFunctionData: number
  lastSettingMode?: number
  airQuality?: number
}

/** Full device parameters from /deviceStatus (includes temperatures) */
export interface DeviceParameters extends DeviceParametersPartial {
  insideTemperature: number
  outTemperature: number
  insideCleaning?: number
  fireplace?: number
  offTimerTimeLeft?: number
  actualNanoe?: number
}

/**
 * Device status response from /deviceStatus/{guid} API.
 * Contains full device capabilities and current parameters.
 */
export interface DeviceStatus {
  /** Timestamp in milliseconds */
  timestamp: number
  /** Permission level (3 = owner) */
  permission: number
  /** Summer house mode */
  summerHouse: number
  /** Device capabilities */
  iAutoX: boolean
  nanoe: boolean
  nanoeStandAlone: boolean
  autoMode: boolean
  heatMode: boolean
  fanMode: boolean
  dryMode: boolean
  coolMode: boolean
  ecoNavi: boolean
  powerfulMode: boolean
  quietMode: boolean
  airSwingLR: boolean
  autoSwingUD?: boolean
  ecoFunction: number
  temperatureUnit: number
  modeAvlList: ModeAvailability
  clothesDrying?: boolean
  insideCleaning?: boolean
  fireplace?: boolean
  offTimer?: boolean
  powerConsumptionFlg?: boolean
  pairedFlg?: boolean
  deviceNanoe?: number
  /** Current operational parameters */
  parameters: DeviceParameters
}

/** Operation mode values */
export enum OperationMode {
  Auto = 0,
  Dry = 1,
  Cool = 2,
  Heat = 3,
  Fan = 4,
}

/** Fan speed values */
export enum FanSpeed {
  Auto = 0,
  Low = 1,
  LowMid = 2,
  Mid = 3,
  HighMid = 4,
  High = 5,
}

/** Fan auto mode values */
export enum FanAutoMode {
  Disabled = 1,
  AirSwingAuto = 0,
  AirSwingUD = 2,
  AirSwingLR = 3,
}

/** Horizontal air swing values */
export enum AirSwingLR {
  Auto = 0,
  Left = 1,
  LeftMid = 2,
  Mid = 3,
  RightMid = 4,
  Right = 5,
}

/** Vertical air swing values */
export enum AirSwingUD {
  Auto = 0,
  Up = 1,
  UpMid = 2,
  Mid = 3,
  DownMid = 4,
  Down = 5,
}

/** Control parameters for device control API */
export interface ControlParameters {
  operate?: number
  operationMode?: OperationMode
  temperatureSet?: number
  fanSpeed?: FanSpeed
  fanAutoMode?: FanAutoMode
  airSwingLR?: AirSwingLR
  airSwingUD?: AirSwingUD
  ecoMode?: number
  ecoNavi?: number
  nanoe?: number
  iAuto?: number
}

/** Human-readable operation mode names */
export const OperationModeNames: Record<OperationMode, string> = {
  [OperationMode.Auto]: "auto",
  [OperationMode.Dry]: "dry",
  [OperationMode.Cool]: "cool",
  [OperationMode.Heat]: "heat",
  [OperationMode.Fan]: "fan",
}

/** Panasonic Comfort Cloud API constants */
export const API_CONSTANTS = {
  /** Auth0 domain */
  AUTH0_DOMAIN: "https://authglb.digital.panasonic.com",
  /** Auth0 client ID */
  CLIENT_ID: "Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx",
  /** Auth0 audience (format: https://digital.panasonic.com/{CLIENT_ID}/api/v1/) */
  AUDIENCE: "https://digital.panasonic.com/Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx/api/v1/",
  /** OAuth2 redirect URI (updated Feb 2026 - changed from ACCs498 to ACCsmart) */
  REDIRECT_URI:
    "panasonic-iot-cfc://authglb.digital.panasonic.com/android/com.panasonic.ACCsmart/callback",
  /** OAuth2 scope (a2w.control added for Aquarea heat pump support) */
  SCOPE: "openid offline_access comfortcloud.control a2w.control",
  /** Comfort Cloud API base URL */
  API_BASE: "https://accsmart.panasonic.com",
  /** App version header value (update when Panasonic releases new app versions) */
  APP_VERSION: "4.1.0",
} as const
