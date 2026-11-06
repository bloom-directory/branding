# Social preview (OG) images

`og-image.mjs` turns a Bloom social-card SVG into the PNG that `og:image`
metadata points at, and stamps the PNG with the SHA-256 of the SVG it came
from. That stamp is what lets CI catch an edited SVG with a stale PNG without
installing a rasteriser.

| File | What it is |
|------|-----------|
| [`bloom-og.svg`](bloom-og.svg) | Artwork proposed for the website social preview in website PR #91 |
| [`bloom-og.png`](bloom-og.png) | 1200×630 render of it, stamped with the SVG's digest |
| [`og-image.mjs`](og-image.mjs) | The renderer and checker (Node, no npm dependencies) |
| [`og-image.test.mjs`](og-image.test.mjs) | `node --test og/og-image.test.mjs` |

## Usage

```sh
node og/og-image.mjs                   # rebuild og/bloom-og.png from the SVG
node og/og-image.mjs --check           # fail if the committed PNG is stale
node og/og-image.mjs --in card.svg     # any other card; writes card.png
node og/og-image.mjs --in card.svg --out dist/card.png --width 800 --height 420
```

| Flag | Meaning |
|------|---------|
| `--in <file>` | Source SVG. Default: `og/bloom-og.svg` |
| `--out <file>` | Destination PNG. Default: the input path with a `.png` extension, so the bundled default writes `og/bloom-og.png` |
| `--check` | Compare the PNG's stamp with the SVG; exit 1 when stale. Reads bytes only |
| `--width`, `--height` | Override the size. Default: whatever the SVG's `width`/`height` declare, falling back to its `viewBox`, then to 1200×630 |
| `--font-dir <dir>` | Rasterise with the fonts already in `<dir>`; never touches the network |
| `--font-cache <dir>` | Where pinned faces are downloaded. Default: `og/.font-cache` (git-ignored) |
| `--offline` | Fail instead of downloading a missing pinned face |
| `-h`, `--help` | Usage |

It is also importable, for scripts that want the pieces rather than the CLI:
`buildOgImage`, `checkOgImage`, `ensureFonts`, `renderPng`, `ogSourceDigest`,
`stampPngSource`, `readPngSourceDigest`, `readPngChunks`, `readPngSize`,
`readSvgSize`.

## Dependencies

- **Node 18+** — nothing from npm; there is no `package.json` to install.
- **`rsvg-convert`** for rendering: `apt install librsvg2-bin` on
  Debian/Ubuntu, `brew install librsvg` on macOS. Missing it is an error that
  says so, naming both packages.
- **The three brand faces**, which the SVGs name rather than embed:
  Instrument Serif (regular + italic), Inter Tight (400, 500) and JetBrains
  Mono (400, 500). They are downloaded once from `fonts.gstatic.com` into
  `og/.font-cache` and **pinned by SHA-256**, so a rerun years from now either
  uses the same bytes or fails loudly. The renderer shows `rsvg-convert` only
  that directory — no system fonts — so a missing face can never quietly
  become a system serif.
- **Network**, only on the first render (or after `og/.font-cache` is
  cleared).

Pinning the fonts does not pin the rasteriser: a different librsvg, cairo or
pango can still shift pixels, which is why the stamp records the *source*
rather than a hash of the output.

## Offline and check behaviour

- `--check` never renders. No `rsvg-convert`, no fonts, no network — it reads
  the SVG, hashes it, and compares that with the `bloom-og-source` `tEXt`
  chunk in the PNG. This is the cheap gate CI runs on every change.
- `--font-dir <dir>` renders from faces you already have and makes no network
  request. An empty or non-existent directory is an error rather than a silent
  fallback to system fonts.
- `--offline` keeps the download path but refuses to use it: a face that is
  missing from the cache, or whose bytes no longer match its pin, fails with
  the cache path in the message.
- Nothing is left behind. The fontconfig config and font cache the renderer
  needs live in a `mkdtemp` directory that is removed whether the render
  succeeds or throws; `og/.font-cache` is the only persistent state, and it is
  safe to delete at any time.

## Compatibility with the website

The stamp keyword is `bloom-og-source` and the digest is a plain SHA-256 of
the SVG bytes — identical to the generator in the website repo
(`scripts/og-image.ts`), with the same pinned font URLs and digests. The two
produce interchangeable PNGs: `og/bloom-og.png` here is byte-for-byte the PNG
the site ships, and either repo's checker accepts the other's output.

`og-image.test.mjs` holds that line. Besides the stamp and PNG-chunk
contracts, it renders the committed SVG for real and compares the result with
the committed PNG pixel by pixel, tolerating antialiasing differences between
librsvg builds but not moved or restyled type. The rendering tests skip
themselves with a reason when `rsvg-convert` is missing or the font cache is
cold with no network; CI installs librsvg, so there they always run.
