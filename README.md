# PunksPunksPunks hub (punkspunkspunks.com)

Front door for the family. One input routes to the right site; while you type a
punk number, an instant card shows its BurnedPunks and MuseumPunks entries and
the LostPunks 5y/5y check, V1 and V2 always separate. Nothing is fetched live;
live ownership stays on PunkFinder.

```
npm run sync-data   # rebuild _data/cached/hub.json from the sibling repos
npm run preview     # build and serve at http://localhost:8080
npm run build       # writes _site/
```

No dependencies; nothing to install.

## Deploy (Cloudflare Pages)

- Build command: `node build.mjs`
- Build output directory: `_site`

`build.mjs` injects `_data/cached/hub.json` into `src/index.html` and copies
`images/` plus the root icon files (favicon.svg, favicon.ico, favicon-32.png,
favicon-16.png, apple-touch-icon.png, icon-512.png) into `_site/`.

## /sales (Sold Punks)

`src/sales/` is the Sold Punks live feed: every punk sold in the last 24h, copied
as-is to `_site/sales/` by `build.mjs`. Entirely client-side: native sales from
`indexer.punksmarket.app/sales`, wrapped-punk sales priced by decoding Seaport
`OrderFulfilled` logs from receipts (public RPC). Raw V1 `PunkBought` rows with
buyer == seller are Punks Market's intermediary fix; `sales.js` recovers the
real buyer and seller.

Soft launch: the page carries `noindex` and the hub front page doesn't link to
it yet. Remove both when it's announced. Imports use absolute `/sales/...` paths
because Pages serves the page at `/sales` without a trailing slash.

## Notes

- `scripts/sync-data.mjs` reads BurnedPunks/punks, MuseumPunks/punks and
  institutions, and LostPunks/_data/cached + labels.js. It finds them by walking
  up to the directory holding all three (override with `PUNKSITES_ROOT`).
  The cache is committed so the deploy build doesn't need the siblings.
- Lost scoring matches LostPunks search defaults: burned excluded from V2 only,
  known vaults excluded, never-outbound wallets count as silent, scored at the
  snapshot's sync time. Counts match lostpunks.com search at 5y/5y.
- Re-run `sync-data` after each monthly refresh (not yet wired into
  LostPunks/.github/workflows/monthly-refresh.yml).
- Logo: `images/logos/punkspunkspunks-logo.svg`. Site logos for the sister
  projects live alongside it.
