# Event stream and push relay

Two small services from the keeper image, for a host that stays up. Neither holds a funded key.

| Service | Source | What it does | Port |
| --- | --- | --- | --- |
| Event stream (roadmap 93) | `keeper/src/relay.mjs` | Streams the engine's and the add-ons' events, decoded, to bots over Server-Sent Events and WebSocket | 8091 |
| Push relay (roadmap 50) | `keeper/src/push.mjs` | Sends liquidation warnings, fills and closes to browsers that subscribed in the app's Settings, while the app is closed | 8092 |

```sh
cd ops/relay
cp .env.example .env          # VAPID keys, a contact, the app's origin
docker compose up --build -d
```

Without Docker: `cd keeper && npm ci`, then `DEPLOYMENT=../deployments/arc-testnet.json node src/relay.mjs`, and for
push the same with `src/push.mjs` and the `VAPID_*` variables below.

Serve both over TLS (a reverse proxy such as Caddy, or a tunnel). Browsers only let an https app call an https
API, and bots should connect with `wss://`. Behind a proxy set `TRUST_PROXY=1` so per-client limits count real
addresses.

## Event stream for bots

Every event the engine (fills, closes, liquidations, orders, margin, settlements) and the add-ons (trailing stops,
TWAP slices, strategies, the agent registry, season prizes) emit, decoded, as blocks arrive. A bot subscribes to
the markets, traders and event names it cares about instead of polling `eth_getLogs` itself.

```sh
# Server-Sent Events: every liquidation on BTC-USD, and everything one trader does
curl -N 'https://relay.example/events?market=BTC-USD&event=PositionLiquidated'
curl -N 'https://relay.example/events?trader=0xYourAgentAccount'
```

```js
// A browser (or Node 22 with --experimental-eventsource): EventSource reconnects by itself and resumes from the
// last event it received.
const es = new EventSource("https://relay.example/events?market=ETH-USD&event=PositionOpened,PositionClosed");
es.addEventListener("PositionOpened", (e) => console.log(JSON.parse(e.data)));
es.addEventListener("gap", (e) => console.warn("older than the relay's buffer:", JSON.parse(e.data)));

// WebSocket: change filters on the fly, replay from a block.
const ws = new WebSocket("wss://relay.example/ws?event=PositionLiquidated");
ws.onmessage = (m) => console.log(JSON.parse(m.data));
ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", market: ["BTC-USD"], trader: [], event: [], from: 1234567 }));
```

| Endpoint | |
| --- | --- |
| `GET /events` | `text/event-stream`. Each event: `id: <block>:<logIndex>`, `event: <name>`, `data: <JSON>`. A comment every 15 s keeps proxies from closing it. |
| `GET /ws` | WebSocket. `{"type":"hello"}` first, then `{"type":"event",…}`. Send `{"type":"subscribe",…}` to change filters, `{"type":"ping"}` for a pong. |
| `GET /recent` | The latest buffered events that match, as a JSON array (`limit`, default 100). |
| `GET /health` | Head, cursor, buffer size, clients, drops. |

Filters (query parameters, or the fields of a subscribe message), all optional, repeated or comma-separated:
`market` (a symbol such as `BTC-USD`, or a market id), `trader` (an address: the trader, or the account of an
add-on event), `event` (event names, any case). `from=<block>` replays the buffer from that block; a reconnect with
`Last-Event-ID` (EventSource sends it) replays what was missed. A replay older than the buffer gets a `gap` message
with the oldest block the relay holds: read the rest from an RPC.

An event:

```json
{
  "id": "1834567:2", "name": "PositionOpened", "contract": "engine", "address": "0x…",
  "block": 1834567, "logIndex": 2, "tx": "0x…", "time": 1761400000,
  "market": "0x…", "symbol": "BTC-USD", "trader": "0x…",
  "args": { "key": "0x…", "isLong": true, "margin": "20000000", "size": "1000000000", "entryPrice": "64000000000000000000000", "fee": "300000" }
}
```

Amounts are decimal strings in their on-chain units (collateral 6 decimals, prices 18).

Limits, so one client cannot slow the others: 500 clients (`MAX_CLIENTS`), 20 per address (`MAX_CLIENTS_PER_IP`),
50 values per filter, 10,000 buffered events (`MAX_BUFFERED_EVENTS`; with `BACKFILL_BLOCKS`, 5,000 by default, read
at start). A client that falls 1 MiB behind (`MAX_QUEUE_BYTES`) is disconnected with an error message rather than
queued without bound; it reconnects and resumes from its last id.

## Push notifications

The app's Settings offer "Notifications when the app is closed" once the app knows the push relay's URL. The
browser subscribes with its push service (Google, Mozilla, Apple, Microsoft) and gives the relay the subscription
and the accounts to watch (the wallet and its trading account). The relay polls those accounts every 15 seconds and
the engine's events in between, and sends:

- liquidation warnings, with the app's rule: when half, then three quarters, of the buffer a position started with
  is gone (or only the second, per the Settings choice); urgent, and replaced by the next warning for the same
  position if not yet delivered;
- fills: opens and additions, whichever order type filled them;
- closes: full and partial closes, take-profits, stop-losses, and liquidations.

Payloads are encrypted for the browser (RFC 8291) and signed with the relay's VAPID key (RFC 8292). Tapping a
notification opens the market or the portfolio in the app.

Set up:

1. `node keeper/src/push.mjs keys` prints `VAPID_PUBLIC_KEY=…` and `VAPID_PRIVATE_KEY=…`. Put both in
   `ops/relay/.env` (or the host's secret store). The private key is a secret; a new pair means every browser
   subscribes again.
2. `VAPID_SUBJECT`: a `mailto:` address or an https URL the push services can reach.
3. `ALLOWED_ORIGINS`: the app's origin, `https://0xandersen.github.io` for the Pages app.
4. Tell the app where the relay is: `"pushRelayUrl": "https://push.example"` in the static bundle's `config.json`
   (or `NEXT_PUBLIC_PUSH_RELAY_URL` when building the server build). Without it the setting stays hidden.

API: `GET /vapid`, `POST /subscriptions` `{ subscription, accounts, topics, liqWarn }`, `DELETE /subscriptions`
`{ endpoint }`, `GET /health`. Endpoints must be on a known push service (`PUSH_HOSTS`), at most 4 accounts per
subscription (`MAX_ACCOUNTS`), 5,000 subscriptions (`MAX_SUBSCRIPTIONS`), 30 writes a minute per address.
Subscriptions live in `STORE_FILE` (a JSON file, written atomically); one a push service reports gone (404, 410)
is removed.
