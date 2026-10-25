// Serves the static bundle (`out/`) under a sub-path with a generated config.json, the way any static host would.
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { BASE_PATH, FRONTEND, KRAKEN_URL, PORTS, RPC_URL, log } from "./lib.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export function startStaticServer(addresses) {
  const root = join(FRONTEND, "out");
  if (!existsSync(join(root, "trade", "index.html"))) throw new Error("out/ is missing: run `npm run build:static` first.");
  const config = {
    perpEngineAddress: addresses.engine,
    engineLensAddress: addresses.lens,
    houseVaultAddress: addresses.vault,
    rewardTokenAddress: addresses.token,
    agentFactoryAddress: addresses.agentFactory,
    ...(addresses.trailingStops ? { trailingStopsAddress: addresses.trailingStops } : {}),
    ...(addresses.twapOrders ? { twapOrdersAddress: addresses.twapOrders } : {}),
    ...(addresses.strategies ? { strategiesAddress: addresses.strategies } : {}),
    ...(addresses.agentRegistry ? { agentRegistryAddress: addresses.agentRegistry } : {}),
    ...(addresses.prizeDistributor ? { prizeDistributorAddress: addresses.prizeDistributor } : {}),
    usdcAddress: addresses.usdc,
    rpcUrl: RPC_URL,
    chainId: 31337,
    oracleMode: "publisher",
    collateralSymbol: "tUSDC",
    collateralIsTest: true,
    krakenUrl: KRAKEN_URL,
    explorerUrl: "http://127.0.0.1:9",
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/" || url.pathname === BASE_PATH) {
      res.writeHead(302, { location: `${BASE_PATH}/${url.search}` });
      res.end();
      return;
    }
    if (!url.pathname.startsWith(`${BASE_PATH}/`)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Nothing is served outside the sub-path.");
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname.slice(BASE_PATH.length))).replace(/^(\.\.[/\\])+/, "");
    if (rel === "/config.json") {
      res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
      res.end(JSON.stringify(config));
      return;
    }
    let file = join(root, rel);
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        res.writeHead(301, { location: `${url.pathname}/${url.search}` });
        res.end();
        return;
      }
      file = join(file, "index.html");
    }
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": TYPES[".html"] });
      createReadStream(join(root, "404.html")).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  server.listen(PORTS.web, "127.0.0.1", () => log("web", `static bundle on http://127.0.0.1:${PORTS.web}${BASE_PATH}/`));
  return server;
}
