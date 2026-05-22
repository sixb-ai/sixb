import { expect, test } from "bun:test"
import {
  DEFAULT_PARIO_S4_BASE_URL,
  DEFAULT_PARIO_S4_MOUNT_PATH,
  renderParioS4ConfigSource,
} from "../src/render-config"

test("renderParioS4ConfigSource emits the default Pario wiring", () => {
  expect(renderParioS4ConfigSource()).toMatchSnapshot()
})

test("renderParioS4ConfigSource honors custom mount path and base URL", () => {
  expect(
    renderParioS4ConfigSource({ mountPath: "/acme", defaultBaseUrl: "http://acme:8080" })
  ).toMatchSnapshot()
})

test("constants expose the canonical Pario/S4 defaults", () => {
  expect(DEFAULT_PARIO_S4_MOUNT_PATH).toBe("/pario")
  expect(DEFAULT_PARIO_S4_BASE_URL).toBe("http://127.0.0.1:3000")
})
