import { describe, expect, test } from "bun:test"
import { getAgentOptions, listModelsOptions } from "@sixb/client/hooks"
import { LocaleProvider, untranslatedMessages } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentSurface } from "../src"
import { latestWorkLabel } from "../src/agent/activity-label"
import { classifyCommand, describeBash } from "../src/agent/bash/interpret"
import {
  RunInterruptedMarker,
  RunTimeoutMarker,
  ThinkingMarker,
} from "../src/agent/components/message-view"
import { AgentLabelsProvider } from "../src/agent/i18n"
import { en } from "../src/agent/i18n/en"
import { fr } from "../src/agent/i18n/fr"
import { ViewFileToolView } from "../src/agent/view-file/view-file-tool-view"
import { en as artifactsEn, fr as artifactsFr } from "../src/artifacts/messages"

function render(node: ReactNode, locale?: string): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(getAgentOptions().queryKey, {
    name: "Sixb",
    model: { provider: "test", modelId: "fast" },
  })
  queryClient.setQueryData(listModelsOptions().queryKey, {
    language: [],
    audio: { speech: [], transcription: [] },
    capabilities: { run: false },
  })
  const tree = <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  return renderToStaticMarkup(
    locale ? <LocaleProvider locale={locale}>{tree}</LocaleProvider> : tree
  )
}

describe("agent chat localization", () => {
  test("translates every message into French", () => {
    expect(untranslatedMessages(en, fr)).toEqual([])
    expect(untranslatedMessages(artifactsEn, artifactsFr)).toEqual([])
  })

  test("composes grammatical French sentences", () => {
    expect(artifactsFr.sheet.frozenRows(3)).toBe("Lignes 1 à 3 figées")
    expect(fr.web.read(fr.web.webPage)).toBe("Page consultée : page web")
  })

  test("speaks English without a provider and the provider's language below one", () => {
    // Proven by removal: hard-code the English label in AgentSurface's launcher.
    const collapsed = <AgentSurface mode="collapsed" persistenceKey={false} />
    expect(render(collapsed)).toContain('aria-label="Open assistant"')
    expect(render(collapsed, "fr-CA")).toContain('aria-label="Ouvrir l’assistant"')
    expect(render(<ThinkingMarker />, "fr-FR")).toContain("Réflexion…")
    expect(
      render(<RunTimeoutMarker hasProgress timeoutMs={600_000} onContinue={() => {}} />, "fr-FR")
    ).toContain("Arrêté après avoir atteint la durée maximale de 10 minutes.")
    const interrupted = render(<RunInterruptedMarker hasProgress onContinue={() => {}} />, "fr-FR")
    expect(interrupted).toContain("La réponse a été interrompue avant la fin.")
    expect(interrupted).toContain("Continuer")
    const viewing = {
      toolName: "view_file",
      state: "input-available",
      input: { path: "inputs/scan.png" },
    } as const
    expect(render(<ViewFileToolView tool={viewing} />, "fr-FR")).toContain(
      "Consultation de scan.png"
    )
    expect(latestWorkLabel([{ kind: "tool", tool: { ...viewing, input: {} } }], fr)).toBe(
      "Consultation d’un fichier"
    )
  })

  test("applies labels on top of the language, and the app's own strings untouched", () => {
    const html = render(
      <AgentLabelsProvider labels={{ surface: { collapse: "Masquer" } }}>
        <AgentSurface
          mode="dock"
          persistenceKey={false}
          title="Opérations"
          composerPlaceholder="Votre demande"
        />
      </AgentLabelsProvider>,
      "fr-FR"
    )
    expect(html).toContain('aria-label="Masquer"')
    expect(html).toContain('aria-label="Opérations"')
    // Proven by removal: drop the composerPlaceholder forwarding in AgentSurface.
    expect(html).toContain('placeholder="Votre demande"')
    expect(html).toContain('aria-label="Redimensionner l’assistant"')
  })

  test("describes agent commands in French without pluralizing project names", () => {
    const html = describeBash(classifyCommand("cat > report.html <<'EOF'\n<html></html>"), null, fr)
    expect(html).toMatchObject({
      title: "Fichier HTML créé",
      runningTitle: "Création d’un fichier HTML",
    })
    const query = describeBash(
      { kind: "sixb", command: "objects.list", args: ["--type", "WorkOrder"] },
      {
        ok: true,
        stdout: "[]",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        truncated: false,
        json: [{}, {}],
      },
      fr
    )
    expect(query).toMatchObject({
      title: "2 résultats dans « work order »",
      runningTitle: "Recherche dans « work order »",
    })
  })
})
