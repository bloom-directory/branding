/**
 * Covers og/og-image.mjs end to end: the PNG stamp reader and writer, the
 * digest-stamp contract the website's own generator shares, a real
 * rsvg-convert render compared pixel-for-pixel against the committed PNG, and
 * the ways the CLI is meant to fail.
 *
 *   node --test og/
 *
 * The rendering tests need `rsvg-convert` and the pinned fonts. When the
 * rasteriser is missing, or the font cache is cold and there is no network,
 * they skip with a reason instead of failing — CI installs librsvg and has
 * egress, so there they always run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import {
  DEFAULT_PNG_PATH,
  DEFAULT_SVG_PATH,
  FONTS,
  OG_HEIGHT,
  OG_SOURCE_KEYWORD,
  OG_WIDTH,
  ensureFonts,
  ogSourceDigest,
  readPngChunks,
  readPngSize,
  readPngSourceDigest,
  readSvgSize,
  stampPngSource,
} from "./og-image.mjs";

const CLI = fileURLToPath(new URL("./og-image.mjs", import.meta.url));
const svg = readFileSync(DEFAULT_SVG_PATH);
const png = readFileSync(DEFAULT_PNG_PATH);

const scratch = mkdtempSync(resolve(tmpdir(), "og-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const run = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 120_000 });

/** A directory inside the scratch area, fresh on every call. */
function dir(name) {
  const path = resolve(scratch, name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

// Decide up front what the rendering tests can actually do: node:test needs
// the skip reason when the test is defined, not when it runs.
const rasteriser = spawnSync("rsvg-convert", ["--version"], { encoding: "utf8" });
const noRasteriser = rasteriser.error ? "rsvg-convert is not installed" : null;
let fontDir = null;
let noFonts = null;
try {
  fontDir = await ensureFonts({});
} catch (error) {
  noFonts = `pinned fonts unavailable: ${error.message.split("\n")[0]}`;
}
const cannotRender = noRasteriser ?? noFonts;

/** node:test treats a present `skip` key as a skip, so omit it when able. */
const unless = (reason) => (reason ? { skip: reason } : {});

// --------------------------------------------------------------- stamp bytes

describe("source digest", () => {
  it("hashes the SVG bytes", () => {
    assert.equal(ogSourceDigest(svg), createHash("sha256").update(svg).digest("hex"));
    assert.match(ogSourceDigest(svg), /^[0-9a-f]{64}$/);
  });

  it("changes when the SVG changes", () => {
    assert.notEqual(ogSourceDigest(`${svg}\n`), ogSourceDigest(svg));
  });
});

describe("png stamp", () => {
  it("keeps the website's keyword so PNGs stay interchangeable", () => {
    assert.equal(OG_SOURCE_KEYWORD, "bloom-og-source");
  });

  it("stamps the committed PNG with the committed SVG's digest", () => {
    assert.equal(readPngSourceDigest(png), ogSourceDigest(svg));
  });

  it("writes the stamp as a single tEXt chunk directly after IHDR", () => {
    const chunks = readPngChunks(png);
    const stamps = chunks.filter(
      (chunk) =>
        chunk.type === "tEXt" &&
        new TextDecoder("latin1").decode(chunk.data).startsWith(`${OG_SOURCE_KEYWORD}\0`),
    );
    assert.equal(stamps.length, 1);
    assert.equal(chunks[0]?.type, "IHDR");
    assert.equal(chunks[1], stamps[0]);
    assert.equal(chunks.at(-1)?.type, "IEND");
  });

  it("replaces an earlier stamp instead of appending one", () => {
    const restamped = stampPngSource(stampPngSource(png, "a".repeat(64)), "b".repeat(64));
    assert.equal(readPngSourceDigest(restamped), "b".repeat(64));
    assert.equal(readPngChunks(restamped).filter((chunk) => chunk.type === "tEXt").length, 1);
    assert.deepEqual(readPngSize(restamped), readPngSize(png));
  });

  it("preserves every other chunk, in order", () => {
    const before = readPngChunks(png).map((chunk) => chunk.type);
    const after = readPngChunks(stampPngSource(png, "c".repeat(64))).map((chunk) => chunk.type);
    assert.deepEqual(after, before);
  });

  it("reports an unstamped PNG rather than guessing", () => {
    const bare = rebuild(readPngChunks(png).filter((chunk) => chunk.type !== "tEXt"));
    assert.equal(readPngSourceDigest(bare), null);
  });

  it("refuses bytes that are not a readable PNG", () => {
    assert.throws(() => readPngChunks(Buffer.from("<svg/>")), /not a PNG file/);
    assert.throws(() => readPngChunks(png.subarray(0, png.length - 4)), /truncated/);
  });
});

describe("svg size", () => {
  it("reads the bundled card's declared size", () => {
    assert.deepEqual(readSvgSize(svg), { width: OG_WIDTH, height: OG_HEIGHT });
    assert.deepEqual([OG_WIDTH, OG_HEIGHT], [1200, 630]);
  });

  it("falls back to the viewBox when width and height are absent", () => {
    assert.deepEqual(readSvgSize('<svg viewBox="0 0 800 400"></svg>'), {
      width: 800,
      height: 400,
    });
  });

  it("returns nulls when the SVG declares no size at all", () => {
    assert.deepEqual(readSvgSize("<svg></svg>"), { width: null, height: null });
  });
});

describe("pinned fonts", () => {
  it("pins every face by sha256", () => {
    for (const font of FONTS) {
      assert.match(font.sha256, /^[0-9a-f]{64}$/);
      assert.match(font.url, /^https:\/\/fonts\.gstatic\.com\//);
    }
    assert.equal(new Set(FONTS.map((font) => font.file)).size, FONTS.length);
  });

  it(
    "leaves the cache holding exactly the pinned bytes",
    unless(noFonts),
    () => {
      for (const font of FONTS) {
        const bytes = readFileSync(resolve(fontDir, font.file));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), font.sha256);
      }
    },
  );
});

// ----------------------------------------------------------------- rendering

describe("rendering", () => {
  it(
    "reproduces the committed website PNG from the committed SVG",
    unless(cannotRender),
    () => {
      const out = resolve(dir("render"), "og.png");
      const tempBefore = strayTempDirs();
      const result = run("--in", DEFAULT_SVG_PATH, "--out", out, "--font-dir", fontDir);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /wrote .*og\.png \(1200x630/);

      const rendered = readFileSync(out);
      assert.deepEqual(readPngSize(rendered), { width: OG_WIDTH, height: OG_HEIGHT });
      assert.equal(readPngSourceDigest(rendered), ogSourceDigest(svg));

      // Same artwork as the website ships. Tolerant of a different librsvg,
      // cairo or pango nudging antialiasing, but not of moved or restyled
      // type: a shifted line lights up thousands of pixels, not a handful.
      const diff = comparePixels(decodeRgb(rendered), decodeRgb(png));
      assert.ok(
        diff.meanAbs < 1 && diff.changedFraction < 0.01,
        `render drifted from the committed PNG: mean |Δ| ${diff.meanAbs.toFixed(3)}, ` +
          `${(diff.changedFraction * 100).toFixed(2)}% of pixels differ`,
      );

      assert.deepEqual(strayTempDirs(), tempBefore, "left fontconfig scratch behind in tmpdir");
    },
  );

  it(
    "defaults the output next to the input and honours a size override",
    unless(cannotRender),
    () => {
      const work = dir("sized");
      const source = resolve(work, "card.svg");
      writeFileSync(
        source,
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">' +
          '<rect width="200" height="100" fill="#f4efe6"/>' +
          '<text x="10" y="60" font-family="Instrument Serif" font-size="40" font-style="italic">/bloom</text>' +
          "</svg>",
      );

      const declared = run("--in", source, "--font-dir", fontDir);
      assert.equal(declared.status, 0, declared.stderr);
      const sidecar = resolve(work, "card.png");
      assert.ok(existsSync(sidecar), "did not write card.png beside card.svg");
      assert.deepEqual(readPngSize(readFileSync(sidecar)), { width: 200, height: 100 });

      const scaled = run("--in", source, "--out", resolve(work, "2x.png"), "--width", "400",
        "--height", "200", "--font-dir", fontDir);
      assert.equal(scaled.status, 0, scaled.stderr);
      assert.deepEqual(readPngSize(readFileSync(resolve(work, "2x.png"))), {
        width: 400,
        height: 200,
      });
    },
  );

  it(
    "sets type in the pinned faces rather than a system fallback",
    unless(cannotRender),
    () => {
      const work = dir("faces");
      const source = resolve(work, "serif.svg");
      writeFileSync(
        source,
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80">' +
          '<rect width="300" height="80" fill="#ffffff"/>' +
          '<text x="8" y="56" font-family="Instrument Serif" font-size="48" font-style="italic" fill="#15130f">bloom</text>' +
          "</svg>",
      );

      const withBrand = resolve(work, "brand.png");
      assert.equal(run("--in", source, "--out", withBrand, "--font-dir", fontDir).status, 0);

      // The same SVG rendered against a lone monospace face has to look
      // different, or the font directory was being ignored.
      const monoOnly = dir("mono-only");
      copyFileSync(
        resolve(fontDir, "jetbrains-mono-400.ttf"),
        resolve(monoOnly, "jetbrains-mono-400.ttf"),
      );
      const withMono = resolve(work, "mono.png");
      assert.equal(run("--in", source, "--out", withMono, "--font-dir", monoOnly).status, 0);

      const diff = comparePixels(decodeRgb(readFileSync(withBrand)), decodeRgb(readFileSync(withMono)));
      assert.ok(
        diff.changedFraction > 0.01,
        "Instrument Serif and a monospace fallback rendered the same pixels",
      );
    },
  );
});

// ------------------------------------------------------------------ cli: check

describe("--check", () => {
  it("passes on the committed pair without a rasteriser, fonts or network", () => {
    const result = run("--check");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bloom-og\.png is up to date with .*bloom-og\.svg/);
    assert.equal(result.stderr, "");
  });

  it("fails when the SVG has been edited without rerunning the build", () => {
    const work = dir("stale");
    const source = resolve(work, "bloom-og.svg");
    writeFileSync(source, `${svg}\n<!-- edited -->`);
    copyFileSync(DEFAULT_PNG_PATH, resolve(work, "bloom-og.png"));

    const result = run("--check", "--in", source);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is stale \(stamp [0-9a-f]{64}, svg [0-9a-f]{64}\)/);
    assert.match(result.stderr, /and commit the result/);
  });

  it("reports a missing PNG as a missing stamp", () => {
    const work = dir("no-png");
    copyFileSync(DEFAULT_SVG_PATH, resolve(work, "bloom-og.svg"));
    const result = run("--check", "--in", resolve(work, "bloom-og.svg"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is stale \(stamp missing/);
  });

  it("rejects an unstamped PNG", () => {
    const work = dir("unstamped");
    copyFileSync(DEFAULT_SVG_PATH, resolve(work, "bloom-og.svg"));
    const bare = rebuild(readPngChunks(png).filter((chunk) => chunk.type !== "tEXt"));
    writeFileSync(resolve(work, "bloom-og.png"), bare);
    const result = run("--check", "--in", resolve(work, "bloom-og.svg"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stamp missing/);
  });
});

// --------------------------------------------------------------- cli: failures

describe("failures", () => {
  it("explains a missing source SVG", () => {
    const result = run("--in", resolve(scratch, "nope.svg"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source SVG not found: .*nope\.svg/);
  });

  it("rejects an unknown flag with usage", () => {
    const result = run("--bogus");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: node og\/og-image\.mjs/);
  });

  it("rejects a non-numeric size", () => {
    const result = run("--width", "wide");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--width must be a positive integer/);
  });

  it("rejects a --font-dir that is not a directory", () => {
    const result = run("--font-dir", DEFAULT_SVG_PATH, "--out", resolve(scratch, "x.png"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a directory/);
  });

  it("rejects a --font-dir with no faces in it rather than falling back", () => {
    const result = run("--font-dir", dir("empty-fonts"), "--out", resolve(scratch, "x.png"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /holds no font files/);
    assert.match(result.stderr, /instrument-serif-italic\.ttf/);
  });

  it("refuses to fetch a missing face under --offline", () => {
    const result = run(
      "--offline",
      "--font-cache",
      dir("cold-cache"),
      "--out",
      resolve(scratch, "x.png"),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not in the font cache/);
    assert.match(result.stderr, /--offline forbids fetching it/);
  });

  it("prints usage for --help and exits cleanly", () => {
    const result = run("--help");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--check/);
    assert.match(result.stdout, /rsvg-convert/);
  });
});

// ------------------------------------------------------------------- helpers

/** Temporary fontconfig scratch directories the renderer should clean up. */
function strayTempDirs() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("bloom-og-"))
    .sort();
}

/**
 * Reassembles chunks into a PNG so a test can hand the reader a doctored file.
 * The CRCs are left zeroed: readPngChunks walks the chunk lengths and never
 * checks them, and a real decoder is never pointed at the result.
 */
function rebuild(chunks) {
  const parts = chunks.map(({ type, data }) => {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, "latin1");
    chunk.set(data, 8);
    return chunk;
  });
  return Buffer.concat([png.subarray(0, 8), ...parts]);
}

/**
 * Minimal decoder for the 8-bit truecolour, non-interlaced PNGs rsvg-convert
 * emits: inflates the IDAT stream and undoes the per-row filters, returning
 * tightly packed RGB bytes.
 */
function decodeRgb(bytes) {
  const chunks = readPngChunks(bytes);
  const header = chunks.find((chunk) => chunk.type === "IHDR").data;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const [depth, colorType, , , interlace] = [header[8], header[9], header[10], header[11], header[12]];
  assert.deepEqual([depth, colorType, interlace], [8, 2, 0], "unexpected PNG format");

  const idat = Buffer.concat(
    chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => Buffer.from(chunk.data)),
  );
  const raw = inflateSync(idat);
  const stride = width * 3;
  const out = Buffer.alloc(height * stride);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[offset + x];
      const left = x >= 3 ? row[x - 3] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= 3 ? prior[x - 3] : 0;
      row[x] =
        filter === 0
          ? value
          : filter === 1
            ? (value + left) & 0xff
            : filter === 2
              ? (value + up) & 0xff
              : filter === 3
                ? (value + ((left + up) >> 1)) & 0xff
                : (value + paeth(left, up, upLeft)) & 0xff;
    }
    offset += stride;
  }
  return { width, height, pixels: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Mean absolute channel difference and the share of pixels that moved. */
function comparePixels(a, b) {
  assert.deepEqual([a.width, a.height], [b.width, b.height], "images differ in size");
  let total = 0;
  let changed = 0;
  for (let i = 0; i < a.pixels.length; i += 3) {
    const delta =
      Math.abs(a.pixels[i] - b.pixels[i]) +
      Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
      Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
    total += delta;
    if (delta > 12) changed += 1;
  }
  const pixels = a.pixels.length / 3;
  return { meanAbs: total / a.pixels.length, changedFraction: changed / pixels };
}
