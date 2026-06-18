import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const PNG_SIZE = 1024;
const SW = 30;
// Scale the mark so its largest dimension fills ~69% of the canvas (~15-16%
// edge margin, matching correct-margin.jpg). Tuned for the 17.5deg rotation
// below — a rotated petal no longer reaches straight up, so the mark needs a
// larger scale than the upright version to keep the same footprint. Applied
// uniformly to every asset.
const SCALE = 1.24;
// Rotate the whole mark clockwise (SVG positive rotation = clockwise).
const ROTATE = 17.5;
const CENTER_R = (39.94 * SCALE).toFixed(2);
const LENS = 'M 24.58 0 C 96.09 141.31 209.14 141.31 282.62 0 C 209.14 -141.31 96.09 -141.31 24.58 0 Z';
const ARC_TOP_RIGHT = 'M 24.58 0 C 96.09 141.31 209.14 141.31 282.62 0';
const ARC_TOP_LEFT = 'M 282.62 0 C 209.14 -141.31 96.09 -141.31 24.58 0';

const at = (a) => `transform="translate(512 512) rotate(${(a + ROTATE).toFixed(3)}) scale(${SCALE})"`;
const fillPetal = (a, c) => `<path d="${LENS}" fill="${c}" ${at(a)}></path>`;
const strokePetal = (a, c) => `<path d="${LENS}" fill="none" stroke="${c}" stroke-width="${SW}" ${at(a)}></path>`;
const strokeArc = (d, a, c) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${SW}" ${at(a)}></path>`;

// Braided pinwheel: outlined petal at top, top petal split into two arcs so the
// weave is consistent all the way around (right arc under, left arc over).
function mark(fill, stroke) {
  return [
    '<g stroke-linejoin="round" stroke-linecap="round">',
    strokeArc(ARC_TOP_RIGHT, -90, stroke),
    fillPetal(-30, fill),
    strokePetal(30, stroke),
    fillPetal(90, fill),
    strokePetal(150, stroke),
    fillPetal(210, fill),
    strokeArc(ARC_TOP_LEFT, -90, stroke),
    '</g>',
  ].join('\n');
}

function svg({ bg, fill, stroke, center }) {
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'];
  if (bg) parts.push(`<rect x="0" y="0" width="1024" height="1024" fill="${bg}"></rect>`);
  parts.push(mark(fill, stroke));
  if (center) parts.push(`<circle cx="512" cy="512" r="${CENTER_R}" fill="${center}"></circle>`);
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

const variants = [
  { name: 'bloom-primary',       bg: null,      fill: '#9d2d3f', stroke: '#7a2230', center: null },
  { name: 'bloom-icon-cream',    bg: '#f0ebe0', fill: '#9d2d3f', stroke: '#7a2230', center: '#f0ebe0' },
  { name: 'bloom-icon-white',    bg: '#ffffff', fill: '#9d2d3f', stroke: '#7a2230', center: '#ffffff' },
  { name: 'bloom-icon-black',    bg: '#000000', fill: '#f0ebe0', stroke: '#f0ebe0', center: '#000000' },
  { name: 'bloom-mono-black',    bg: null,      fill: '#1a1a1a', stroke: '#1a1a1a', center: null },
  { name: 'bloom-mono-white',    bg: null,      fill: '#ffffff', stroke: '#ffffff', center: null },
  { name: 'bloom-mono-cream',    bg: null,      fill: '#f0ebe0', stroke: '#f0ebe0', center: null },
  { name: 'bloom-mono-burgundy', bg: null,      fill: '#8a2a3a', stroke: '#8a2a3a', center: null },
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
