import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const PNG_SIZE = 1024;
const SW = 30;
const SCALE = 1.24;
// Rotate the whole mark clockwise (SVG positive rotation = clockwise).
const ROTATE = 17.5;
const CENTER_R = (39.94 * SCALE).toFixed(2);
// Negative overlap: outlined petals knock a hole through the petal beneath them.
// 'none' = off; 'all' = every variant; 'mono' = only single-color marks
// (fill === stroke), where the weave is otherwise invisible.
const KNOCKOUT = 'mono';
// Dedicated favicon assets (mono marks only) are drawn larger to fill the tab
// icon, and rasterized at small sizes.
const FAV_SCALE = 1.80;
const FAV_SIZES = [16, 32, 48];

// Distance from center to the tip of the stroke-only petals, as a fraction of
// the filled petals' length (1 = same as filled; lower = outlined petals end
// earlier, still starting from the same center point).
const STROKE_LEN = 1.00;
// Area-preserving "tip pull" for the stroke-only petals: stretch along the
// petal axis (x by g, y by 1/g) so the outer point moves out/in from the
// center while each petal's area stays the same. 1 = unchanged; >1 pulls the
// tip out and narrows; <1 pulls it in and fattens.
const STROKE_TIP = 1.00;

// Petal geometry, anchored at the inner point ANCHOR on the +x axis. f shrinks
// the petal about that anchor (same start, ends earlier); g is the area-
// preserving tip pull (stretches x, compresses y).
const ANCHOR = 24.58, TIP = 282.62, CX1 = 96.09, CX2 = 209.14, CW = 141.31;
const sx = (x, f, g = 1) => (ANCHOR + (x - ANCHOR) * f * g).toFixed(2);
const sy = (y, f, g = 1) => (y * f / g).toFixed(2);
const lens = (f, g = 1) => `M ${ANCHOR} 0 C ${sx(CX1, f, g)} ${sy(CW, f, g)} ${sx(CX2, f, g)} ${sy(CW, f, g)} ${sx(TIP, f, g)} 0 C ${sx(CX2, f, g)} ${sy(-CW, f, g)} ${sx(CX1, f, g)} ${sy(-CW, f, g)} ${ANCHOR} 0 Z`;
const arcRight = (f, g = 1) => `M ${ANCHOR} 0 C ${sx(CX1, f, g)} ${sy(CW, f, g)} ${sx(CX2, f, g)} ${sy(CW, f, g)} ${sx(TIP, f, g)} 0`;
const arcLeft = (f, g = 1) => `M ${sx(TIP, f, g)} 0 C ${sx(CX2, f, g)} ${sy(-CW, f, g)} ${sx(CX1, f, g)} ${sy(-CW, f, g)} ${ANCHOR} 0`;

const at = (a, s = SCALE) => `transform="translate(512 512) rotate(${(a + ROTATE).toFixed(3)}) scale(${s})"`;
const fillPetal = (a, c, s) => `<path d="${lens(1)}" fill="${c}" ${at(a, s)}></path>`;
const strokePetal = (a, c, s) => `<path d="${lens(STROKE_LEN, STROKE_TIP)}" fill="none" stroke="${c}" stroke-width="${SW}" ${at(a, s)}></path>`;
const strokeArc = (d, a, c, s) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${SW}" ${at(a, s)}></path>`;

// Braided pinwheel: outlined petal at top, top petal split into two arcs so the
// weave is consistent all the way around (right arc under, left arc over).
function mark(fill, stroke, s) {
  return [
    '<g stroke-linejoin="round" stroke-linecap="round">',
    strokeArc(arcRight(STROKE_LEN, STROKE_TIP), -90, stroke, s),
    fillPetal(-30, fill, s),
    strokePetal(30, stroke, s),
    fillPetal(90, fill, s),
    strokePetal(150, stroke, s),
    fillPetal(210, fill, s),
    strokeArc(arcLeft(STROKE_LEN, STROKE_TIP), -90, stroke, s),
    '</g>',
  ].join('\n');
}

// Luminance mask mirroring mark()'s weave: white keeps ink, black cuts a hole.
// Outlined petals fill black (knock out the filled petal beneath) but keep a
// white outline; later filled petals repaint white, preserving the weave.
function maskMark(s) {
  const fp = (a) => `<path d="${lens(1)}" fill="#fff" ${at(a, s)}></path>`;
  const sp = (a) => `<path d="${lens(STROKE_LEN, STROKE_TIP)}" fill="#000" stroke="#fff" stroke-width="${SW}" ${at(a, s)}></path>`;
  const sa = (d, a) => `<path d="${d}" fill="#000" stroke="#fff" stroke-width="${SW}" ${at(a, s)}></path>`;
  return [
    '<g stroke-linejoin="round" stroke-linecap="round">',
    sa(arcRight(STROKE_LEN, STROKE_TIP), -90),
    fp(-30), sp(30), fp(90), sp(150), fp(210),
    sa(arcLeft(STROKE_LEN, STROKE_TIP), -90),
    '</g>',
  ].join('\n');
}

function svg({ bg, fill, stroke, center, scale = SCALE, centerR = CENTER_R }) {
  const knock = KNOCKOUT === 'all' || (KNOCKOUT === 'mono' && fill === stroke);
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'];
  if (bg) parts.push(`<rect x="0" y="0" width="1024" height="1024" fill="${bg}"></rect>`);
  if (knock) {
    parts.push('<defs><mask id="knockout" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">');
    parts.push(maskMark(scale));
    parts.push('</mask></defs>');
    parts.push(`<g mask="url(#knockout)">${mark(fill, stroke, scale)}</g>`);
  } else {
    parts.push(mark(fill, stroke, scale));
  }
  if (center) parts.push(`<circle cx="512" cy="512" r="${centerR}" fill="${center}"></circle>`);
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

const FILL = '#9d2d3f', STROKE = '#7a2230', CREAM = '#f0ebe0';
const WHITE = '#ffffff', BLACK = '#000000', INK = '#1a1a1a', BURG = '#8a2a3a';

const variants = [
  { name: 'bloom-primary',       bg: null,  fill: FILL,  stroke: STROKE, center: null  },
  { name: 'bloom-icon-cream',    bg: CREAM, fill: FILL,  stroke: STROKE, center: CREAM },
  { name: 'bloom-icon-white',    bg: WHITE, fill: FILL,  stroke: STROKE, center: WHITE },
  { name: 'bloom-icon-black',    bg: BLACK, fill: CREAM, stroke: CREAM,  center: BLACK },
  { name: 'bloom-mono-black',    bg: null,  fill: INK,   stroke: INK,    center: null  },
  { name: 'bloom-mono-white',    bg: null,  fill: WHITE, stroke: WHITE,  center: null  },
  { name: 'bloom-mono-cream',    bg: null,  fill: CREAM, stroke: CREAM,  center: null  },
  { name: 'bloom-mono-burgundy', bg: null,  fill: BURG,  stroke: BURG,   center: null  },
];

// Every SVG must get a matching PNG. Preflight the renderer and fail closed if
// it's missing, rather than silently emitting SVGs with no PNGs.
try {
  execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('error: rsvg-convert not found — refusing to emit SVGs without matching PNGs.');
  console.error('install it with: brew install librsvg');
  process.exit(1);
}

for (const v of variants) {
  const svgPath = `${dir}/${v.name}.svg`;
  const pngPath = `${dir}/${v.name}.png`;
  writeFileSync(svgPath, svg(v));
  // execFileSync throws on non-zero exit, so a render failure aborts the build.
  execFileSync('rsvg-convert', ['-w', String(PNG_SIZE), '-h', String(PNG_SIZE), svgPath, '-o', pngPath]);
  console.log('wrote', v.name + '.svg + .png');
}

// Dedicated favicon assets for the mono marks: drawn at FAV_SCALE to fill the
// tab icon, as an SVG plus small PNG fallbacks.
for (const v of variants.filter((x) => x.name.startsWith('bloom-mono-'))) {
  const base = v.name + '-favicon';
  const svgPath = `${dir}/${base}.svg`;
  writeFileSync(svgPath, svg({ ...v, scale: FAV_SCALE }));
  for (const size of FAV_SIZES) {
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svgPath, '-o', `${dir}/${base}-${size}.png`]);
  }
  console.log('wrote', base + '.svg + ' + FAV_SIZES.map((s) => s + 'px').join('/') + ' PNGs');
}
