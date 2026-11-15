import type { AuthorizablePrincipal } from "../../execution/types"
import type { SandboxOAuthConnector } from "../../sandboxes/auth"
import type { ConnectorConnectionSelector, ConnectorTokenSource } from "../types"
import type { ConnectorConnectionCallbackProcess } from "./contracts"
import type { ConnectorConnectionsRuntime } from "./execution"

export interface SandboxConnectionTokenAccessInput {
  readonly connector: SandboxOAuthConnector
  readonly selector: ConnectorConnectionSelector
  readonly requestedBy?: AuthorizablePrincipal
}

export type SandboxConnectionTokenAccess = (
  input: SandboxConnectionTokenAccessInput
) => ConnectorTokenSource

const connectorConnectionsRuntimeKey: unique symbol = Symbol("sixb.connectorConnectionsRuntime")
const connectorConnectionCallbackKey: unique symbol = Symbol("sixb.connectorConnectionCallback")
const sandboxConnectionTokenAccessKey: unique symbol = Symbol("sixb.sandboxConnectionTokenAccess")

interface ConnectorConnectionsRuntimeOwner {
  readonly [connectorConnectionsRuntimeKey]?: ConnectorConnectionsRuntime
}

interface ConnectorConnectionCallbackOwner {
  readonly [connectorConnectionCallbackKey]?: ConnectorConnectionCallbackProcess
}

interface SandboxConnectionTokenAccessOwner {
  readonly [sandboxConnectionTokenAccessKey]?: SandboxConnectionTokenAccess
}

export function registerConnectorConnectionsRuntime(
  owner: object,
  runtime: ConnectorConnectionsRuntime
): void {
  const registered = (owner as ConnectorConnectionsRuntimeOwner)[connectorConnectionsRuntimeKey]
  if (registered && registered !== runtime) {
    throw new Error("[Sixb] Connector connections runtime is already registered for this owner.")
  }
  Object.defineProperty(owner, connectorConnectionsRuntimeKey, {
    configurable: false,
    enumerable: false,
    value: runtime,
    writable: false,
  })
}

export function getConnectorConnectionsRuntime(owner: object): ConnectorConnectionsRuntime {
  const runtime = (owner as ConnectorConnectionsRuntimeOwner)[connectorConnectionsRuntimeKey]
  if (runtime) return runtime
  throw new Error("[Sixb] Connector connections runtime is not registered for this execution.")
}

export function registerConnectorConnectionCallbackProcess(
  owner: object,
  process: ConnectorConnectionCallbackProcess
): void {
  const registered = (owner as ConnectorConnectionCallbackOwner)[connectorConnectionCallbackKey]
  if (registered && registered !== process) {
    throw new Error("[Sixb] Connector callback process is already registered for this host.")
  }
  Object.defineProperty(owner, connectorConnectionCallbackKey, {
    configurable: false,
    enumerable: false,
    value: process,
    writable: false,
  })
}

export function getConnectorConnectionCallbackProcess(
  owner: object
): ConnectorConnectionCallbackProcess {
  const process = (owner as ConnectorConnectionCallbackOwner)[connectorConnectionCallbackKey]
  if (process) return process
  throw new Error("[Sixb] Connector callback process is not registered for this host.")
}

export function registerSandboxConnectionTokenAccess(
  owner: object,
  access: SandboxConnectionTokenAccess
): void {
  const registered = (owner as SandboxConnectionTokenAccessOwner)[sandboxConnectionTokenAccessKey]
  if (registered && registered !== access) {
    throw new Error("[Sixb] Sandbox connection token access is already registered for this host.")
  }
  Object.defineProperty(owner, sandboxConnectionTokenAccessKey, {
    configurable: false,
    enumerable: false,
    value: access,
    writable: false,
  })
}

export function getSandboxConnectionTokenAccess(
  owner: object
): SandboxConnectionTokenAccess | undefined {
  return (owner as SandboxConnectionTokenAccessOwner)[sandboxConnectionTokenAccessKey]
}
