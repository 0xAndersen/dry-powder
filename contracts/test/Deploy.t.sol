// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {EngineLens} from "../src/EngineLens.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {Market, OpenParams} from "../src/Types.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Runs the real deployment script against mocks etched at the Arc Testnet addresses it defaults to.
///      Environment variables are process-wide and forge runs tests in parallel, so everything that sets one
///      lives in a single test function, which restores the defaults before it ends.
contract DeployTest is Test {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant ARC_TESTNET_PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;
    uint256 internal constant T0 = 1_760_000_000; // Thu 2025-10-09 08:53:20 UTC
    uint64 internal constant DEFAULT_EXPIRY = 1_760_688_000; // Fri 2025-10-17 08:00:00 UTC

    bytes32 internal constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 internal constant SOL = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;
    bytes32 internal constant EUR = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;
    bytes32 internal constant JPY = 0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52;
    bytes32 internal constant XAU = 0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2;

    Deploy internal script;

    function setUp() public {
        vm.warp(T0);
        script = new Deploy();
    }

    function _json() internal view returns (string memory) {
        return vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }

    function _assertWiring(Deploy.Deployment memory d) internal view {
        assertEq(d.vault.asset(), d.usdc);
        assertEq(d.vault.engine(), address(d.engine));
        assertEq(address(d.vault.rewardToken()), address(d.rewardToken));
        assertEq(address(d.rewardToken.vault()), address(d.vault));
        assertEq(d.rewardToken.engine(), address(d.engine));
        assertEq(address(d.engine.usdc()), d.usdc);
        assertEq(address(d.engine.oracle()), address(d.oracle));
        assertEq(address(d.engine.pyth()), d.pyth);
        assertEq(address(d.oracle.pyth()), d.pyth);
        assertEq(address(d.engine.vault()), address(d.vault));
        assertEq(address(d.engine.rewardToken()), address(d.rewardToken));
        assertEq(address(d.lens.engine()), address(d.engine));
    }

    function _assertMarket(
        Deploy.Deployment memory d,
        uint256 i,
        bytes32 id,
        string memory symbol,
        bytes32 feed,
        bytes32 quote,
        bool invert,
        uint16 maxLeverage,
        uint64 expiry
    ) internal view {
        assertEq(d.marketIds[i], id, symbol);
        assertEq(d.marketSymbols[i], symbol);
        assertEq(d.engine.getMarketIds()[i], id);
        Market memory m = d.engine.getMarket(id);
        assertTrue(m.enabled);
        assertEq(m.symbol, symbol);
        assertEq(m.feedId, feed);
        assertEq(m.quoteFeedId, quote);
        assertEq(m.invert, invert);
        assertEq(m.maxLeverage, maxLeverage);
        assertEq(m.expiry, expiry);
        assertEq(m.maxOiPerSide, 1_000_000e6);
        assertEq(m.skewScale, 250_000e6);
    }

    function _assertLaunchMarkets(Deploy.Deployment memory d, string memory futureSymbol, uint64 expiry) internal view {
        assertEq(d.engine.getMarketIds().length, 8);
        assertEq(d.marketIds.length, 8);
        assertEq(d.futureExpiry, expiry);
        _assertMarket(d, 0, BTC, "BTC-USD", BTC, 0, false, 100, 0);
        _assertMarket(d, 1, ETH, "ETH-USD", ETH, 0, false, 100, 0);
        _assertMarket(d, 2, SOL, "SOL-USD", SOL, 0, false, 50, 0);
        _assertMarket(d, 3, EUR, "EUR-USD", EUR, 0, false, 50, 0);
        _assertMarket(d, 4, JPY, "JPY-USD", JPY, 0, true, 50, 0);
        _assertMarket(d, 5, XAU, "XAU-USD", XAU, 0, false, 50, 0);
        _assertMarket(d, 6, keccak256("ETH-BTC"), "ETH-BTC", ETH, BTC, false, 50, 0);
        _assertMarket(d, 7, keccak256(bytes(futureSymbol)), futureSymbol, BTC, 0, false, 50, expiry);
    }

    function test_deployScript_allModes() public {
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        vm.etch(ARC_TESTNET_PYTH, address(new MockPyth(60, 1)).code);

        // ── Defaults: real Pyth, real USDC, deployer as owner ──
        Deploy.Deployment memory d = script.run();
        assertEq(d.usdc, ARC_USDC);
        assertEq(d.pyth, ARC_TESTNET_PYTH);
        assertEq(address(d.publisherOracle), address(0));
        _assertWiring(d);
        assertEq(d.vault.withdrawLockPeriod(), 1 hours);
        assertEq(d.vault.epochLength(), 1 days);
        assertEq(d.rewardToken.streamPeriod(), 1 days);
        assertEq(d.engine.owner(), DEFAULT_SENDER);
        assertEq(d.engine.pendingOwner(), address(0));
        assertEq(d.engine.maxPriceAge(), 10);
        assertEq(d.engine.maxConfBps(), 50);
        assertEq(d.engine.maxOiToNavBps(), 30_000);
        assertEq(d.engine.minMargin(), 5e6);
        assertEq(d.engine.maxProfitMultiple(), 10);
        _assertLaunchMarkets(d, "BTC-USD-251017", DEFAULT_EXPIRY);
        // The lens reads the freshly listed markets (no prices yet).
        EngineLens.MarketView[] memory ms = d.lens.getMarkets();
        assertEq(ms.length, 8);
        assertEq(ms[7].market.symbol, "BTC-USD-251017");
        assertFalse(ms[0].hasPrice);

        string memory json = _json();
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonString(json, ".oracleMode"), "pyth");
        assertEq(vm.parseJsonString(json, ".collateral"), "usdc");
        assertEq(vm.parseJsonAddress(json, ".owner"), DEFAULT_SENDER);
        assertEq(vm.parseJsonAddress(json, ".usdc"), ARC_USDC);
        assertEq(vm.parseJsonAddress(json, ".pyth"), ARC_TESTNET_PYTH);
        assertEq(vm.parseJsonAddress(json, ".publisherOracle"), address(0));
        assertEq(vm.parseJsonAddress(json, ".pythOracle"), address(d.oracle));
        assertEq(vm.parseJsonAddress(json, ".perpEngine"), address(d.engine));
        assertEq(vm.parseJsonAddress(json, ".engineLens"), address(d.lens));
        assertEq(vm.parseJsonAddress(json, ".houseVault"), address(d.vault));
        assertEq(vm.parseJsonAddress(json, ".rewardToken"), address(d.rewardToken));
        assertEq(vm.parseJsonUint(json, ".futureExpiry"), DEFAULT_EXPIRY);
        bytes32[] memory ids = vm.parseJsonBytes32Array(json, ".marketIds");
        string[] memory symbols = vm.parseJsonStringArray(json, ".marketSymbols");
        assertEq(ids.length, 8);
        assertEq(symbols.length, 8);
        for (uint256 i; i < 8; ++i) {
            assertEq(ids[i], d.marketIds[i]);
            assertEq(symbols[i], d.marketSymbols[i]);
        }
        assertEq(ids[6], keccak256("ETH-BTC"));
        assertEq(symbols[7], "BTC-USD-251017");

        // ── Off Arc Testnet the script refuses to fall back to the testnet oracle address ──
        vm.chainId(1);
        vm.expectRevert("Deploy: set PYTH_ADDRESS");
        script.run();
        // ... and refuses an address with no contract behind it.
        vm.setEnv("PYTH_ADDRESS", vm.toString(makeAddr("typo")));
        vm.expectRevert("Deploy: no contract at PYTH_ADDRESS");
        script.run();
        // With a real one it deploys on any chain.
        address otherPyth = address(new MockPyth(60, 1));
        vm.setEnv("PYTH_ADDRESS", vm.toString(otherPyth));
        d = script.run();
        assertEq(d.pyth, otherPyth);
        _assertWiring(d);
        vm.setEnv("PYTH_ADDRESS", vm.toString(address(0)));

        // ── Publisher mode needs no Pyth at all, on any chain ──
        vm.setEnv("ORACLE_MODE", "publisher");
        d = script.run();
        assertTrue(address(d.publisherOracle) != address(0));
        assertEq(d.pyth, address(d.publisherOracle));
        assertEq(d.publisherOracle.owner(), DEFAULT_SENDER);
        assertTrue(d.publisherOracle.isPublisher(DEFAULT_SENDER)); // the deployer signs prices by default
        _assertWiring(d);
        _assertLaunchMarkets(d, "BTC-USD-251017", DEFAULT_EXPIRY);
        json = _json();
        assertEq(vm.parseJsonUint(json, ".chainId"), 1);
        assertEq(vm.parseJsonString(json, ".oracleMode"), "publisher");
        assertEq(vm.parseJsonAddress(json, ".publisherOracle"), address(d.publisherOracle));
        assertEq(vm.parseJsonAddress(json, ".pyth"), address(d.publisherOracle));
        vm.removeFile("./deployments/1.json");
        vm.chainId(31337);

        // ── Publisher mode + test collateral + every override: the full testnet configuration ──
        (address publisher, uint256 publisherKey) = makeAddrAndKey("publisher");
        address multisig = makeAddr("multisig");
        vm.setEnv("PUBLISHER_ADDRESS", vm.toString(publisher));
        vm.setEnv("COLLATERAL", "test");
        vm.setEnv("OWNER_ADDRESS", vm.toString(multisig));
        vm.setEnv("WITHDRAW_LOCK_SECONDS", "600");
        vm.setEnv("EPOCH_SECONDS", "7200");
        vm.setEnv("STREAM_SECONDS", "3600");
        vm.setEnv("MAX_PRICE_AGE_SECONDS", "30");
        vm.setEnv("FUTURE_EXPIRY", "1767225599"); // Wed 2025-12-31 23:59:59 UTC
        d = script.run();
        assertTrue(d.usdc != ARC_USDC);
        assertEq(TestUSDC(d.usdc).symbol(), "tUSDC");
        assertTrue(d.publisherOracle.isPublisher(publisher));
        assertFalse(d.publisherOracle.isPublisher(DEFAULT_SENDER));
        assertEq(d.publisherOracle.owner(), DEFAULT_SENDER);
        _assertWiring(d);
        assertEq(d.vault.withdrawLockPeriod(), 600);
        assertEq(d.vault.epochLength(), 7_200);
        assertEq(d.rewardToken.streamPeriod(), 3_600);
        assertEq(d.engine.maxPriceAge(), 30);
        // Ownership is offered, not handed over: the multisig has to accept.
        assertEq(d.engine.owner(), DEFAULT_SENDER);
        assertEq(d.engine.pendingOwner(), multisig);
        _assertLaunchMarkets(d, "BTC-USD-251231", 1_767_225_599);
        json = _json();
        assertEq(vm.parseJsonString(json, ".collateral"), "test");
        assertEq(vm.parseJsonAddress(json, ".usdc"), d.usdc);
        assertEq(vm.parseJsonAddress(json, ".owner"), multisig);
        assertEq(vm.parseJsonStringArray(json, ".marketSymbols")[7], "BTC-USD-251231");
        _tradeOnDeployment(d, publisherKey);

        // ── Input validation ──
        vm.setEnv("FUTURE_EXPIRY", vm.toString(T0));
        vm.expectRevert("Deploy: FUTURE_EXPIRY is in the past");
        script.run();
        vm.setEnv("FUTURE_EXPIRY", "0"); // 0 = use the default again
        vm.setEnv("ORACLE_MODE", "chainlink");
        vm.expectRevert("Deploy: ORACLE_MODE must be pyth or publisher");
        script.run();
        vm.setEnv("ORACLE_MODE", "pyth");
        vm.setEnv("COLLATERAL", "dai");
        vm.expectRevert("Deploy: COLLATERAL must be usdc or test");
        script.run();

        // Restore the defaults for whatever runs in this process next.
        vm.setEnv("COLLATERAL", "usdc");
        vm.setEnv("PUBLISHER_ADDRESS", vm.toString(DEFAULT_SENDER));
        vm.setEnv("OWNER_ADDRESS", vm.toString(DEFAULT_SENDER));
        vm.setEnv("WITHDRAW_LOCK_SECONDS", "3600");
        vm.setEnv("EPOCH_SECONDS", "86400");
        vm.setEnv("STREAM_SECONDS", "86400");
        vm.setEnv("MAX_PRICE_AGE_SECONDS", "10");
        d = script.run();
        assertEq(d.usdc, ARC_USDC);
        assertEq(d.pyth, ARC_TESTNET_PYTH);
        assertEq(d.engine.pendingOwner(), address(0));
        _assertLaunchMarkets(d, "BTC-USD-251017", DEFAULT_EXPIRY);
    }

    /// @dev The deployed testnet stack actually trades: mint test collateral, seed the vault, open a position
    ///      on the dated future with a publisher-signed price, and close it.
    function _tradeOnDeployment(Deploy.Deployment memory d, uint256 publisherKey) internal {
        TestUSDC token = TestUSDC(d.usdc);
        address trader = makeAddr("trader");
        token.mint(address(this), 100_000e6);
        token.approve(address(d.vault), type(uint256).max);
        d.vault.deposit(100_000e6, address(this));
        token.mint(trader, 1_000e6);
        vm.prank(trader);
        token.approve(address(d.engine), type(uint256).max);

        bytes32 future = d.marketIds[7];
        OpenParams memory p = OpenParams({
            priceId: future, isLong: true, margin: 100e6, size: 1_000e6, acceptablePrice: 0, takeProfit: 0, stopLoss: 0
        });
        bytes[] memory update = _signedBtc(d, publisherKey, 100_000e8, uint64(T0));
        vm.prank(trader);
        d.engine.openPosition(p, update);
        assertEq(d.engine.getPosition(trader, future).entryPrice, 100_000e18);
        assertTrue(d.lens.getMarkets()[0].hasPrice);
        assertTrue(d.lens.getMarkets()[7].hasPrice);
        assertFalse(d.lens.getMarkets()[1].hasPrice);

        skip(1);
        update = _signedBtc(d, publisherKey, 101_000e8, uint64(T0 + 1));
        vm.prank(trader);
        d.engine.closePosition(future, 0, update);
        // +1% on 1,000 = 10; open fee 0.50 + skew surcharge 0.004 (1,000 of skew over the 250k scale); close 0.50
        assertEq(token.balanceOf(trader), 1_000e6 + 10e6 - 0.504e6 - 0.5e6);
        vm.warp(T0);
    }

    function _signedBtc(Deploy.Deployment memory d, uint256 key, int64 price, uint64 t)
        internal
        view
        returns (bytes[] memory data)
    {
        bytes32 digest = d.publisherOracle.updateDigest(BTC, price, 0, -8, t);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(digest));
        data = new bytes[](1);
        data[0] = abi.encode(BTC, price, uint64(0), int32(-8), t, abi.encodePacked(r, s, v));
    }

    // ───────────────────────────── Date helpers ─────────────────────────────

    function test_defaultFutureExpiry_isTheNextFridayEightUtcMoreThanADayAway() public view {
        // Thu 2025-10-09 08:53:20: tomorrow's 08:00 is 23h07m away, so the Friday after.
        assertEq(script.defaultFutureExpiry(T0), DEFAULT_EXPIRY);
        // Thu 07:59:59: Friday 08:00 is 24h00m01s away.
        assertEq(script.defaultFutureExpiry(1_759_996_799), 1_760_083_200);
        // Thu 08:00:00 sharp: exactly 24h is not "more than".
        assertEq(script.defaultFutureExpiry(1_759_996_800), DEFAULT_EXPIRY);
        // On the Friday itself, before and after 08:00.
        assertEq(script.defaultFutureExpiry(1_760_083_199), DEFAULT_EXPIRY);
        assertEq(script.defaultFutureExpiry(1_760_083_200), DEFAULT_EXPIRY);
        assertEq(script.defaultFutureExpiry(1_760_108_400), DEFAULT_EXPIRY);
        // Mon 2026-10-12 -> Fri 2026-10-16.
        assertEq(script.defaultFutureExpiry(1_791_763_200), 1_792_137_600);
        // Across a year end: Tue 2024-12-31 23:59:59 -> Fri 2025-01-03.
        assertEq(script.defaultFutureExpiry(1_735_689_599), 1_735_891_200);
        // The epoch itself was a Thursday.
        assertEq(script.defaultFutureExpiry(1), 115_200);
    }

    function testFuzz_defaultFutureExpiry(uint256 t) public view {
        t = bound(t, 0, 4_102_444_800 * 2);
        uint256 expiry = script.defaultFutureExpiry(t);
        assertGt(expiry, t + 24 hours);
        assertLe(expiry, t + 24 hours + 7 days);
        assertEq(expiry % 1 days, 8 hours);
        assertEq(((expiry / 1 days) + 4) % 7, 5); // a Friday
    }

    function test_expiryTag_isTheUtcDateAsYYMMDD() public view {
        assertEq(script.expiryTag(0), "700101");
        assertEq(script.expiryTag(T0), "251009");
        assertEq(script.expiryTag(DEFAULT_EXPIRY), "251017");
        assertEq(script.expiryTag(1_792_137_600), "261016");
        assertEq(script.expiryTag(951_782_400), "000229"); // leap day in a century year divisible by 400
        assertEq(script.expiryTag(1_709_164_800), "240229"); // ordinary leap day
        assertEq(script.expiryTag(1_709_251_199), "240229"); // its last second
        assertEq(script.expiryTag(1_709_251_200), "240301");
        assertEq(script.expiryTag(1_735_689_599), "241231");
        assertEq(script.expiryTag(1_735_689_600), "250101");
        assertEq(script.expiryTag(4_102_444_800), "000101"); // 2100-01-01, not a leap year
        assertEq(script.expiryTag(4_107_542_400), "000301"); // 2100-03-01 follows 02-28
    }
}
