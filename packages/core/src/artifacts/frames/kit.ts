const FONTS = {
  "--font-sans":
    '"SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  "--font-serif": 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  "--font-mono": '"SF Mono", "Geist Mono", "JetBrains Mono", ui-monospace, monospace',
} as const

/**
 * Sixb's default theme, light and dark: the values `@sixb/ui`'s globals.css gives the tokens the
 * app sends into a frame, which an artifact's theme may set. The kit starts from the light one
 * until the app's arrive, and the layout check measures a deck in both, since a deck follows the
 * app's mode and the project's own theme is out of the sandbox's reach.
 */
export const FRAME_DEFAULT_THEMES = {
  light: {
    dark: false,
    tokens: {
      "--background": "#fafafa",
      "--foreground": "#101010",
      "--card": "#ffffff",
      "--card-foreground": "#101010",
      "--muted": "#f4f4f4",
      "--muted-foreground": "#5f5f5f",
      "--primary": "#0a0a0a",
      "--primary-foreground": "#ffffff",
      "--accent": "#f0f0f0",
      "--accent-foreground": "#202020",
      "--border": "#e2e2e2",
      "--chart-1": "#101010",
      "--chart-2": "#404040",
      "--chart-3": "#737373",
      "--chart-4": "#a3a3a3",
      "--chart-5": "#d4d4d4",
      ...FONTS,
      "--radius": "0.5rem",
    },
  },
  dark: {
    dark: true,
    tokens: {
      "--background": "#0a0a0a",
      "--foreground": "#f4f4f4",
      "--card": "#141414",
      "--card-foreground": "#f4f4f4",
      "--muted": "#1c1c1c",
      "--muted-foreground": "#8a8a8a",
      "--primary": "#f4f4f4",
      "--primary-foreground": "#0a0a0a",
      "--accent": "#1c1c1c",
      "--accent-foreground": "#f4f4f4",
      "--border": "#262626",
      "--chart-1": "#f4f4f4",
      "--chart-2": "#c4c4c4",
      "--chart-3": "#8a8a8a",
      "--chart-4": "#5f5f5f",
      "--chart-5": "#404040",
      ...FONTS,
      // `.dark` keeps the light radius.
      "--radius": "0.5rem",
    },
  },
} as const

const LIGHT = FRAME_DEFAULT_THEMES.light.tokens

/**
 * The kit the frame injects into a deck: the stage that shows one slide or all of them, the slide
 * type scale, the layouts a slide picks by class, the slide chrome, and a few components. It reads
 * the app's theme tokens, which the app sends into the frame, with the light defaults until they
 * arrive. Everything sits in cascade layers, so the deck's own CSS, unlayered, always wins.
 */
export const FRAME_KIT_CSS = `
@layer sixb-kit, sixb-theme;

@layer sixb-kit {
  :root {
${Object.entries(LIGHT)
  .map(([name, value]) => `    ${name}: ${value};`)
  .join("\n")}
    --sixb-scale: 1;
    --sixb-overview-scale: 0.25;
    --sixb-columns: 4;
    --sixb-stage: ${LIGHT["--muted"]};
    --sixb-stage-border: ${LIGHT["--border"]};
    --sixb-stage-foreground: ${LIGHT["--foreground"]};
  }

  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--muted);
    color: var(--foreground);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }

  /*
   * The stage: a slide's size and scale, which slides show, and the stage around them, in the
   * app's colors (--sixb-stage and its kin, which only the app's theme sets). A deck's own CSS, unlayered,
   * wins over everything else in the kit, so these alone are important: an important declaration
   * in a layer wins over every unlayered one, a deck's own important ones included. Otherwise a
   * deck that sets display on its closing slide shows it under every other, and one that sets its
   * body's background repaints the stage.
   */
  html.sixb-deck section.slide { width: 1280px !important; height: 720px !important; flex: none !important; }

  /* One slide at a time, scaled to fit and centered on the stage. */
  html.sixb-deck:not([data-mode="overview"]),
  html.sixb-deck:not([data-mode="overview"]) body { height: 100% !important; overflow: hidden !important; }
  html.sixb-deck:not([data-mode="overview"]) body {
    margin: 0 !important;
    padding: 0 !important;
    display: grid !important;
    place-items: center !important;
    background: var(--sixb-stage) !important;
  }
  html.sixb-deck:not([data-mode="overview"]) section.slide { zoom: var(--sixb-scale) !important; }
  html.sixb-deck:not([data-mode="overview"]) section.slide:not([data-current]) { display: none !important; }
  html.sixb-deck[data-mode="slide"] section.slide {
    border-radius: calc(10px / var(--sixb-scale)) !important;
    box-shadow: 0 0 0 calc(1px / var(--sixb-scale)) var(--sixb-stage-border) !important;
  }
  /* Filled, the slide is the whole frame, as a thumbnail or an embed shows it; presented, it
     fills the page on black. */
  html.sixb-deck:is([data-mode="fill"], [data-mode="present"]) section.slide {
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  html.sixb-deck[data-mode="present"] body { background: #000 !important; }

  /* Every slide in a grid. */
  html.sixb-deck[data-mode="overview"],
  html.sixb-deck[data-mode="overview"] body { height: 100% !important; overflow: auto !important; }
  html.sixb-deck[data-mode="overview"] body {
    margin: 0 !important;
    display: grid !important;
    grid-template-columns: repeat(var(--sixb-columns), max-content) !important;
    justify-content: center !important;
    align-content: start !important;
    gap: 16px !important;
    padding: 16px !important;
    background: var(--sixb-stage) !important;
  }
  html.sixb-deck[data-mode="overview"] section.slide {
    zoom: var(--sixb-overview-scale) !important;
    cursor: pointer;
    border-radius: calc(6px / var(--sixb-overview-scale)) !important;
    box-shadow: 0 0 0 calc(1px / var(--sixb-overview-scale)) var(--sixb-stage-border) !important;
  }
  html.sixb-deck[data-mode="overview"] section.slide[data-current] {
    box-shadow: 0 0 0 calc(1px / var(--sixb-overview-scale)) var(--sixb-stage-foreground) !important;
    outline: calc(2px / var(--sixb-overview-scale)) solid var(--sixb-stage-foreground) !important;
    outline-offset: calc(2px / var(--sixb-overview-scale)) !important;
  }

  /*
   * A slide: 1280×720. Its footer, a rule with the source and the slide's number, sits in the
   * bottom padding, so content never runs into it.
   */
  section.slide {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 28px;
    width: 1280px;
    height: 720px;
    flex: none;
    padding: 72px 96px 140px;
    overflow: hidden;
    background: var(--background);
    color: var(--foreground);
    font-size: 28px;
    line-height: 1.4;
  }

  /* Type: nothing on a slide is smaller than 18px. */
  section.slide :is(h1, h2, h3) { margin: 0; text-wrap: balance; }
  section.slide h1 { font-size: 72px; line-height: 1; font-weight: 650; letter-spacing: -0.035em; }
  section.slide h2 { max-width: 1000px; font-size: 46px; line-height: 1.08; font-weight: 600; letter-spacing: -0.025em; }
  section.slide h3 { font-size: 30px; line-height: 1.2; font-weight: 600; letter-spacing: -0.01em; }
  section.slide p { margin: 0; max-width: 34em; }
  section.slide :is(ul, ol) {
    margin: 0;
    padding-left: 30px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    font-size: 30px;
    line-height: 1.35;
    letter-spacing: -0.01em;
  }
  section.slide li { padding-left: 6px; }
  section.slide li::marker { color: var(--muted-foreground); }
  section.slide strong { font-weight: 600; }
  section.slide a { color: inherit; text-decoration-thickness: 2px; text-underline-offset: 5px; }
  section.slide small, section.slide .note { font-size: 20px; color: var(--muted-foreground); }
  section.slide img, section.slide svg, section.slide video { max-width: 100%; max-height: 100%; }
  section.slide code { font-family: var(--font-mono); font-size: 0.85em; }

  /* Chrome: a label above the heading (two spans sit at either end), and the footer. */
  section.slide .eyebrow {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    margin: 0;
    max-width: none;
    font-size: 20px;
    line-height: 1.3;
    letter-spacing: 0.01em;
    color: var(--muted-foreground);
  }
  section.slide .eyebrow + :is(h1, h2) { margin-top: -12px; }
  section.slide::after {
    content: attr(data-number);
    position: absolute;
    left: 96px;
    right: 96px;
    bottom: 64px;
    padding-top: 22px;
    border-top: 1px solid var(--border);
    text-align: right;
    font-size: 18px;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
  }
  section.slide.no-number::after { content: ""; }
  section.slide.no-number:not(:has(.source))::after { display: none; }
  section.slide .source {
    position: absolute;
    left: 96px;
    right: calc(96px + 3em);
    bottom: 64px;
    z-index: 1;
    max-width: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 18px;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
  }

  /* Layouts. */
  section.slide.title > .eyebrow { margin-bottom: auto; }
  section.slide.title h1 { margin-top: 0; font-size: 132px; line-height: 0.92; letter-spacing: -0.04em; max-width: 9em; }
  section.slide.title > p:not(.eyebrow, .source) { font-size: 36px; line-height: 1.25; letter-spacing: -0.01em; color: var(--muted-foreground); max-width: 24em; text-wrap: balance; }

  section.slide.section { justify-content: flex-end; }
  section.slide.section h2 { font-size: 72px; line-height: 1; letter-spacing: -0.035em; max-width: 13em; }

  section.slide.split {
    display: grid;
    grid-template-columns: 5fr 6fr;
    grid-template-rows: auto 1fr;
    column-gap: 80px;
    row-gap: 28px;
  }
  section.slide.split:has(> .eyebrow) { grid-template-rows: auto auto 1fr; }
  section.slide.split > :is(h1, h2, .eyebrow) { grid-column: 1 / -1; }
  section.slide.split > * { min-width: 0; min-height: 0; }
  section.slide.split > :not(h1, h2, .eyebrow) { align-self: center; }

  section.slide.stat > .value { margin-top: auto; }
  section.slide.stat .value {
    font-size: 144px;
    line-height: 0.9;
    font-weight: 600;
    letter-spacing: -0.045em;
    font-variant-numeric: tabular-nums;
    color: var(--primary);
  }
  section.slide.stat .label { font-size: 26px; line-height: 1.35; color: var(--muted-foreground); }
  section.slide.stat .stats {
    margin-top: auto;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: 64px;
    padding-bottom: 16px;
  }
  section.slide.stat .stats > * {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-top: 28px;
    border-top: 2px solid var(--foreground);
  }
  section.slide.stat .stats:has(> :nth-child(3)) .value { font-size: 96px; }
  section.slide.stat .stats:has(> :nth-child(4)) .value { font-size: 80px; }

  section.slide.quote { justify-content: center; }
  section.slide.quote blockquote {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 52px;
    line-height: 1.2;
    letter-spacing: -0.01em;
    max-width: 22em;
    text-wrap: balance;
  }
  section.slide.quote cite { font-style: normal; font-size: 24px; color: var(--muted-foreground); }

  section.slide.image > :is(img, figure) { flex: 1; min-height: 0; margin: 0; object-fit: contain; }
  section.slide.image.bleed { padding: 0; }
  section.slide.image.bleed > img { width: 100%; height: 100%; object-fit: cover; }
  section.slide.image.bleed::after, section.slide.image.bleed .source { display: none; }

  section.slide.chart > :is(figure, svg, img, .chart) { flex: 1; min-height: 0; margin: 0; }
  section.slide.chart figure { display: flex; flex-direction: column; gap: 20px; }
  section.slide.chart figure > :is(svg, img) { flex: 1; min-height: 0; width: 100%; }
  section.slide figcaption { font-size: 20px; color: var(--muted-foreground); }

  section.slide.table table { width: 100%; border-collapse: collapse; font-size: 26px; font-variant-numeric: tabular-nums; }
  section.slide.table :is(th, td) { padding: 14px 16px; border-bottom: 1px solid var(--border); text-align: left; }
  section.slide.table :is(th, td):first-child { padding-left: 0; }
  section.slide.table :is(th, td):last-child { padding-right: 0; }
  section.slide.table th { font-size: 20px; font-weight: 500; color: var(--muted-foreground); }
  section.slide.table :is(th, td).num, section.slide.table :is(th, td)[data-numeric] { text-align: right; }

  /*
   * Another artifact on the slide: the app draws it over this box, sized by the deck's CSS like
   * any block. Until it does, and in a thumbnail, the box shows where it goes.
   */
  sixb-embed {
    display: block;
    position: relative;
    width: 100%;
    min-width: 0;
    aspect-ratio: 16 / 9;
    border-radius: 12px;
    background: color-mix(in oklab, var(--muted) 80%, transparent);
  }
  sixb-embed[title]::after {
    content: attr(title);
    position: absolute;
    inset: auto 24px 20px;
    font-size: 20px;
    color: var(--muted-foreground);
  }
  section.slide.chart > sixb-embed,
  section.slide.chart figure > sixb-embed { flex: 1; min-height: 0; aspect-ratio: auto; }
  /* An image from another artifact its reader cannot see. */
  section.slide img[data-sixb-ref="unavailable"] {
    display: block;
    min-width: 160px;
    min-height: 90px;
    border-radius: 12px;
    background: var(--muted);
  }

  /* Components. */
  section.slide .legend {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 8px 24px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 20px;
    line-height: 1.3;
    letter-spacing: 0;
    color: var(--muted-foreground);
  }
  section.slide .legend > * { display: flex; align-items: center; gap: 8px; padding: 0; }
  section.slide .legend > *::before {
    content: "";
    width: 0.8em;
    height: 0.8em;
    border-radius: 2px;
    background: var(--swatch, var(--chart-1));
  }
  section.slide .callout {
    padding: 24px 28px;
    border-radius: var(--radius);
    background: var(--muted);
    font-size: 26px;
  }
  section.slide .tag {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 999px;
    background: var(--muted);
    font-size: 18px;
    font-weight: 600;
  }
}
`
