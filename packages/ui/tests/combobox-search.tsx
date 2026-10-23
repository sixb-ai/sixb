/**
 * Run by `combobox.test.ts` in its own process: Radix decides when it loads whether a DOM exists,
 * and never opens a popover when it loaded without one, which a test file sharing the suite's
 * process cannot rule out. React loads first, as it does in the other suites, so it reads typing
 * from focus and key events.
 */
import { fireEvent, render, waitFor } from "@testing-library/react"
import "./helpers/dom-globals"
import { strict as assert } from "node:assert"
import { useState } from "react"
import { Combobox } from "../src/components/ui/combobox"

const options = [
  { value: "usr_ava", label: "Ava Martin" },
  { value: "usr_ben", label: "Ben Okafor" },
]

function Picker({ onSearchChange }: { readonly onSearchChange?: (search: string) => void }) {
  const [value, setValue] = useState("")
  return (
    <Combobox
      value={value}
      options={options}
      onValueChange={setValue}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search"
    />
  )
}

async function typeInList(view: ReturnType<typeof render>, text: string) {
  fireEvent.click(view.getByRole("combobox"))
  const input = await waitFor(() => view.getByPlaceholderText("Search"))
  fireEvent.focusIn(input)
  fireEvent.input(input, { target: { value: text } })
  fireEvent.keyUp(input, { key: text.at(-1) })
}

function shownLabels(): string[] {
  return [...document.querySelectorAll("[cmdk-item]")].map((item) => item.textContent ?? "")
}

// Without onSearchChange, the list filters its options itself.
{
  const view = render(<Picker />)
  await typeInList(view, "okafor")
  await waitFor(() => assert.deepEqual(shownLabels(), ["Ben Okafor"]))
  view.unmount()
}

// With it, the caller searches: the text reaches it, and every option it gives stays shown.
// Removal proof: drop `shouldFilter` from the Combobox and only "Ben Okafor" is shown here.
{
  const searches: string[] = []
  const view = render(<Picker onSearchChange={(search) => searches.push(search)} />)
  await typeInList(view, "okafor")
  await waitFor(() => assert.deepEqual(searches, ["okafor"]))
  assert.deepEqual(shownLabels(), ["Ava Martin", "Ben Okafor"])

  // Closing the list clears the search, so it opens on the full list next time. Removal proof:
  // drop the reset from `handleOpenChange` and the searches end at "okafor".
  fireEvent.keyDown(view.getByPlaceholderText("Search"), { key: "Escape" })
  await waitFor(() => assert.deepEqual(searches, ["okafor", ""]))
  view.unmount()
}

console.log("combobox search: ok")
