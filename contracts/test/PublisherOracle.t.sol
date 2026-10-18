// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

import {EngineLens} from "../src/EngineLens.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IHouseVault} from "../src/interfaces/IHouseVault.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";
import {PublisherOracle} from "../src/testnet/PublisherOracle.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {MarketConfig, OpenParams, OraclePrice, PriceStatus} from "../src/Types.sol";

contract PublisherOracleTest is Test {
    bytes32 internal constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    uint256 internal constant T0 = 1_760_000_000;

    PublisherOracle internal pub;
    address internal owner = makeAddr("owner");
    address internal publisher;
    uint256 internal publisherKey;
    address internal mallory;
    uint256 internal malloryKey;
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(T0);
        (publisher, publisherKey) = makeAddrAndKey("publisher");
        (mallory, malloryKey) = makeAddrAndKey("mallory");
        vm.expectEmit();
        emit PublisherOracle.PublisherSet(publisher, true);
        pub = new PublisherOracle(owner, publisher);
    }

    function _signed(uint256 key, PublisherOracle target, bytes32 id, int64 price, uint64 conf, int32 expo, uint64 t)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = target.updateDigest(id, price, conf, expo, t);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encode(id, price, conf, expo, t, abi.encodePacked(r, s, v));
    }

    function _one(bytes memory update) internal pure returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = update;
    }

    function _update(bytes32 id, int64 price, uint64 conf, uint64 t) internal view returns (bytes[] memory) {
        return _one(_signed(publisherKey, pub, id, price, conf, -8, t));
    }

    function test_constructor() public view {
        assertEq(pub.owner(), owner);
        assertTrue(pub.isPublisher(publisher));
        assertFalse(pub.isPublisher(owner));
        assertFalse(pub.isPublisher(mallory));
    }

    function test_updateDigest_bindsChainOracleAndPayload() public view {
        bytes32 expected =
            keccak256(abi.encode(block.chainid, address(pub), BTC, int64(1), uint64(2), int32(-8), uint64(4)));
        assertEq(pub.updateDigest(BTC, 1, 2, -8, 4), expected);
    }

    function test_getUpdateFee_isZero() public view {
        assertEq(pub.getUpdateFee(new bytes[](0)), 0);
        assertEq(pub.getUpdateFee(new bytes[](5)), 0);
    }

    function test_validSignedUpdate_isStored() public {
        bytes[] memory data = _update(BTC, 100_000e8, 50e8, uint64(T0));
        vm.expectEmit(address(pub));
        emit PublisherOracle.PriceFeedUpdate(BTC, uint64(T0), 100_000e8, 50e8);
        vm.prank(alice); // anyone may relay a signed update
        pub.updatePriceFeeds(data);

        PythStructs.Price memory p = pub.getPriceUnsafe(BTC);
        assertEq(p.price, 100_000e8);
        assertEq(p.conf, 50e8);
        assertEq(p.expo, -8);
        assertEq(p.publishTime, T0);
    }

    function test_batchOfUpdates() public {
        bytes[] memory data = new bytes[](3);
        data[0] = _signed(publisherKey, pub, BTC, 100_000e8, 0, -8, uint64(T0));
        data[1] = _signed(publisherKey, pub, ETH, 4_000e8, 0, -8, uint64(T0));
        data[2] = _signed(publisherKey, pub, BTC, 100_100e8, 0, -8, uint64(T0 + 1));
        pub.updatePriceFeeds(data);
        assertEq(pub.getPriceUnsafe(BTC).price, 100_100e8);
        assertEq(pub.getPriceUnsafe(ETH).price, 4_000e8);

        // One bad entry rejects the whole batch.
        data[1] = _signed(malloryKey, pub, ETH, 1, 0, -8, uint64(T0 + 1));
        data[2] = _signed(publisherKey, pub, BTC, 100_200e8, 0, -8, uint64(T0 + 2));
        vm.expectRevert(abi.encodeWithSelector(PublisherOracle.NotPublisher.selector, mallory));
        pub.updatePriceFeeds(data);
        assertEq(pub.getPriceUnsafe(BTC).price, 100_100e8);
    }

    function test_wrongSigner_reverts() public {
        bytes[] memory data = _one(_signed(malloryKey, pub, BTC, 1e8, 0, -8, uint64(T0)));
        vm.expectRevert(abi.encodeWithSelector(PublisherOracle.NotPublisher.selector, mallory));
        pub.updatePriceFeeds(data);
        vm.expectRevert(PythErrors.PriceFeedNotFound.selector);
        pub.getPriceUnsafe(BTC);
    }

    function test_tamperedPayload_reverts() public {
        bytes32 digest = pub.updateDigest(BTC, 100_000e8, 0, -8, uint64(T0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(publisherKey, MessageHashUtils.toEthSignedMessageHash(digest));
        bytes memory sig = abi.encodePacked(r, s, v);
        // Same signature, each field changed in turn: the recovered signer is never the publisher.
        bytes[5] memory tampered = [
            abi.encode(ETH, int64(100_000e8), uint64(0), int32(-8), uint64(T0), sig),
            abi.encode(BTC, int64(1e8), uint64(0), int32(-8), uint64(T0), sig),
            abi.encode(BTC, int64(100_000e8), uint64(1), int32(-8), uint64(T0), sig),
            abi.encode(BTC, int64(100_000e8), uint64(0), int32(-6), uint64(T0), sig),
            abi.encode(BTC, int64(100_000e8), uint64(0), int32(-8), uint64(T0 + 1), sig)
        ];
        for (uint256 i; i < 5; ++i) {
            vm.expectPartialRevert(PublisherOracle.NotPublisher.selector);
            pub.updatePriceFeeds(_one(tampered[i]));
        }
        pub.updatePriceFeeds(_one(abi.encode(BTC, int64(100_000e8), uint64(0), int32(-8), uint64(T0), sig)));
    }

    function test_malformedSignature_reverts() public {
        bytes memory bad = abi.encode(BTC, int64(1e8), uint64(0), int32(-8), uint64(T0), hex"1234");
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 2));
        pub.updatePriceFeeds(_one(bad));
    }

    function test_signatureIsBoundToThisOracleAndChain() public {
        PublisherOracle other = new PublisherOracle(owner, publisher);
        bytes[] memory forOther = _one(_signed(publisherKey, other, BTC, 100_000e8, 0, -8, uint64(T0)));
        vm.expectPartialRevert(PublisherOracle.NotPublisher.selector);
        pub.updatePriceFeeds(forOther);
        other.updatePriceFeeds(forOther);

        bytes[] memory data = _update(BTC, 100_000e8, 0, uint64(T0));
        vm.chainId(1);
        vm.expectPartialRevert(PublisherOracle.NotPublisher.selector);
        pub.updatePriceFeeds(data);
        vm.chainId(31337);
        pub.updatePriceFeeds(data);
    }

    function test_nonMonotonicPublishTime_isIgnored() public {
        vm.warp(T0 + 10);
        pub.updatePriceFeeds(_update(BTC, 100_000e8, 0, uint64(T0 + 5)));

        vm.recordLogs();
        pub.updatePriceFeeds(_update(BTC, 90_000e8, 0, uint64(T0 + 4))); // older
        pub.updatePriceFeeds(_update(BTC, 95_000e8, 0, uint64(T0 + 5))); // same second
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(pub.getPriceUnsafe(BTC).price, 100_000e8);
        assertEq(pub.getPriceUnsafe(BTC).publishTime, T0 + 5);

        pub.updatePriceFeeds(_update(BTC, 101_000e8, 0, uint64(T0 + 6))); // strictly newer
        assertEq(pub.getPriceUnsafe(BTC).price, 101_000e8);
    }

    function test_futurePublishTime_reverts() public {
        bytes[] memory tooFar = _update(BTC, 100_000e8, 0, uint64(T0 + 3));
        vm.expectRevert(PublisherOracle.PublishTimeInFuture.selector);
        pub.updatePriceFeeds(tooFar);
        // Two seconds of clock skew are tolerated.
        pub.updatePriceFeeds(_update(BTC, 100_000e8, 0, uint64(T0 + 2)));
        assertEq(pub.getPriceUnsafe(BTC).publishTime, T0 + 2);
        // The rejected one is fine a second later.
        skip(1);
        pub.updatePriceFeeds(tooFar);
        assertEq(pub.getPriceUnsafe(BTC).publishTime, T0 + 3);
    }

    function test_unknownFeed_reverts() public {
        vm.expectRevert(PythErrors.PriceFeedNotFound.selector);
        pub.getPriceUnsafe(BTC);
        pub.updatePriceFeeds(_update(BTC, 100_000e8, 0, uint64(T0)));
        vm.expectRevert(PythErrors.PriceFeedNotFound.selector);
        pub.getPriceUnsafe(ETH);
    }

    function test_owner_managesPublishers() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pub.setPublisher(mallory, true);

        // Add a second publisher.
        vm.expectEmit(address(pub));
        emit PublisherOracle.PublisherSet(mallory, true);
        vm.prank(owner);
        pub.setPublisher(mallory, true);
        pub.updatePriceFeeds(_one(_signed(malloryKey, pub, BTC, 100_000e8, 0, -8, uint64(T0))));
        assertEq(pub.getPriceUnsafe(BTC).price, 100_000e8);

        // Remove the first: its signatures stop working at once, including ones made earlier.
        bytes[] memory signedEarlier = _update(BTC, 100_500e8, 0, uint64(T0 + 1));
        vm.prank(owner);
        pub.setPublisher(publisher, false);
        assertFalse(pub.isPublisher(publisher));
        skip(1);
        vm.expectRevert(abi.encodeWithSelector(PublisherOracle.NotPublisher.selector, publisher));
        pub.updatePriceFeeds(signedEarlier);

        // Ownership is two-step.
        vm.prank(owner);
        pub.transferOwnership(alice);
        assertEq(pub.owner(), owner);
        vm.prank(alice);
        pub.acceptOwnership();
        assertEq(pub.owner(), alice);
    }

    // ───────────────────────────── End to end with PythOracle + PerpEngine ─────────────────────────────

    struct Stack {
        TestUSDC usdc;
        PythOracle oracle;
        HouseVault vault;
        RewardToken house;
        PerpEngine engine;
        EngineLens lens;
    }

    function _deploy() internal returns (Stack memory s) {
        s.usdc = new TestUSDC();
        s.oracle = new PythOracle(IPyth(address(pub)));
        uint256 nonce = vm.getNonce(address(this));
        address predictedVault = vm.computeCreateAddress(address(this), nonce);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedEngine = vm.computeCreateAddress(address(this), nonce + 2);
        s.vault = new HouseVault(IERC20(address(s.usdc)), predictedEngine, predictedToken, 1 hours, 1 days);
        s.house = new RewardToken(predictedVault, predictedEngine, 1 days);
        s.engine = new PerpEngine(
            IERC20(address(s.usdc)), s.oracle, IHouseVault(predictedVault), IRewardToken(predictedToken), owner
        );
        s.lens = new EngineLens(s.engine);
        MarketConfig memory cfg = MarketConfig({
            symbol: "BTC-USD",
            feedId: BTC,
            quoteFeedId: bytes32(0),
            invert: false,
            maxLeverage: 100,
            expiry: 0,
            maxOiPerSide: 1_000_000e6,
            skewScale: 1_000_000e6
        });
        vm.startPrank(owner);
        s.engine.addMarket(BTC, cfg);
        cfg.symbol = "ETH-BTC";
        cfg.feedId = ETH;
        cfg.quoteFeedId = BTC;
        s.engine.addMarket(keccak256("ETH-BTC"), cfg);
        s.engine.setFeeParams(5, 0, 0, 0.1e6);
        vm.stopPrank();

        s.usdc.mint(address(this), 1_000_000e6);
        s.usdc.approve(address(s.vault), type(uint256).max);
        s.vault.deposit(1_000_000e6, address(this));
        s.usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        s.usdc.approve(address(s.engine), type(uint256).max);
        vm.deal(alice, 1 ether);
    }

    function _params(bytes32 id, bool isLong, uint256 margin, uint256 size) internal pure returns (OpenParams memory) {
        return OpenParams({
            priceId: id, isLong: isLong, margin: margin, size: size, acceptablePrice: 0, takeProfit: 0, stopLoss: 0
        });
    }

    function test_endToEnd_openCloseAndLiquidateWithSignedUpdates() public {
        Stack memory s = _deploy();
        assertEq(address(s.engine.pyth()), address(pub));

        // No price has ever been published: the adapter reports it as unavailable rather than reverting.
        (PriceStatus status,) = s.oracle.peek(BTC, bytes32(0), false, 10, 50);
        assertEq(uint8(status), uint8(PriceStatus.Unavailable));
        vm.prank(alice);
        vm.expectRevert(PerpEngine.OraclePriceUnavailable.selector);
        s.engine.openPosition(_params(BTC, true, 1_000e6, 10_000e6), new bytes[](0));

        // Open with a signed update passed as `priceUpdate`. The oracle is free; any value sent comes back.
        bytes[] memory update = _update(BTC, 100_000e8, 10e8, uint64(T0));
        uint256 nativeBefore = alice.balance;
        vm.prank(alice);
        s.engine.openPosition{value: 0.01 ether}(_params(BTC, true, 1_000e6, 10_000e6), update);
        assertEq(alice.balance, nativeBefore);
        assertEq(address(s.engine).balance, 0);
        assertEq(address(pub).balance, 0);
        assertEq(s.engine.getPosition(alice, BTC).entryPrice, 100_010e18); // the ask
        OraclePrice memory px = s.engine.getPrice(BTC);
        assertEq(px.mid, 100_000e18);
        assertEq(px.bid, 99_990e18);
        assertEq(px.publishTime, T0);

        // A forged update is rejected by the oracle and the whole trade reverts with it.
        bytes[] memory forged = _one(_signed(malloryKey, pub, BTC, 200_000e8, 0, -8, uint64(T0 + 1)));
        skip(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PublisherOracle.NotPublisher.selector, mallory));
        s.engine.closePosition(BTC, 0, 0, forged);

        // Close with the next signed price: +1,000 on the mid, sold at the bid.
        update = _update(BTC, 101_010e8, 0, uint64(T0 + 1));
        vm.prank(alice);
        s.engine.closePosition(BTC, 0, 0, update);
        // 10,000 * (101,010 - 100,010) / 100,010 = 99.990000..., rounded down; minus 5 + 5 of fees
        assertEq(s.usdc.balanceOf(alice), 10_000e6 - 5e6 + 99_990_000 - 5e6);

        // A 100x position liquidated by a keeper bringing its own signed price.
        skip(10);
        update = _update(BTC, 100_000e8, 0, uint64(T0 + 11));
        vm.prank(alice);
        s.engine.openPosition(_params(BTC, true, 100e6, 10_000e6), update);
        skip(10);
        update = _update(BTC, 99_000e8, 0, uint64(T0 + 21));
        address keeper = makeAddr("keeper");
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = s.engine.positionKey(alice, BTC);
        vm.prank(keeper);
        assertEq(s.engine.liquidateBatch(keys, update), 1);
        assertEq(s.usdc.balanceOf(keeper), 2e6);
        assertEq(s.usdc.balanceOf(address(s.engine)), 0);
    }

    function test_endToEnd_crossMarketWithTwoSignedFeeds() public {
        Stack memory s = _deploy();
        bytes32 id = keccak256("ETH-BTC");
        bytes[] memory data = new bytes[](2);
        data[0] = _signed(publisherKey, pub, ETH, 4_000e8, 0, -8, uint64(T0));
        data[1] = _signed(publisherKey, pub, BTC, 100_000e8, 0, -8, uint64(T0));
        vm.prank(alice);
        s.engine.openPosition(_params(id, true, 1_000e6, 10_000e6), data);
        assertEq(s.engine.getPosition(alice, id).entryPrice, 0.04e18);

        EngineLens.MarketView[] memory ms = s.lens.getMarkets();
        assertEq(ms.length, 2);
        assertTrue(ms[0].hasPrice);
        assertTrue(ms[1].hasPrice);
        assertEq(ms[1].price.mid, 0.04e18);

        skip(1);
        data[0] = _signed(publisherKey, pub, ETH, 4_200e8, 0, -8, uint64(T0 + 1));
        data[1] = _signed(publisherKey, pub, BTC, 100_000e8, 0, -8, uint64(T0 + 1));
        vm.prank(alice);
        s.engine.closePosition(id, 0, 0, data);
        assertEq(s.usdc.balanceOf(alice), 10_000e6 - 5e6 + 500e6 - 5e6);
    }
}

contract TestUSDCTest is Test {
    TestUSDC internal token;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new TestUSDC();
    }

    function test_metadata() public view {
        assertEq(token.name(), "Test USDC (Dry Powder)");
        assertEq(token.symbol(), "tUSDC");
        assertEq(token.decimals(), 6);
        assertEq(token.MAX_MINT(), 1_000_000e6);
        assertEq(token.totalSupply(), 0);
    }

    function test_mint_anyoneToAnyone_upToTheCapPerCall() public {
        vm.prank(alice);
        token.mint(bob, 1_000_000e6);
        assertEq(token.balanceOf(bob), 1_000_000e6);

        vm.prank(alice);
        vm.expectRevert(TestUSDC.MintTooLarge.selector);
        token.mint(bob, 1_000_000e6 + 1);

        // The cap is per call, not per account.
        vm.prank(bob);
        token.mint(bob, 1_000_000e6);
        assertEq(token.balanceOf(bob), 2_000_000e6);
        token.mint(alice, 0);
        assertEq(token.totalSupply(), 2_000_000e6);
    }

    function testFuzz_mint(uint256 amount) public {
        if (amount > 1_000_000e6) {
            vm.expectRevert(TestUSDC.MintTooLarge.selector);
            token.mint(alice, amount);
        } else {
            token.mint(alice, amount);
            assertEq(token.balanceOf(alice), amount);
        }
    }
}
