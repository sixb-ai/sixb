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
 * What every frame's kit starts from: the theme's tokens, with the light defaults until the app's
 * arrive, and the document's base. The rules a layout adds sit in the same layer, and everything
 * sits in cascade layers, so an artifact's own CSS, unlayered, always wins.
 */
function kit(rules: string): string {
  return `
@layer sixb-kit, sixb-theme;

@layer sixb-kit {
  :root {
${Object.entries(LIGHT)
  .map(([name, value]) => `    ${name}: ${value};`)
  .join("\n")}
  }

  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    color: var(--foreground);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }

${rules}}
`
}

/**
 * A deck's kit: the stage that shows one slide or all of them, the slide type scale, the layouts a
 * slide picks by class, the slide chrome, and a few components.
 */
export const FRAME_DECK_CSS = kit(`  :root {
    --sixb-scale: 1;
    --sixb-overview-scale: 0.25;
    --sixb-columns: 4;
    --sixb-stage: ${LIGHT["--muted"]};
    --sixb-stage-border: ${LIGHT["--border"]};
    --sixb-stage-foreground: ${LIGHT["--foreground"]};
  }
  body { background: var(--muted); }

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
  /* A figure's default 40px margins would squeeze a chart and its labels below the type floor. */
  section.slide figure { margin: 0; }
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
`)

/**
 * A page's kit: what makes plain HTML read as a finished page in the app's theme. A measured type
 * scale; tables, forms, and buttons drawn like the app's; a centered column for `<main>`; and a
 * few components a page picks by class: `.lede`, `.eyebrow`, `.card`, `.grid`, `.stat`, `.tag`,
 * `.callout`. Every rule sits in the kit's layer, so a page's own CSS wins wherever it differs.
 */
export const FRAME_PAGE_CSS = kit(`  html { color-scheme: light; }
  html.dark { color-scheme: dark; }
  body {
    background: var(--background);
    font-size: 15px;
    line-height: 1.6;
    text-rendering: optimizeLegibility;
  }

  /* A page reads in a centered column with room around it, narrower on a phone. */
  main { display: block; max-width: 1120px; margin: 0 auto; padding: 40px 32px 56px; }
  @media (max-width: 640px) { main { padding: 24px 16px 40px; } }

  /* Type. */
  :is(h1, h2, h3, h4) { margin: 0 0 0.5em; color: var(--foreground); text-wrap: balance; }
  h1 { font-size: 32px; line-height: 1.15; font-weight: 650; letter-spacing: -0.025em; }
  h2 { margin-top: 1.6em; font-size: 21px; line-height: 1.25; font-weight: 620; letter-spacing: -0.015em; }
  h3 { margin-top: 1.4em; font-size: 16px; line-height: 1.35; font-weight: 600; }
  h4 { font-size: 14px; font-weight: 600; }
  :is(h1, h2, h3, h4):first-child { margin-top: 0; }
  @media (max-width: 640px) { h1 { font-size: 26px; } h2 { font-size: 19px; } }
  p { margin: 0 0 1em; text-wrap: pretty; }
  .lede { max-width: 42em; margin-bottom: 1.6em; font-size: 17px; line-height: 1.55; color: var(--muted-foreground); }
  .eyebrow {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }
  small, .muted { color: var(--muted-foreground); }
  small { font-size: 13px; }
  a { color: var(--foreground); text-decoration-color: color-mix(in oklab, var(--foreground) 35%, transparent); text-underline-offset: 3px; }
  a:hover { text-decoration-color: currentColor; }
  strong { font-weight: 600; }
  hr { margin: 32px 0; border: 0; border-top: 1px solid var(--border); }
  :is(ul, ol) { margin: 0 0 1em; padding-left: 1.25em; }
  li + li { margin-top: 0.25em; }
  code { font-family: var(--font-mono); font-size: 0.88em; padding: 0.1em 0.35em; border-radius: 5px; background: var(--muted); }
  pre { margin: 0 0 1em; padding: 14px 16px; overflow-x: auto; border-radius: var(--radius); background: var(--muted); font-size: 13px; line-height: 1.5; }
  pre code { padding: 0; background: none; }
  img, svg, video, canvas { max-width: 100%; }
  img, video { height: auto; }

  /* Tables: hairline rows, quiet headers, numbers aligned. Wide ones scroll in their box. */
  table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
  :is(th, td) { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  th { font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--muted-foreground); white-space: nowrap; }
  :is(th, td):first-child { padding-left: 0; }
  :is(th, td):last-child { padding-right: 0; }
  :is(th, td).num, :is(th, td)[data-numeric] { text-align: right; }
  .table-scroll { overflow-x: auto; }

  /* Forms and buttons, drawn like the app's. */
  label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 550; }
  :is(input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"]), select, textarea) {
    width: 100%;
    min-height: 36px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    background: var(--card);
    color: var(--foreground);
    font: inherit;
    font-size: 14px;
    line-height: 1.4;
    box-shadow: 0 1px 1px rgb(0 0 0 / 0.03);
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  :is(input, select, textarea):focus-visible {
    outline: none;
    border-color: color-mix(in oklab, var(--foreground) 45%, var(--border));
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--foreground) 12%, transparent);
  }
  input[type="range"], input[type="checkbox"], input[type="radio"] { accent-color: var(--primary); }
  textarea { min-height: 88px; resize: vertical; }
  button, .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: calc(var(--radius) - 2px);
    background: var(--primary);
    color: var(--primary-foreground);
    font: inherit;
    font-size: 14px;
    font-weight: 550;
    text-decoration: none;
    cursor: pointer;
    transition: background-color 0.12s, border-color 0.12s, opacity 0.12s;
  }
  :is(button, .button):hover { background: color-mix(in oklab, var(--primary) 88%, var(--background)); }
  :is(button, .button):focus-visible { outline: 2px solid var(--ring, var(--foreground)); outline-offset: 2px; }
  :is(button, .button):disabled { opacity: 0.5; cursor: default; }
  :is(button, .button).secondary { border-color: var(--border); background: var(--card); color: var(--foreground); }
  :is(button, .button).secondary:hover { background: var(--muted); }
  :is(button, .button).ghost { background: transparent; color: var(--foreground); }
  :is(button, .button).ghost:hover { background: var(--muted); }
  fieldset { margin: 0 0 16px; padding: 0; border: 0; }
  .field { margin-bottom: 16px; }

  /* Components. */
  .card {
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--card-foreground);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
  }
  .card > :last-child { margin-bottom: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px; margin-bottom: 24px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .stat .label { font-size: 13px; color: var(--muted-foreground); }
  .stat .value { margin-top: 4px; font-size: 30px; line-height: 1.1; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .stat .delta { margin-top: 6px; font-size: 13px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: 999px;
    background: var(--muted);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.6;
  }
  .callout { margin: 0 0 1em; padding: 14px 16px; border-radius: var(--radius); background: var(--muted); }
  .callout > :last-child { margin-bottom: 0; }

  /*
   * Another artifact on the page: the app draws it over this box, sized by the page's CSS like any
   * block. Until it does, the box shows where it goes.
   */
  sixb-embed {
    display: block;
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    margin-bottom: 1em;
    border-radius: var(--radius);
    background: var(--muted);
  }
  sixb-embed[title]::after {
    content: attr(title);
    position: absolute;
    inset: auto 16px 12px;
    font-size: 13px;
    color: var(--muted-foreground);
  }
  img[data-sixb-ref="unavailable"] { display: block; min-width: 120px; min-height: 68px; border-radius: var(--radius); background: var(--muted); }
`)
