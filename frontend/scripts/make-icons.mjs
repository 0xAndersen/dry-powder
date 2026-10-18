// Renders the app icons (PWA, Apple touch icon, social card) from the brand mark with headless Chromium.
//   node scripts/make-icons.mjs   (writes into public/)
import { chromium } from "playwright";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(fileURLToPath(new URL("..", import.meta.url)), "public");
const INK = "#0d0f12";
const PAPER = "#e8ecf1";
const SIGNAL = "#7ea6ff";

/** The vessel mark, drawn in a 24-unit box. */
const mark = (size, inset) => {
  const s = size - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${INK}"/>
  <g transform="translate(${inset} ${inset}) scale(${s / 24})">
    <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5" fill="none" stroke="${PAPER}" stroke-width="1.75"/>
    <rect x="6.5" y="12.25" width="11" height="5.25" rx="1.5" fill="${SIGNAL}"/>
    <path d="M6.5 9.25h11" stroke="${PAPER}" stroke-width="1.25" stroke-linecap="round" stroke-dasharray="1.5 2.25" opacity="0.55"/>
  </g>
</svg>`;
};

const icons = [
  { file: "icon-192.png", size: 192, inset: 22 },
  { file: "icon-512.png", size: 512, inset: 58 },
  // Maskable: the platform may crop to a circle, so the mark stays inside the central 80%.
  { file: "icon-maskable-512.png", size: 512, inset: 112 },
  { file: "apple-touch-icon.png", size: 180, inset: 22 },
];

const card = `<!doctype html><html><head><style>
  body{margin:0;width:1200px;height:630px;background:${INK};color:${PAPER};font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;justify-content:space-between;padding:72px;box-sizing:border-box}
  .row{display:flex;align-items:center;gap:20px;font-size:40px;font-weight:650;letter-spacing:-0.02em}
  h1{font-size:76px;line-height:1.02;letter-spacing:-0.035em;margin:0;font-weight:650;max-width:980px}
  h1 span{color:${SIGNAL}}
  p{margin:0;font-size:28px;color:#a0a9b6}
  .foot{display:flex;justify-content:space-between;align-items:flex-end}
  .chip{border:1px solid #384049;border-radius:999px;padding:10px 20px;font-size:24px;color:#a0a9b6}
</style></head><body>
  <div class="row">${mark(64, 0).replace(`<rect width="64" height="64" fill="${INK}"/>`, "")}Dry Powder</div>
  <div><h1>Up to 1000x. <span>See the most you can lose</span> before you trade.</h1></div>
  <div class="foot"><p>Open perpetuals on Arc, built for people and AI agents.</p><span class="chip">USDC everywhere</span></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const icon of icons) {
  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(`<html><body style="margin:0">${mark(icon.size, icon.inset)}</body></html>`);
  await page.screenshot({ path: join(out, icon.file), omitBackground: false });
}
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(card);
await page.screenshot({ path: join(out, "og-card.png") });
await browser.close();
console.log("icons written to", out);
