// Deploys the protocol to the local anvil exactly as on testnet: PublisherOracle in place of Pyth, TestUSDC as
// collateral, vault/token/engine at addresses predicted from the deployer nonce (the engine is its extension plus
// the contract that forwards to it), then the lens and the launch markets (perps, a cross, an inverted FX pair, a
// dated future and the Turbo markets: Upside fee mode, BTC and ETH to 1000x, EUR to 5000x, gold to 2500x).
import { getContractAddress, keccak256, parseUnits, toHex, zeroHash } from "viem";
import { BOT, DEPLOYER, FEEDS, UI_TRADER, artifact, log, publicClient, walletClient } from "./lib.mjs";

const usd = (n) => parseUnits(String(n), 6);

export async function deploy({ lockSeconds, epochSeconds, streamSeconds, expirySeconds, vaultDeposit }) {
  const pub = publicClient();
  const wallet = walletClient(DEPLOYER);

  const deployContract = async (name, args) => {
    const a = artifact(name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  };
  const send = async (address, name, functionName, args) => {
    const hash = await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  };

  const publisherOracle = await deployContract("PublisherOracle", [DEPLOYER.address, BOT.address]);
  const pythOracle = await deployContract("PythOracle", [publisherOracle]);
  const usdc = await deployContract("TestUSDC", []);

  const nonce = BigInt(await pub.getTransactionCount({ address: DEPLOYER.address }));
  // vault, token, the engine's extension, the engine
  const predicted = [0n, 1n, 2n, 3n].map((i) => getContractAddress({ from: DEPLOYER.address, nonce: nonce + i }));
  const vault = await deployContract("HouseVault", [usdc, predicted[3], predicted[1], BigInt(lockSeconds), BigInt(epochSeconds)]);
  const token = await deployContract("RewardToken", [predicted[0], predicted[3], BigInt(streamSeconds)]);
  const engineExt = await deployContract("PerpEngineExt", [usdc, pythOracle, predicted[0], predicted[1]]);
  const engine = await deployContract("PerpEngine", [usdc, pythOracle, predicted[0], predicted[1], DEPLOYER.address, engineExt]);
  for (const [i, actual] of [vault, token, engineExt, engine].entries()) {
    if (actual.toLowerCase() !== predicted[i].toLowerCase()) throw new Error("address prediction failed");
  }
  const lens = await deployContract("EngineLens", [engine]);

  const now = Number((await pub.getBlock()).timestamp);
  const expiry = now + expirySeconds;
  const tag = new Date(expiry * 1000).toISOString().slice(11, 16).replace(":", "");
  const datedSymbol = `BTC-USD-${tag}Z`;
  const id = (symbol) => keccak256(toHex(symbol));
  const cap = usd(2_000_000);
  const skew = usd(500_000);
  const markets = [
    // Same leverage as contracts/script/Deploy.s.sol.
    { symbol: "BTC-USD", marketId: FEEDS.BTC.id, feedId: FEEDS.BTC.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 1000, expiry: 0 },
    { symbol: "ETH-USD", marketId: FEEDS.ETH.id, feedId: FEEDS.ETH.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 1000, expiry: 0 },
    { symbol: "SOL-USD", marketId: FEEDS.SOL.id, feedId: FEEDS.SOL.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 500, expiry: 0 },
    { symbol: "EUR-USD", marketId: FEEDS.EUR.id, feedId: FEEDS.EUR.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 500, expiry: 0 },
    { symbol: "JPY-USD", marketId: FEEDS.JPY.id, feedId: FEEDS.JPY.id, quoteFeedId: zeroHash, invert: true, maxLeverage: 100, expiry: 0 },
    { symbol: "XAU-USD", marketId: FEEDS.XAU.id, feedId: FEEDS.XAU.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 500, expiry: 0 },
    { symbol: "ETH-BTC", marketId: id("ETH-BTC"), feedId: FEEDS.ETH.id, quoteFeedId: FEEDS.BTC.id, invert: false, maxLeverage: 100, expiry: 0 },
    { symbol: datedSymbol, marketId: id(datedSymbol), feedId: FEEDS.BTC.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 250, expiry },
    // Turbo: no fee unless you win, mid-price keeper fills, notional far above margin (see Deploy.s.sol).
    { symbol: "BTC-USD-TURBO", marketId: id("BTC-USD-TURBO"), feedId: FEEDS.BTC.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 1000, expiry: 0, turbo: true },
    { symbol: "ETH-USD-TURBO", marketId: id("ETH-USD-TURBO"), feedId: FEEDS.ETH.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 1000, expiry: 0, turbo: true },
    { symbol: "EUR-USD-TURBO", marketId: id("EUR-USD-TURBO"), feedId: FEEDS.EUR.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 5000, expiry: 0, turbo: true },
    { symbol: "XAU-USD-TURBO", marketId: id("XAU-USD-TURBO"), feedId: FEEDS.XAU.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 2500, expiry: 0, turbo: true },
  ];
  const turboCap = usd(1_000_000_000);
  for (const m of markets) {
    await send(engine, "PerpEngine", "addMarket", [
      m.marketId,
      { symbol: m.symbol, feedId: m.feedId, quoteFeedId: m.quoteFeedId, invert: m.invert, maxLeverage: m.maxLeverage, expiry: BigInt(m.expiry), maxOiPerSide: m.turbo ? turboCap : cap, skewScale: m.turbo ? turboCap : skew },
    ]);
    if (m.turbo) await send(engine, "PerpEngine", "setMarketFeeMode", [m.marketId, 1]);
  }

  // Seed the house. TestUSDC mints at most 1,000,000 per call.
  let remaining = vaultDeposit;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 1_000_000);
    await send(usdc, "TestUSDC", "mint", [DEPLOYER.address, usd(chunk)]);
    remaining -= chunk;
  }
  await send(usdc, "TestUSDC", "approve", [vault, usd(vaultDeposit)]);
  await send(vault, "HouseVault", "deposit", [usd(vaultDeposit), DEPLOYER.address]);

  const agentFactory = await deployContract("AgentAccountFactory", [usdc, engine]);
  const trailingStops = await deployContract("TrailingStops", [engine, agentFactory]);
  const twapOrders = await deployContract("TwapOrders", [engine, agentFactory]);
  const strategies = await deployContract("Strategies", [engine, agentFactory]);
  const agentRegistry = await deployContract("AgentRegistry", [agentFactory]);
  const prizeDistributor = await deployContract("PrizeDistributor", [usdc, DEPLOYER.address]);

  const addresses = { publisherOracle, pythOracle, usdc, vault, token, engine, engineExt, lens, agentFactory, trailingStops, twapOrders, strategies, agentRegistry, prizeDistributor, expiry, datedSymbol, uiTrader: UI_TRADER.address, markets };
  log("deploy", `engine ${engine} lens ${lens} vault ${vault}; ${datedSymbol} expires in ${expirySeconds}s`);
  return addresses;
}
