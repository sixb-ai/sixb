import { beforeAll } from "bun:test"
import { installExtensions } from "./install-extensions"

beforeAll(installExtensions, 120_000)
