// Deploys the v2 protocol to the local anvil exactly as on testnet: PublisherOracle in place of Pyth, TestUSDC
// as collateral, vault/token/engine at addresses predicted from the deployer nonce, then the lens and the
// launch markets (perps, a cross, an inverted FX pair and a dated future).
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
  const predicted = [0n, 1n, 2n].map((i) => getContractAddress({ from: DEPLOYER.address, nonce: nonce + i }));
  const vault = await deployContract("HouseVault", [usdc, predicted[2], predicted[1], BigInt(lockSeconds), BigInt(epochSeconds)]);
  const token = await deployContract("RewardToken", [predicted[0], predicted[2], BigInt(streamSeconds)]);
  const engine = await deployContract("PerpEngine", [usdc, pythOracle, predicted[0], predicted[1], DEPLOYER.address]);
  for (const [i, actual] of [vault, token, engine].entries()) {
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
    { symbol: "BTC-USD", marketId: FEEDS.BTC.id, feedId: FEEDS.BTC.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 100, expiry: 0 },
    { symbol: "ETH-USD", marketId: FEEDS.ETH.id, feedId: FEEDS.ETH.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 100, expiry: 0 },
    { symbol: "SOL-USD", marketId: FEEDS.SOL.id, feedId: FEEDS.SOL.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 50, expiry: 0 },
    { symbol: "EUR-USD", marketId: FEEDS.EUR.id, feedId: FEEDS.EUR.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 50, expiry: 0 },
    { symbol: "JPY-USD", marketId: FEEDS.JPY.id, feedId: FEEDS.JPY.id, quoteFeedId: zeroHash, invert: true, maxLeverage: 50, expiry: 0 },
    { symbol: "XAU-USD", marketId: FEEDS.XAU.id, feedId: FEEDS.XAU.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 50, expiry: 0 },
    { symbol: "ETH-BTC", marketId: id("ETH-BTC"), feedId: FEEDS.ETH.id, quoteFeedId: FEEDS.BTC.id, invert: false, maxLeverage: 50, expiry: 0 },
    { symbol: datedSymbol, marketId: id(datedSymbol), feedId: FEEDS.BTC.id, quoteFeedId: zeroHash, invert: false, maxLeverage: 50, expiry },
  ];
  for (const m of markets) {
    await send(engine, "PerpEngine", "addMarket", [
      m.marketId,
      { symbol: m.symbol, feedId: m.feedId, quoteFeedId: m.quoteFeedId, invert: m.invert, maxLeverage: m.maxLeverage, expiry: BigInt(m.expiry), maxOiPerSide: cap, skewScale: skew },
    ]);
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

  const addresses = { publisherOracle, pythOracle, usdc, vault, token, engine, lens, expiry, datedSymbol, uiTrader: UI_TRADER.address, markets };
  log("deploy", `engine ${engine} lens ${lens} vault ${vault}; ${datedSymbol} expires in ${expirySeconds}s`);
  return addresses;
}
