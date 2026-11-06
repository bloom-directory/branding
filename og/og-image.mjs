#!/usr/bin/env node
/**
 * Renders a Bloom social-preview SVG into the PNG that social metadata points
 * at, so drift between the two gets caught in CI.
 *
 *   node og/og-image.mjs                  rebuild og/bloom-og.png from the SVG
 *   node og/og-image.mjs --check          fail if the committed PNG is stale
 *   node og/og-image.mjs --in a.svg --out a.png      any other pair
 *
 * The PNG carries a `tEXt` chunk holding the SHA-256 of the SVG it was made
 * from. `--check` reads that stamp, so CI catches an edited SVG with a stale
 * PNG without needing a rasteriser, fonts or network access. The keyword is
 * the same `bloom-og-source` the website's own generator writes, so PNGs stay
 * interchangeable between the two repos.
 *
 * Rendering needs `rsvg-convert` (Debian/Ubuntu: librsvg2-bin, macOS: brew
 * install librsvg). The font files the SVGs ask for are downloaded once into
 * og/.font-cache and pinned by SHA-256, so text is always set in the brand's
 * own faces rather than silently falling back to a system serif; `--font-dir`
 * points at a local copy instead and never touches the network. Pinning the
 * fonts does not pin the rasteriser: a different librsvg, cairo or pango can
 * still shift pixels, which is why the stamp records the source rather than a
 * hash of the output.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

/** The bundled defaults: the artwork the website ships as its OG image. */
export const DEFAULT_SVG_PATH = resolve(here, "bloom-og.svg");
export const DEFAULT_PNG_PATH = resolve(here, "bloom-og.png");

/** The canonical social-card size, used when an SVG declares no dimensions. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Keyword of the PNG tEXt chunk that records the source SVG's digest. */
export const OG_SOURCE_KEYWORD = "bloom-og-source";

/** Where downloaded faces land. Git-ignored; safe to delete at any time. */
export const DEFAULT_FONT_CACHE_DIR = resolve(here, ".font-cache");

/**
 * The three families the brand sets type in, trimmed to the weights and styles
 * the SVGs use, pinned by digest so a rerun years from now either uses the
 * same faces or fails loudly. Identical URLs and digests to the website's
 * generator, so both repos rasterise with the same bytes.
 */
export const FONTS = [
  {
    file: "instrument-serif-italic.ttf",
    url: "https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zATiw.ttf",
    sha256: "fecf4861d5202405b8bd45c683858b6870642a026784fe0dbf88ff55dedee8a0",
  },
  {
    file: "instrument-serif-regular.ttf",
    url: "https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-2zI.ttf",
    sha256: "a99e3db50076202713812ed541feeb23ffeebb61db1fa6b1cf48fe590d37ef18",
  },
  {
    file: "inter-tight-400.ttf",
    url: "https://fonts.gstatic.com/s/intertight/v9/NGSnv5HMAFg6IuGlBNMjxJEL2VmU3NS7Z2mjDw-qXA.ttf",
    sha256: "27350bc95b961b9b4e1a80d872f49e903fe727f290f6b2a079e67ceb1685fb1f",
  },
  {
    file: "inter-tight-500.ttf",
    url: "https://fonts.gstatic.com/s/intertight/v9/NGSnv5HMAFg6IuGlBNMjxJEL2VmU3NS7Z2mjPQ-qXA.ttf",
    sha256: "c2a4bdafb30500a3bd0843f95ad659ad38492f025837803e6a8ef8672c575e8e",
  },
  {
    file: "jetbrains-mono-400.ttf",
    url: "https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjPQ.ttf",
    sha256: "44ce4a84f20d60f24539bd0cef11f79c29e38609e0f8adf18551c9794a5d9dc3",
  },
  {
    file: "jetbrains-mono-500.ttf",
    url: "https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8-qxjPQ.ttf",
    sha256: "3386a05f6ece969e4537de6be894170d20558e82f7d56c8c5d332972ef172160",
  },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The digest a freshly rendered PNG should be stamped with. */
export function ogSourceDigest(svg) {
  return sha256(svg);
}

// ------------------------------------------------------------------ png bits

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function assertPng(png) {
  const signed = PNG_SIGNATURE.every((byte, index) => png[index] === byte);
  if (!signed) throw new Error("not a PNG file");
}

/** Splits a PNG into its chunks; throws on anything that is not a valid PNG. */
export function readPngChunks(png) {
  assertPng(png);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > png.length) throw new Error(`truncated ${type} chunk`);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset = end;
    if (type === "IEND") break;
  }
  return chunks;
}

/** Pixel dimensions straight out of the PNG header. */
export function readPngSize(png) {
  const header = readPngChunks(png).find((chunk) => chunk.type === "IHDR");
  if (!header) throw new Error("PNG has no IHDR chunk");
  const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
  return { width: view.getUint32(0), height: view.getUint32(4) };
}

/** The source digest this PNG was stamped with, or null when unstamped. */
export function readPngSourceDigest(png) {
  for (const chunk of readPngChunks(png)) {
    if (chunk.type !== "tEXt") continue;
    const separator = chunk.data.indexOf(0);
    if (separator < 0) continue;
    const keyword = new TextDecoder("latin1").decode(chunk.data.subarray(0, separator));
    if (keyword !== OG_SOURCE_KEYWORD) continue;
    return new TextDecoder("latin1").decode(chunk.data.subarray(separator + 1));
  }
  return null;
}

function encodeChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * Rewrites the PNG with a single `bloom-og-source` tEXt chunk holding the
 * digest, placed right after IHDR. Any earlier stamp is replaced.
 */
export function stampPngSource(png, digest) {
  const encoder = new TextEncoder();
  const stamp = encodeChunk(
    "tEXt",
    new Uint8Array([...encoder.encode(OG_SOURCE_KEYWORD), 0, ...encoder.encode(digest)]),
  );
  const parts = [new Uint8Array(PNG_SIGNATURE)];
  for (const chunk of readPngChunks(png)) {
    if (chunk.type === "tEXt") {
      const separator = chunk.data.indexOf(0);
      const keyword = new TextDecoder("latin1").decode(
        chunk.data.subarray(0, separator < 0 ? chunk.data.length : separator),
      );
      if (keyword === OG_SOURCE_KEYWORD) continue;
    }
    parts.push(encodeChunk(chunk.type, chunk.data));
    if (chunk.type === "IHDR") parts.push(stamp);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// -------------------------------------------------------------------- source

/**
 * The pixel size an SVG asks to be rendered at, from its `width`/`height` or,
 * failing that, its `viewBox`. Returns nulls when the SVG declares neither, in
 * which case the caller falls back to the canonical card size.
 */
export function readSvgSize(svg) {
  const source = typeof svg === "string" ? svg : new TextDecoder().decode(svg);
  const root = source.slice(source.indexOf("<svg"));
  const attr = (name) => {
    const match = root.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`));
    if (!match) return null;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  };
  let width = attr("width");
  let height = attr("height");
  if (width === null || height === null) {
    const box = root.match(/\sviewBox\s*=\s*"([^"]*)"/);
    const parts = box ? box[1].trim().split(/[\s,]+/).map(Number) : [];
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      width ??= Math.round(parts[2]);
      height ??= Math.round(parts[3]);
    }
  }
  return { width, height };
}

// ----------------------------------------------------------------- rendering

const FONT_FILE = /\.(ttf|otf|ttc|woff2?)$/i;

function fontFilesIn(dir) {
  try {
    return readdirSync(dir).filter((name) => FONT_FILE.test(name));
  } catch {
    return [];
  }
}

/**
 * Makes sure every pinned face is present in `cacheDir`, downloading the ones
 * that are missing or whose bytes no longer match their digest, and returns
 * the directory. `offline` turns a missing face into an error instead of a
 * fetch, which is what CI wants when it has a warm cache and no egress.
 */
export async function ensureFonts({
  cacheDir = DEFAULT_FONT_CACHE_DIR,
  offline = false,
  log = () => {},
} = {}) {
  mkdirSync(cacheDir, { recursive: true });
  for (const font of FONTS) {
    const path = resolve(cacheDir, font.file);
    if (existsSync(path) && sha256(readFileSync(path)) === font.sha256) continue;
    if (offline) {
      throw new Error(
        `${font.file} is not in the font cache (${cacheDir}) and --offline forbids fetching it.\n` +
          "Drop the pinned faces in that directory, or point --font-dir at a local copy.",
      );
    }
    log(`fetching ${font.file}\n`);
    const response = await fetch(font.url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`${font.url} -> HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = sha256(bytes);
    if (digest !== font.sha256) {
      throw new Error(`${font.file} changed upstream: expected ${font.sha256}, got ${digest}`);
    }
    writeFileSync(path, bytes);
  }
  return cacheDir;
}

/**
 * Rasterises `svgPath` at the given size with `rsvg-convert`, seeing only the
 * fonts in `fontDir`. The fontconfig config and its cache live in a temporary
 * directory that is removed again whether or not the render succeeds.
 */
export function renderPng({ svgPath, fontDir, width = OG_WIDTH, height = OG_HEIGHT }) {
  const scratch = mkdtempSync(resolve(tmpdir(), "bloom-og-"));
  try {
    const cacheDir = resolve(scratch, "fontconfig");
    mkdirSync(cacheDir, { recursive: true });
    const configPath = resolve(scratch, "fonts.conf");
    writeFileSync(
      configPath,
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${fontDir}</dir>\n  <cachedir>${cacheDir}</cachedir>\n</fontconfig>\n`,
    );
    return new Uint8Array(
      execFileSync("rsvg-convert", ["--width", String(width), "--height", String(height), svgPath], {
        env: { ...process.env, FONTCONFIG_FILE: configPath },
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (error) {
    if (error?.code === "ENOENT" && error?.syscall?.includes("spawn")) {
      throw new Error("rsvg-convert not found. Install librsvg2-bin (Linux) or librsvg (brew).");
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ commands

/**
 * Compares the digest stamped into `pngPath` with the current `svgPath`. Pure
 * byte reading: no rasteriser, no fonts, no network.
 */
export function checkOgImage({ svgPath = DEFAULT_SVG_PATH, pngPath = DEFAULT_PNG_PATH } = {}) {
  const svg = readSourceSvg(svgPath);
  const expected = ogSourceDigest(svg);
  const stamped = existsSync(pngPath) ? readPngSourceDigest(readFileSync(pngPath)) : null;
  return { ok: stamped === expected, expected, stamped, svgPath, pngPath };
}

/** Renders `svgPath` to `pngPath`, stamped with the source digest. */
export async function buildOgImage({
  svgPath = DEFAULT_SVG_PATH,
  pngPath = DEFAULT_PNG_PATH,
  width,
  height,
  fontDir,
  fontCacheDir = DEFAULT_FONT_CACHE_DIR,
  offline = false,
  log = () => {},
} = {}) {
  const svg = readSourceSvg(svgPath);
  const declared = readSvgSize(svg);
  const target = {
    width: width ?? declared.width ?? OG_WIDTH,
    height: height ?? declared.height ?? OG_HEIGHT,
  };

  let fonts = fontDir;
  if (fonts === undefined) {
    fonts = await ensureFonts({ cacheDir: fontCacheDir, offline, log });
  } else {
    fonts = resolve(fonts);
    if (!existsSync(fonts) || !statSync(fonts).isDirectory()) {
      throw new Error(`--font-dir ${fonts} is not a directory`);
    }
    if (fontFilesIn(fonts).length === 0) {
      throw new Error(
        `--font-dir ${fonts} holds no font files.\n` +
          `Expected the pinned faces: ${FONTS.map((font) => font.file).join(", ")}`,
      );
    }
  }

  const png = stampPngSource(renderPng({ svgPath, fontDir: fonts, ...target }), ogSourceDigest(svg));
  const { width: gotWidth, height: gotHeight } = readPngSize(png);
  if (gotWidth !== target.width || gotHeight !== target.height) {
    throw new Error(`rendered ${gotWidth}x${gotHeight}, expected ${target.width}x${target.height}`);
  }
  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(pngPath, png);
  return { pngPath, bytes: png.length, ...target };
}

function readSourceSvg(svgPath) {
  try {
    return readFileSync(svgPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`source SVG not found: ${svgPath}`);
    throw error;
  }
}

// ----------------------------------------------------------------------- cli

const USAGE = `Renders a Bloom social-preview SVG to a digest-stamped PNG.

Usage: node og/og-image.mjs [options]

  --in <file>         source SVG            (default: og/bloom-og.svg)
  --out <file>        destination PNG       (default: the input with .png,
                                             i.e. og/bloom-og.png)
  --check             compare the PNG's stamp with the SVG and exit 1 when
                      stale; reads bytes only, so no rasteriser, fonts or
                      network are needed
  --width <px>        override the size the SVG declares
  --height <px>
  --font-dir <dir>    rasterise with the fonts already in <dir> instead of
                      downloading the pinned faces (never hits the network)
  --font-cache <dir>  where pinned faces are downloaded to
                      (default: og/.font-cache)
  --offline           fail instead of downloading a missing pinned face
  -h, --help          this text

Rendering needs rsvg-convert: apt install librsvg2-bin, or brew install librsvg.`;

function pngPathFor(svgPath) {
  return svgPath.replace(/\.svg$/i, "") + ".png";
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        in: { type: "string" },
        out: { type: "string" },
        check: { type: "boolean", default: false },
        width: { type: "string" },
        height: { type: "string" },
        "font-dir": { type: "string" },
        "font-cache": { type: "string" },
        offline: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const svgPath = values.in ? resolve(values.in) : DEFAULT_SVG_PATH;
  const pngPath = values.out
    ? resolve(values.out)
    : values.in
      ? pngPathFor(svgPath)
      : DEFAULT_PNG_PATH;
  const show = (path) => {
    const rel = relative(process.cwd(), path);
    return rel && !rel.startsWith("..") ? rel : path;
  };

  const size = {};
  for (const key of ["width", "height"]) {
    if (values[key] === undefined) continue;
    const value = Number.parseInt(values[key], 10);
    if (!Number.isFinite(value) || value <= 0) {
      process.stderr.write(`--${key} must be a positive integer, got ${values[key]}\n`);
      return 2;
    }
    size[key] = value;
  }

  try {
    if (values.check) {
      const { ok, expected, stamped } = checkOgImage({ svgPath, pngPath });
      if (ok) {
        process.stdout.write(`${show(pngPath)} is up to date with ${show(svgPath)}\n`);
        return 0;
      }
      process.stderr.write(
        `${show(pngPath)} is stale (stamp ${stamped ?? "missing"}, svg ${expected}).\n` +
          `Run \`node ${show(resolve(here, "og-image.mjs"))}\` and commit the result.\n`,
      );
      return 1;
    }

    const result = await buildOgImage({
      svgPath,
      pngPath,
      ...size,
      fontDir: values["font-dir"],
      fontCacheDir: values["font-cache"] ? resolve(values["font-cache"]) : DEFAULT_FONT_CACHE_DIR,
      offline: values.offline,
      log: (line) => process.stderr.write(line),
    });
    process.stdout.write(
      `wrote ${show(result.pngPath)} (${result.width}x${result.height}, ` +
        `${(result.bytes / 1024).toFixed(1)} kB)\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
