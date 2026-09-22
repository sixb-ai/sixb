import { ArrowUpRight, Box, Terminal } from "lucide-react"
import Image from "next/image"
import { providerCatalog } from "../docs/providerCatalog"

export function ProviderLibrary({ kind }: { kind: keyof typeof providerCatalog }) {
  return (
    <section
      className="connector-library provider-library"
      aria-label={kind === "models" ? "Model providers" : "Sandbox providers"}
    >
      <div className="connector-grid">
        {providerCatalog[kind].map((entry) => (
          <a
            className="connector-card"
            key={entry.href}
            href={entry.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="connector-card-top">
              <span className="connector-logo" aria-hidden="true">
                {entry.icon ? (
                  <Image
                    unoptimized
                    src={`/assets/providers/${entry.icon}`}
                    alt=""
                    width={26}
                    height={26}
                  />
                ) : entry.name === "Local" ? (
                  <Terminal size={24} />
                ) : (
                  <Box size={24} />
                )}
              </span>
              <span className="flex items-center gap-3">
                {entry.environment ? <span className="text-xs">{entry.environment}</span> : null}
                <ArrowUpRight size={15} aria-hidden="true" />
              </span>
            </div>
            <strong>{entry.name}</strong>
            <p>{entry.description}</p>
            <code>{entry.package}</code>
          </a>
        ))}
      </div>
    </section>
  )
}
