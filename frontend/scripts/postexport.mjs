// Finishes `npm run build:static`.
//
// Next exports every route one directory deep (trade/index.html, ...) with assets referenced as "../_next/...",
// which is what makes the bundle work under any sub-path. Two files sit at the root, where "../" would point
// outside the bundle, so they are replaced with tiny hand-written pages that only use relative links:
//   - index.html: forwards to the mode the visitor chose (./simple/ unless they picked Advanced, ./trade/) and keeps
//     the query string (deployment overrides, ?account=).
//   - 404.html:   static hosts serve it for unknown paths at any depth, so it only offers a link back.
// A sample config.json is written if the bundle has none.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out");
if (!existsSync(join(out, "trade", "index.html"))) {
  console.error("postexport: out/trade/index.html is missing. Did the static build run?");
  process.exit(1);
}

// Stylesheets live in _next/static/css/, so the asset prefix that is right for pages ("../_next/static/media/…")
// points one level too deep from there. Fonts sit next to the css directory.
const cssDir = join(out, "_next", "static", "css");
for (const name of existsSync(cssDir) ? readdirSync(cssDir) : []) {
  if (!name.endsWith(".css")) continue;
  const file = join(cssDir, name);
  const css = readFileSync(file, "utf8");
  const fixed = css.replaceAll("../_next/static/media/", "../media/");
  if (fixed !== css) writeFileSync(file, fixed);
}

const style =
  "html{color-scheme:dark;background:#1b1a18;color:#f1ebe0;font:14px/1.45 system-ui,sans-serif}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}a{color:#ff7a1a}";

writeFileSync(
  join(out, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dry Powder</title>
<link rel="icon" href="./favicon.svg">
<style>${style}</style>
<script>var m=null;try{m=JSON.parse(localStorage.getItem("dp:ui-mode:v1"))}catch(e){}location.replace((m==="advanced"?"./trade/":"./simple/")+location.search+location.hash);</script>
<noscript><meta http-equiv="refresh" content="0; url=./simple/"></noscript>
</head>
<body><p>Opening <a href="./simple/">Dry Powder</a>&hellip;</p></body>
</html>
`,
);

writeFileSync(
  join(out, "404.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found | Dry Powder</title>
<style>${style}</style>
</head>
<body>
<div>
<h1 style="font-size:22px;margin:0 0 8px">This page does not exist</h1>
<p style="color:#b0a898;margin:0 0 16px">The address may be mistyped. Pages live at <code>simple/</code>, <code>trade/</code>, <code>markets/</code>, <code>charts/</code>, <code>portfolio/</code>, <code>activity/</code>, <code>leaderboard/</code>, <code>house/</code> and <code>agents/</code>, with the trailing slash.</p>
<p><a id="home" href="./trade/">Go to trading</a></p>
</div>
<script>
// Unknown paths can be any depth below the app, so find the app root from a known page name when there is one.
(function () {
  var m = location.pathname.match(/^(.*?\\/)(trade|markets|portfolio|activity|leaderboard|trader|house|agents|simple|charts)(\\.html)?$/);
  if (m) { location.replace(m[1] + m[2] + "/" + location.search); return; }
})();
</script>
</body>
</html>
`,
);

// Files Next emits for its own router that a static host never needs at the root.
for (const name of ["index.txt", "404"]) {
  rmSync(join(out, name), { recursive: true, force: true });
}

const sample = join(out, "config.sample.json");
writeFileSync(
  sample,
  `${JSON.stringify(
    {
      perpEngineAddress: "0x…",
      engineLensAddress: "0x…",
      houseVaultAddress: "0x…",
      agentFactoryAddress: "0x…",
      trailingStopsAddress: "0x…",
      twapOrdersAddress: "0x…",
      strategiesAddress: "0x…",
      agentRegistryAddress: "0x…",
      prizeDistributorAddress: "0x…",
      rewardTokenAddress: "0x…",
      usdcAddress: "0x3600000000000000000000000000000000000000",
      rpcUrl: "https://rpc.testnet.arc.io",
      chainId: 5042002,
      oracleMode: "publisher",
      collateralSymbol: "USDC",
      collateralIsTest: false,
      krakenUrl: "https://api.kraken.com",
      explorerUrl: "https://explorer.testnet.arc.io",
    },
    null,
    2,
  )}\n`,
);

// Service worker: stamp it with this build's id so a new deployment replaces the cached shell.
const swFile = join(out, "sw.js");
if (existsSync(swFile)) {
  const staticDir = join(out, "_next", "static");
  const buildId = readdirSync(staticDir).find((name) => !["chunks", "css", "media"].includes(name)) ?? String(Date.now());
  writeFileSync(swFile, readFileSync(swFile, "utf8").replace("__SW_VERSION__", buildId));
}

const html = readFileSync(join(out, "trade", "index.html"), "utf8");
const absolute = html.match(/(?:src|href)="\/(?!\/)[^"]*"/g) ?? [];
if (absolute.length > 0) {
  console.error("postexport: the export still contains root-absolute asset URLs, which break under a sub-path:");
  for (const hit of absolute.slice(0, 10)) console.error("  " + hit);
  process.exit(1);
}
console.log("postexport: out/ is ready (index.html and 404.html rewritten, config.sample.json written).");
