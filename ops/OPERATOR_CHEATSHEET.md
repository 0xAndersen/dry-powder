# ArcOps operator cheat sheet

Literal snippets, in order. Each block is ONE evaluate call in the browser pane. All calls return small JSON.
Background and troubleshooting: `ops/README.md`.

Conventions
- The evaluate tool supports top-level `await`, so every snippet is `await ArcOps.x(...)`.
- `deploy()`, `fund()` and `sweep()` are long. They return `{pending:true, step:"..."}` after about 25 s if not
  finished; **send the same snippet again** until the real result arrives. Nothing is restarted by calling again.
- Never navigate or reload the tab once booted. If it happens anyway: section 9.

## 0. Open the neutral page

Navigate the pane to `https://example.com` and keep it in the foreground.

## 1. Inject the runtime (3 chunks + boot)

Paste the content of each file **verbatim**, one evaluate call per file, in any order:

```
ops/dist/chunks/01.js      -> returns "ok 01"
ops/dist/chunks/02.js      -> returns "ok 02"
ops/dist/chunks/03.js      -> returns "ok 03"
```

Optional sanity check before booting. It lists `NN:length` for every piece received; each length must be the
file's size minus 59 (so `01:23941`, `02:23941`, and for the last one `chunkChars[2] - 59` from
`ops/dist/manifest.json`). A chunk pushed twice is harmless.

```js
(window.__arcSrc || []).map(s => s.slice(0, 2) + ":" + s.length)
```

Then paste `ops/dist/boot.js` verbatim (one call, about 820 characters):

```
ops/dist/boot.js           -> returns "booted ArcOps 1.0.0"
```

`"missing chunk N"` or `"chunk N corrupt (length ..., expected ...): push it again"` means exactly that: paste
chunk N again, then boot again.

## 2. init

Replace the key. `seed` is any string; every other key (publisher, keeper, 100 agents) is derived from it, so
write it down. Everything omitted takes the defaults shown in the README.

```js
await ArcOps.init({
  deployerKey: "0xREPLACE_WITH_DEPLOYER_PRIVATE_KEY",
  seed: "house-money-run-1",
  collateral: "test",
  agents: 100,
  agentCapital: 10000,
  vaultSeed: 5000000,
  params: { maxPriceAgeSeconds: 30, withdrawLockSeconds: 300, epochSeconds: 300, streamSeconds: 300, futureExpirySeconds: 900 },
  pace: { tradesPerAgent: [5, 7], runMinutes: 30 }
})
```

Expect `{ok:true, phase:"init", deployer:"0x...", publisher:"0x...", keeper:"0x...", head:<block>}`.
`{error:"stored state belongs to another seed..."}`: an earlier run is stored in this origin. Use section 9 to
continue it, or add `reset: true` to the config to discard it.

## 3. preflight (sends nothing)

```js
await ArcOps.preflight()
```

Check: `chainIdOk:true`, `multicall3:true`, `sufficient:true` (else `shortfall` says how much native USDC is
missing), `baseFeeGwei` about 20. `costUsdc.total` is the expected spend, `required` what the deployer must hold.

## 4. deploy (about 1 minute)

```js
await ArcOps.deploy()
```

Repeat while `pending`. Final result is the address book
`{usdc, pub, oracle, vault, token, engine, lens, multicall3, publisher, keeper, deployer, markets:[...], done:true}`.
Save it. `{error:..., step:...}`: read the error, then run the same snippet again; finished steps are skipped.

## 5. fund (about 15 s)

```js
await ArcOps.fund()
```

Expect `{funded:100, nativeSent:102, collateralSent:100, multicall3:true, deployerBalance:<n>}`.

## 6. start

```js
await ArcOps.start()
```

Returns the first status. The run is now unattended.

## 7. Watch (every 30 to 60 s)

```js
await ArcOps.status()
```

What to look at is explained in the README ("Reading status"). Short version: `agents.done` climbs to 100,
`agents.failed` stays 0, `publisher.lastOkS` stays under 5, `rpc.errRate` stays low, `native.deployer` falls
slowly. With the default `autoSweep`, `phase` goes `running` -> `sweeping` -> `ended` by itself when every agent
is done (or at `runMinutes` + 30%).

One agent in detail (position, orders, plan, last revert):

```js
await ArcOps.agent(17)
```

## 8. Finish and collect

Close everything and run the final checks (idempotent; if auto-sweep already ran it just returns the checks):

```js
await ArcOps.sweep()
```

Expect `flat:true, engineOk:true, vaultOk:true, conserved:true`. Then the reports, one call each:

```js
await ArcOps.summary()
```
```js
await ArcOps.leaderboard()
```
```js
await ArcOps.report(0)
```
```js
await ArcOps.report(1)
```
```js
await ArcOps.report(2)
```
```js
await ArcOps.report(3)
```
```js
await ArcOps.report(4)
```
```js
await ArcOps.gas()
```

Finally pull the unspent gas floats back to the deployer (102 small transfers, about 20 s):

```js
await ArcOps.sweep({ returnGas: true })
```

## 9. After an accidental reload or navigation

Everything in the page is gone, the state is in `localStorage` of the origin. Go back to the SAME origin
(`https://example.com`), repeat section 1 (chunks + boot), then:

```js
await ArcOps.resume()
```

It restores config, addresses, keys and every agent's progress, replays the chain events it missed, and restarts
the loops if the run was running. The result is a status with a `next` hint (`"deploy()"`, `"fund()"`,
`"start()"`, `"status()"` or `"summary()"`): do what it says.

## 10. Other controls

```js
await ArcOps.stop()                 // pause all loops (positions stay open); start() continues
await ArcOps.addresses()            // address book again
await ArcOps.checks()               // recompute the end-of-run invariants now
await ArcOps.config()               // effective config (keys hidden)
ArcOps.help()                       // call order reminder
ArcOps.reset()                      // wipe stored state for this origin (irreversible; funds stay recoverable with the same seed)
```

Lower-cost variants (set in `init`):

```js
pace: { tradesPerAgent: [5, 5], runMinutes: 20, lean: true }     // direct open/close only: least gas, no order paths
pace: { tradesPerAgent: [5, 6], runMinutes: 30, mix: { maker: 2, wallet: 2, scalper: 4, meanrev: 4 } }   // fewer keeper-heavy archetypes
publisher: { heartbeatMs: 20000, moveBps: 10 }                    // half the oracle heartbeats
```
