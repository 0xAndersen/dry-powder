// A stand-in for Kraken's public REST API (Ticker and OHLC), answering with Kraken's own result-key spellings
// (XXBTZUSD for XBTUSD, ...) so the UI's key matching is exercised.
import http from "node:http";
import { FEEDS, PORTS, log } from "./lib.mjs";

const byPair = Object.fromEntries(Object.entries(FEEDS).map(([key, f]) => [f.kraken, { key, resultKey: f.krakenKey }]));

export function startKrakenMock(model) {
  const frozenTicker = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("content-type", "application/json");
    // Test controls, not part of Kraken. /control/freeze stops or resumes on-chain publishing of one feed (a stale
    // oracle); /control/move shifts a feed's price by a percentage at once.
    if (url.pathname === "/control/freeze") {
      const feed = url.searchParams.get("feed") ?? "";
      if (!FEEDS[feed]) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: ["unknown feed"] }));
        return;
      }
      model.freeze(feed, url.searchParams.get("on") !== "0");
      res.end(JSON.stringify({ frozen: [...model.frozen] }));
      return;
    }
    if (url.pathname === "/control/move") {
      const feed = url.searchParams.get("feed") ?? "";
      const percent = Number(url.searchParams.get("pct"));
      if (!FEEDS[feed] || !Number.isFinite(percent)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: ["unknown feed or pct"] }));
        return;
      }
      model.move(feed, percent);
      res.end(JSON.stringify({ feed, price: model.mid(feed) }));
      return;
    }
    const pairs = (url.searchParams.get("pair") ?? "").split(",").filter(Boolean);
    const unknown = pairs.filter((p) => !byPair[p]);
    if (pairs.length === 0 || unknown.length > 0) {
      res.end(JSON.stringify({ error: ["EQuery:Unknown asset pair"] }));
      return;
    }
    if (url.pathname === "/0/public/Ticker") {
      const result = {};
      for (const pair of pairs) {
        const key = byPair[pair].key;
        // A frozen feed looks like a closed market on Kraken: the ticker stops changing.
        if (!model.frozen.has(key)) delete frozenTicker[key];
        const t = model.frozen.has(key) ? (frozenTicker[key] ??= { ...model.ticker(key) }) : model.ticker(key);
        result[byPair[pair].resultKey] = { a: [t.ask, "1", "1.000"], b: [t.bid, "1", "1.000"], c: [t.last, "0.01"] };
      }
      res.end(JSON.stringify({ error: [], result }));
      return;
    }
    if (url.pathname === "/0/public/OHLC") {
      const minutes = Number(url.searchParams.get("interval") ?? 1);
      const { key, resultKey } = byPair[pairs[0]];
      const dp = FEEDS[key].price > 1_000 ? 1 : FEEDS[key].price > 10 ? 2 : 5;
      const rows = model.ohlc(key, minutes).map((c) => [
        c.time,
        c.open.toFixed(dp),
        c.high.toFixed(dp),
        c.low.toFixed(dp),
        c.close.toFixed(dp),
        ((c.high + c.low + c.close) / 3).toFixed(dp),
        c.volume.toFixed(4),
        Math.round(c.volume),
      ]);
      res.end(JSON.stringify({ error: [], result: { [resultKey]: rows, last: rows[rows.length - 1][0] } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: ["EGeneral:Unknown method"] }));
  });
  server.listen(PORTS.kraken, "127.0.0.1", () => log("kraken", `mock Kraken REST on :${PORTS.kraken}`));
  return server;
}
