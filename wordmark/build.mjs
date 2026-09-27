import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

// The /bloom wordmark, measured from banner.png. All geometry is in font units
// (Instrument Serif Italic, 1000 units/em), baseline at y = 0, y pointing down.

// Letter-spacing between glyphs (-0.04em), as set on the banner.
const TRACKING = -40;
// The slash is a drawn round-capped stroke, not the font's "/" glyph. It leans
// at the font's italic angle and runs from above the ascender to below the
// baseline. X_BASE is where its centerline crosses the baseline, relative to
// the origin of the "b".
const SLASH_ANGLE = 13;
const SLASH_TOP = 775;
const SLASH_BOTTOM = 115;
const SLASH_X_BASE = -188;
const SLASH_W = 28;
// Default rendered size of the transparent SVGs (their viewBox is in font units).
const OUT_SCALE = 0.25;
// Background variants reproduce the banner's framing: a 1806×786 canvas with
// the wordmark spanning ~30.5% of the width, centered horizontally and sat
// slightly below center (optical centering, in font units).
const BANNER_W = 1806, BANNER_H = 786, BANNER_FILL = 0.305, BANNER_DROP = 42;

const CREAM = '#f0ebe0';
const BURGUNDY_MID = '#8a2a3a';
const INK = '#1a1a1a';
const BLACK = '#000000';
const WHITE = '#ffffff';

// Outlines of Instrument Serif Italic (OFL, © The Instrument Serif Project
// Authors), extracted per glyph with the origin at (0, 0).
const GLYPHS = {
  b: { adv: 431, d: 'M136 9Q102 9 75.5-9.5Q49-28 38.5-65.5Q28-103 41-159L153-640Q158-658 153.5-665Q149-672 135-673L105-676Q90-677 92-689Q94-698 106-700Q142-706 170-714.5Q198-723 215-737Q223-743 230-743Q242-743 239-728L148-335Q147-328 151-327Q155-326 158-332Q213-437 256.5-476.5Q300-516 338-516Q375-516 396.5-485Q418-454 418-394Q418-337 401.5-279.5Q385-222 356.5-170Q328-118 291.5-78Q255-38 215-14.5Q175 9 136 9M139-16Q165-16 194-39.5Q223-63 250.5-102.5Q278-142 300-191.5Q322-241 335-293.5Q348-346 348-395Q348-433 340-448.5Q332-464 312-464Q290-464 262-437Q234-410 205-365.5Q176-321 151-269Q126-217 111-166.5Q96-116 96-77Q96-16 139-16' },
  l: { adv: 240, d: 'M74 10Q41 10 27-14.5Q13-39 26-95L153-640Q158-658 153.5-665Q149-672 135-673L105-676Q90-677 92-689Q94-698 106-700Q142-706 170-714.5Q198-723 215-737Q223-743 230-743Q242-743 239-728L91-94Q86-72 89.5-59.5Q93-47 108-47Q126-47 147.5-73.5Q169-100 196-174Q200-187 210-187Q225-187 218-169Q197-101 171.5-61.5Q146-22 121-6Q96 10 74 10' },
  o: { adv: 414, d: 'M154 9Q92 9 56-42.5Q20-94 20-182Q20-247 41-307Q62-367 96.5-414Q131-461 173.5-488.5Q216-516 259-516Q321-516 357-465Q393-414 393-325Q393-260 372-200Q351-140 316.5-93Q282-46 239.5-18.5Q197 9 154 9M152-15Q184-15 214.5-46Q245-77 270-128Q295-179 310-241.5Q325-304 325-367Q325-492 260-492Q229-492 198-461.5Q167-431 142.5-380Q118-329 103-266.5Q88-204 88-141Q88-15 152-15' },
  m: { adv: 745, d: 'M591 9Q555 9 537-21Q519-51 535-114L612-404Q623-443 615.5-458Q608-473 594-473Q574-473 548-445.5Q522-418 493.5-371Q465-324 438-264Q411-204 388-139Q365-74 350-11Q347 0 336 0L297 0Q283 0 286-13L378-404Q387-443 380.5-458Q374-473 360-473Q341-473 315-445.5Q289-418 261-371Q233-324 206-264Q179-204 156-139Q133-74 119-11Q116 0 105 0L64 0Q50 0 53-13L148-412Q153-434 149.5-446.5Q146-459 131-459Q113-459 91.5-432.5Q70-406 43-332Q39-319 29-319Q14-319 21-337Q43-406 67.5-445Q92-484 117-500Q142-516 163-516Q196-516 210-491.5Q224-467 211-411L186-303Q185-296 189-295Q193-294 196-300Q254-420 301-468Q348-516 387-516Q424-516 439.5-486Q455-456 441-394L420-303Q419-296 423-295Q427-294 430-300Q468-381 501.5-428.5Q535-476 565-496Q595-516 621-516Q658-516 675-486Q692-456 675-394L599-104Q592-76 598-62Q604-48 620-48Q640-48 659.5-74.5Q679-101 700-175Q703-186 713-186Q721-186 722.5-180Q724-174 722-166Q703-98 681-59.5Q659-21 636.5-6Q614 9 591 9' },
};

// Lay out "bloom" left to right; each glyph is placed with a translate.
const letters = [];
let pen = 0;
for (const c of 'bloom') {
  letters.push({ x: pen, d: GLYPHS[c].d });
  pen += GLYPHS[c].adv + TRACKING;
}

const tan = Math.tan((SLASH_ANGLE * Math.PI) / 180);
const slash = {
  x1: SLASH_X_BASE + SLASH_TOP * tan, y1: -SLASH_TOP,
  x2: SLASH_X_BASE - SLASH_BOTTOM * tan, y2: SLASH_BOTTOM,
};

// Ink bounds: the slash (with its round caps) and the glyph extents
// (ascender -743, descender 10, right edge of the "m" at 722).
const half = SLASH_W / 2;
const box = {
  x0: Math.floor(slash.x2 - half),
  y0: Math.floor(slash.y1 - half),
  x1: Math.ceil(letters[4].x + 722),
  y1: Math.ceil(slash.y2 + half),
};
const boxW = box.x1 - box.x0, boxH = box.y1 - box.y0;

const f = (n) => +n.toFixed(2);

function wordmark(slashColor, textColor) {
  return [
    `<line x1="${f(slash.x1)}" y1="${f(slash.y1)}" x2="${f(slash.x2)}" y2="${f(slash.y2)}" stroke="${slashColor}" stroke-width="${SLASH_W}" stroke-linecap="round"/>`,
    `<g fill="${textColor}">`,
    ...letters.map(({ x, d }) => `<path transform="translate(${x} 0)" d="${d}"/>`),
    '</g>',
  ].join('\n');
}

// Transparent: tight viewBox around the ink.
function svg({ slash, text }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(boxW * OUT_SCALE)}" height="${f(boxH * OUT_SCALE)}" viewBox="${box.x0} ${box.y0} ${boxW} ${boxH}">`,
    wordmark(slash, text),
    '</svg>',
    '',
  ].join('\n');
}

// On a background: banner framing, wordmark centered.
function bannerSvg({ bg, slash, text }) {
  const vw = boxW / BANNER_FILL, vh = vw * (BANNER_H / BANNER_W);
  const vx = box.x0 - (vw - boxW) / 2, vy = box.y0 - (vh - boxH) / 2 - BANNER_DROP;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER_W}" height="${BANNER_H}" viewBox="${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}">`,
    `<rect x="${f(vx)}" y="${f(vy)}" width="${f(vw)}" height="${f(vh)}" fill="${bg}"/>`,
    wordmark(slash, text),
    '</svg>',
    '',
  ].join('\n');
}

const variants = [
  { name: 'bloom-wordmark', slash: BURGUNDY_MID, text: INK },
  { name: 'bloom-wordmark-reversed', slash: BURGUNDY_MID, text: CREAM },
  { name: 'bloom-wordmark-mono-black', slash: INK, text: INK },
  { name: 'bloom-wordmark-mono-white', slash: WHITE, text: WHITE },
  { name: 'bloom-wordmark-mono-cream', slash: CREAM, text: CREAM },
  { name: 'bloom-wordmark-mono-burgundy', slash: BURGUNDY_MID, text: BURGUNDY_MID },
];
const banners = [
  { name: 'bloom-wordmark-banner-cream', bg: CREAM, slash: BURGUNDY_MID, text: INK },
  { name: 'bloom-wordmark-banner-black', bg: BLACK, slash: BURGUNDY_MID, text: CREAM },
];

for (const v of variants) writeFileSync(`${dir}/${v.name}.svg`, svg(v));
for (const v of banners) writeFileSync(`${dir}/${v.name}.svg`, bannerSvg(v));
console.log(`wrote ${variants.length + banners.length} SVGs to ${dir}`);
