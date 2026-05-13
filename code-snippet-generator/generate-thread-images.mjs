import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "assets/thread";

const palette = {
  paper: "#f1ece1",
  paper2: "#ebe4d5",
  paper3: "#e4dcc9",
  ink: "#141310",
  ink2: "#2a2620",
  graphite: "#6b6559",
  rule: "#d9d1c1",
  rule2: "#c9bfa9",
  accent: "#8a2a3a",
  accentDark: "#5e1a26",
  terminalBg: "#14110d",
  terminalFg: "#f1ece1",
  terminalMute: "#8a8273",
  terminalAccent: "#d9a86a",
  green: "#95b985",
  blue: "#8eb6c9",
};

const blocks = [
  {
    name: "01-error-command",
    eyebrow: "failed tx debugging",
    title: "Read a decoded revert like a file",
    lang: "sh",
    lines: ["cat /bloom/chains/base/tx/$TX/error.json"],
  },
  {
    name: "02-error-json",
    eyebrow: "error.json",
    title: "The chain answers with structured context",
    lang: "json",
    lines: [
      "{",
      '  "name": "ExecutionFailed",',
      '  "signature": "ExecutionFailed(uint256,address,string)",',
      '  "args": ["0", "0x...", "Insufficient output"],',
      '  "source": "openchain"',
      "}",
    ],
  },
  {
    name: "03-paths",
    eyebrow: "filesystem surface",
    title: "Ethereum has paths",
    lang: "paths",
    lines: [
      "/bloom/chains/base/head/number",
      "/bloom/chains/base/tx/<hash>/receipt.json",
      "/bloom/chains/base/tx/<hash>/error.json",
      "/bloom/chains/base/addresses/<addr>/balance.eth",
      "/bloom/wallets/alice/chains/base/outbox/new.tx",
      "/bloom/tools/selector/transfer(address,uint256)",
    ],
  },
  {
    name: "04-shell-analysis",
    eyebrow: "shell-native chain analysis",
    title: "Use pipes instead of bespoke RPC scripts",
    lang: "sh",
    lines: [
      "tx=0x...",
      "",
      "status=$(cat /bloom/chains/base/tx/$tx/status)",
      "",
      "cat /bloom/chains/base/tx/$tx/error.json |",
      "  jq '{name, signature, args}'",
    ],
  },
  {
    name: "05-block-pipeline",
    eyebrow: "batch over a block",
    title: "Unix tools become onchain tools",
    lang: "sh",
    lines: [
      "cat /bloom/chains/base/blocks/$BLOCK/full.json |",
      "  jq -r '.transactions[]' |",
      "  head -20 |",
      "  while read tx; do",
      '    echo "$tx $(cat /bloom/chains/base/tx/$tx/status)"',
      "  done",
    ],
  },
  {
    name: "06-stage-write",
    eyebrow: "staged writes",
    title: "Write an intent, not a blind broadcast",
    lang: "sh",
    lines: [
      "cat > /bloom/wallets/alice/chains/base/outbox/new.tx <<'JSON'",
      "{",
      '  "kind": "raw",',
      '  "to": "0x...",',
      '  "value": "0",',
      '  "data": "0x..."',
      "}",
      "JSON",
    ],
  },
  {
    name: "07-outbox-files",
    eyebrow: "outbox",
    title: "A pending transaction is inspectable",
    lang: "paths",
    lines: [
      "/bloom/wallets/alice/chains/base/outbox/pending/<id>/plan.md",
      "/bloom/wallets/alice/chains/base/outbox/pending/<id>/policy_check.json",
      "/bloom/wallets/alice/chains/base/outbox/pending/<id>/confirm",
    ],
  },
];

function esc(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tokenise(line, lang) {
  if (line === "") return [{ text: " ", color: palette.terminalFg }];
  if (lang === "json") {
    const parts = [];
    const regex = /("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\bnull\b)|([{}\[\],:])/g;
    let last = 0;
    let m;
    while ((m = regex.exec(line))) {
      if (m.index > last) parts.push({ text: line.slice(last, m.index), color: palette.terminalFg });
      const text = m[0];
      let color = palette.terminalAccent;
      if (text === ":" || text === "," || text === "{" || text === "}" || text === "[" || text === "]") color = palette.terminalMute;
      if (text === "true" || text === "false" || text === "null") color = palette.blue;
      parts.push({ text, color });
      last = regex.lastIndex;
    }
    if (last < line.length) parts.push({ text: line.slice(last), color: palette.terminalFg });
    return parts;
  }
  if (lang === "paths") {
    return line.split(/(\/|<[^>]+>|[()])/).filter(Boolean).map((part) => {
      if (part === "/") return { text: part, color: palette.terminalMute };
      if (part.startsWith("<")) return { text: part, color: palette.terminalAccent };
      if (part === "(" || part === ")") return { text: part, color: palette.terminalMute };
      if (part === "bloom") return { text: part, color: palette.accent };
      return { text: part, color: palette.terminalFg };
    });
  }
  const parts = [];
  const regex = /(cat|jq|head|while|read|do|done|echo|status|tx|JSON)|(\$[A-Za-z_][A-Za-z0-9_]*|\$\([^)]+\))|('[^']*'|"[^"]*")|(\/bloom\/[^\s|"]+)/g;
  let last = 0;
  let m;
  while ((m = regex.exec(line))) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index), color: palette.terminalFg });
    let color = palette.terminalFg;
    if (m[1]) color = palette.terminalAccent;
    else if (m[2]) color = palette.blue;
    else if (m[3]) color = palette.green;
    else if (m[4]) color = palette.terminalFg;
    parts.push({ text: m[0], color });
    last = regex.lastIndex;
  }
  if (last < line.length) parts.push({ text: line.slice(last), color: palette.terminalFg });
  return parts;
}

function lineSvg(line, lang, x, y) {
  const tokens = tokenise(line, lang);
  const tspans = tokens
    .map((t) => `<tspan fill="${t.color}">${esc(t.text)}</tspan>`)
    .join("");
  return `<text x="${x}" y="${y}" class="code" xml:space="preserve">${tspans}</text>`;
}

function svgFor(block) {
  const width = 1600;
  const height = 900;
  const cardX = 104;
  const cardY = 132;
  const cardW = width - cardX * 2;
  const cardH = height - cardY - 104;
  const codeX = cardX + 76;
  const firstY = cardY + 190;
  const maxLen = Math.max(...block.lines.map((line) => line.length));
  const fontSize = Math.min(38, Math.floor((cardW - 152) / (maxLen * 0.61)));
  const lineH = Math.max(44, Math.round(fontSize * 1.45));

  const code = block.lines
    .map((line, i) => lineSvg(line, block.lang, codeX, firstY + i * lineH))
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="paperNoise" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix values="0 0 0 0 0.10 0 0 0 0 0.08 0 0 0 0 0.05 0 0 0 0.05 0"/>
    </filter>
    <linearGradient id="paperGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${palette.paper}"/>
      <stop offset="0.58" stop-color="${palette.paper2}"/>
      <stop offset="1" stop-color="${palette.paper3}"/>
    </linearGradient>
    <linearGradient id="termGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.terminalBg}"/>
      <stop offset="1" stop-color="#201911"/>
    </linearGradient>
    <style>
      .eyebrow { font: 700 24px Inter, system-ui, sans-serif; letter-spacing: 5px; text-transform: uppercase; fill: ${palette.graphite}; }
      .title { font: 400 58px Georgia, 'Times New Roman', serif; fill: ${palette.ink}; }
      .brand { font: 700 22px 'JetBrains Mono', Menlo, monospace; letter-spacing: 4px; fill: ${palette.terminalMute}; }
      .code { font: 500 ${fontSize}px 'JetBrains Mono', Menlo, monospace; letter-spacing: 0; dominant-baseline: alphabetic; }
    </style>
  </defs>
  <rect width="1600" height="900" fill="url(#paperGrad)"/>
  <rect width="1600" height="900" filter="url(#paperNoise)" opacity="0.55"/>
  <path d="M150 720 C360 620 392 322 614 245 C824 172 1020 254 1168 132 C1268 50 1366 80 1480 104" fill="none" stroke="${palette.rule2}" stroke-width="2" stroke-opacity="0.58"/>
  <circle cx="1350" cy="118" r="10" fill="${palette.accent}" opacity="0.88"/>
  <circle cx="1288" cy="154" r="6" fill="${palette.accent}" opacity="0.64"/>
  <circle cx="1195" cy="115" r="4" fill="${palette.terminalAccent}" opacity="0.74"/>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="12" fill="url(#termGrad)"/>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="12" fill="none" stroke="${palette.accent}" stroke-width="2" stroke-opacity="0.72"/>
  <line x1="${cardX}" y1="${cardY + 78}" x2="${cardX + cardW}" y2="${cardY + 78}" stroke="${palette.rule2}" stroke-opacity="0.18"/>
  <circle cx="${cardX + 38}" cy="${cardY + 39}" r="10" fill="${palette.accent}"/>
  <circle cx="${cardX + 68}" cy="${cardY + 39}" r="10" fill="${palette.terminalAccent}"/>
  <circle cx="${cardX + 98}" cy="${cardY + 39}" r="10" fill="${palette.rule2}"/>
  <text x="${cardX + cardW - 198}" y="${cardY + 48}" class="brand">/BLOOM</text>
  <text x="${codeX}" y="${cardY + 128}" class="code" xml:space="preserve"><tspan fill="${palette.terminalMute}">agent@bloom</tspan><tspan fill="${palette.terminalAccent}">:$</tspan></text>
${code}
  <rect x="${codeX}" y="${firstY + block.lines.length * lineH - 37}" width="24" height="42" fill="${palette.terminalAccent}" opacity="0.9"/>
</svg>`;
}

mkdirSync(OUT_DIR, { recursive: true });

for (const block of blocks) {
  const svg = svgFor(block);
  const svgPath = join(OUT_DIR, `${block.name}.svg`);
  const pngPath = join(OUT_DIR, `${block.name}.png`);
  writeFileSync(svgPath, svg);
  execFileSync("rsvg-convert", ["-w", "1600", "-h", "900", "-o", pngPath, svgPath]);
  console.log(`${svgPath} -> ${pngPath}`);
}
