# Connector icons

Brand marks for the connectors Sixb ships. Atlas bundles them through `ConnectorIcon`, and the docs
connector library serves the same files. The marks belong to their respective owners.

Google Ads reuses the multicolor SVG from `examples/marketing/app/public/logos/google-ads.svg`.
GitHub, Meta, LinkedIn, Notion, QuickBooks, Stripe and TikTok use [Simple Icons](https://github.com/simple-icons/simple-icons)
([CC0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md)). LinkedIn uses release
11.15.0; the others were retrieved from develop. Meta, LinkedIn, QuickBooks and Stripe use their brand color.

The following assets were retrieved from icons linked by the services' official sites:

- `pipedrive.png`: https://cdn.dub-1.pipedriveassets.com/www-main-renderer/_next/static/media/favicon-96x96.9c93b075.png
- `teamleader.ico`: https://www.teamleader.eu/favicon.ico
- `pennylane.ico`: https://www.pennylane.com/favicon.ico
- `mercury.svg`: https://mercury.com/icon.svg?9c0dadf0c8dee356, without its dark-mode style: icons
  sit on a white tile in both themes, where that style made the mark invisible
- `unipile.png`: https://www.unipile.com/wp-content/uploads/2020/12/cropped-favicon-150x150.png
- `companycam.png`: https://cdn.companycam.com/dist/img/site/favicon-96x96-2021.png
- `ace-iot.ico`: https://aceiotsolutions.com/favicon.ico
- `exa.png`: https://exa.ai/images/favicon-32x32.png
- `google.ico`: https://www.google.com/favicon.ico
- `pandadoc.png`: https://files.readme.io/6ffa2ec-small-icon-192-e5478bae7f.png
- `microsoft.ico`: https://learn.microsoft.com/favicon.ico
- `plaud.png`: https://web-static.plaud.ai/plaud-web3/prod-261001-083619-main-7575c8ce1f/favicon-light.png

Adding an icon: drop the file here, then key it by the connector's adapter `type` in
`../components/ConnectorIcon.tsx` and set `icon` in `apps/docs/src/docs/connectorCatalog.ts`.
