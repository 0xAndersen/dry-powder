// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";

import {EngineLens} from "../src/EngineLens.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IHouseVault} from "../src/interfaces/IHouseVault.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";
import {PublisherOracle} from "../src/testnet/PublisherOracle.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {AgentAccountFactory} from "../src/AgentAccount.sol";
import {TrailingStops} from "../src/TrailingStops.sol";
import {TwapOrders} from "../src/TwapOrders.sol";
import {MarketConfig} from "../src/Types.sol";

/// @notice Deploys the protocol (PythOracle adapter, HouseVault, RewardToken, PerpEngine, EngineLens) and lists
///         the eight launch markets.
///
/// Usage (Arc Testnet):
///   forge script script/Deploy.s.sol:Deploy --rpc-url arc_testnet --broadcast --account <keystore-name>
///
/// Optional environment overrides:
///   ORACLE_MODE            "pyth" (default): use the Pyth contract at PYTH_ADDRESS.
///                          "publisher": deploy a PublisherOracle (owner = deployer) and use it in Pyth's place.
///                          TESTNET ONLY: whoever holds a publisher key decides every price.
///   PYTH_ADDRESS           pyth mode only. Default: Pyth on Arc Testnet; required on any other chain.
///   PUBLISHER_ADDRESS      publisher mode only. The first authorised price signer. Default: the deployer.
///   COLLATERAL             "usdc" (default): use USDC_ADDRESS. "test": deploy an open-mint TestUSDC and use
///                          that (TESTNET ONLY).
///   USDC_ADDRESS           default: Arc native USDC ERC-20 interface
///   OWNER_ADDRESS          default: the deployer. If different, engine ownership is offered via Ownable2Step
///                          and the new owner must call acceptOwnership().
///   WITHDRAW_LOCK_SECONDS  default: 3600
///   EPOCH_SECONDS          default: 86400 (minimum time between staker-yield settlements)
///   STREAM_SECONDS         default: 86400 (time over which each settled amount is streamed to stakers)
///   MAX_PRICE_AGE_SECONDS  default: 10 (maximum age of an oracle price accepted by the engine)
///   FUTURE_EXPIRY          unix time at which the dated BTC future expires. Default (unset or 0): the next
///                          Friday 08:00 UTC that is strictly more than 24 hours away.
///
/// @dev Vault, token and engine reference each other immutably, so their addresses are predicted from the
///      deployer's nonce. Nothing else may be broadcast from the deployer between those three creations. No
///      contract here links an external library (which forge would deploy from the same account and shift the
///      nonce); keep it that way.
contract Deploy is Script {
    /// @dev Arc's native USDC, ERC-20 interface (6 decimals). Same address on every Arc network.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    /// @dev Pyth price feed contract on Arc Testnet (chain id 5042002).
    address internal constant ARC_TESTNET_PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    // Pyth stable-channel feed ids.
    bytes32 internal constant BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 internal constant SOL_USD = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;
    bytes32 internal constant EUR_USD = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;
    /// @dev Pyth publishes USD/JPY only. The JPY-USD market is listed on this feed with `invert = true`.
    bytes32 internal constant USD_JPY = 0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52;
    bytes32 internal constant XAU_USD = 0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2;

    uint256 internal constant MAX_OI_PER_SIDE = 1_000_000e6;
    uint256 internal constant SKEW_SCALE = 250_000e6;

    struct Deployment {
        address usdc; // collateral actually used (a fresh TestUSDC when COLLATERAL=test)
        address pyth; // Pyth, or the PublisherOracle standing in for it
        PublisherOracle publisherOracle; // zero in pyth mode
        PythOracle oracle;
        HouseVault vault;
        RewardToken rewardToken;
        PerpEngine engine;
        EngineLens lens;
        AgentAccountFactory agentFactory;
        TrailingStops trailingStops;
        TwapOrders twapOrders;
        uint64 futureExpiry;
        bytes32[] marketIds;
        string[] marketSymbols;
    }

    function run() external returns (Deployment memory d) {
        string memory oracleMode = vm.envOr("ORACLE_MODE", string("pyth"));
        bool publisherMode = _eq(oracleMode, "publisher");
        require(publisherMode || _eq(oracleMode, "pyth"), "Deploy: ORACLE_MODE must be pyth or publisher");
        string memory collateral = vm.envOr("COLLATERAL", string("usdc"));
        bool testCollateral = _eq(collateral, "test");
        require(testCollateral || _eq(collateral, "usdc"), "Deploy: COLLATERAL must be usdc or test");

        d.usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);
        if (!publisherMode) {
            d.pyth = vm.envOr("PYTH_ADDRESS", address(0));
            if (d.pyth == address(0)) {
                // The built-in default is only right for Arc Testnet (and for local simulation). Anywhere else
                // a wrong oracle would be wired in immutably, so the address must be given explicitly.
                require(block.chainid == ARC_TESTNET_CHAIN_ID || block.chainid == 31337, "Deploy: set PYTH_ADDRESS");
                d.pyth = ARC_TESTNET_PYTH;
            }
            // The adapter treats a failing Pyth call as "no price", but a call to an address without code is
            // not a failing call: it would revert every valuation. Refuse to wire that in.
            require(d.pyth.code.length != 0, "Deploy: no contract at PYTH_ADDRESS");
        }
        d.futureExpiry = uint64(vm.envOr("FUTURE_EXPIRY", uint256(0)));
        if (d.futureExpiry == 0) d.futureExpiry = defaultFutureExpiry(block.timestamp);
        require(d.futureExpiry > block.timestamp, "Deploy: FUTURE_EXPIRY is in the past");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("OWNER_ADDRESS", deployer);

        if (testCollateral) d.usdc = address(new TestUSDC());
        if (publisherMode) {
            d.publisherOracle = new PublisherOracle(deployer, vm.envOr("PUBLISHER_ADDRESS", deployer));
            d.pyth = address(d.publisherOracle);
        }
        d.oracle = new PythOracle(IPyth(d.pyth));
        _deployCore(d, deployer);
        d.lens = new EngineLens(d.engine);
        d.agentFactory = new AgentAccountFactory(IERC20(d.usdc), d.engine);
        d.trailingStops = new TrailingStops(d.engine, d.agentFactory);
        d.twapOrders = new TwapOrders(d.engine, d.agentFactory);
        _listMarkets(d);
        if (testCollateral) _seedVault(d, deployer, vm.envOr("VAULT_SEED", uint256(0)));

        // Price staleness window. The engine's built-in 3s suits keeper-submitted transactions; a person
        // approving in a browser wallet needs longer, at the cost of a wider stale-price window (SECURITY.md).
        d.engine.setRiskParams(vm.envOr("MAX_PRICE_AGE_SECONDS", uint256(10)), 50, 30_000, 5e6);

        if (owner != deployer) d.engine.transferOwnership(owner);
        vm.stopBroadcast();

        _report(d, oracleMode, collateral, owner);
    }

    /// @dev The three mutually-referencing contracts, at addresses predicted from the deployer's nonce.
    function _deployCore(Deployment memory d, address deployer) internal {
        uint256 nonce = vm.getNonce(deployer);
        address predictedVault = vm.computeCreateAddress(deployer, nonce);
        address predictedToken = vm.computeCreateAddress(deployer, nonce + 1);
        address predictedEngine = vm.computeCreateAddress(deployer, nonce + 2);

        d.vault = new HouseVault(
            IERC20(d.usdc),
            predictedEngine,
            predictedToken,
            vm.envOr("WITHDRAW_LOCK_SECONDS", uint256(1 hours)),
            vm.envOr("EPOCH_SECONDS", uint256(1 days))
        );
        d.rewardToken = new RewardToken(predictedVault, predictedEngine, vm.envOr("STREAM_SECONDS", uint256(1 days)));
        d.engine = new PerpEngine(
            IERC20(d.usdc), d.oracle, IHouseVault(predictedVault), IRewardToken(predictedToken), deployer
        );
        require(
            address(d.vault) == predictedVault && address(d.rewardToken) == predictedToken
                && address(d.engine) == predictedEngine,
            "Deploy: address prediction failed"
        );
    }

    /// @dev The launch markets of V2_SPEC.md. A plain perpetual is listed under its Pyth feed id; the cross and
    ///      the dated future under the hash of their symbol.
    function _listMarkets(Deployment memory d) internal {
        d.marketIds = new bytes32[](8);
        d.marketSymbols = new string[](8);
        string memory futureSymbol = string.concat("BTC-USD-", expiryTag(d.futureExpiry));

        // Majors go to 1000x (above 100x: keeper orders only, see PerpEngine.DIRECT_MAX_LEVERAGE).
        _list(d, 0, BTC_USD, MarketConfig("BTC-USD", BTC_USD, 0, false, 1000, 0, MAX_OI_PER_SIDE, SKEW_SCALE));
        _list(d, 1, ETH_USD, MarketConfig("ETH-USD", ETH_USD, 0, false, 1000, 0, MAX_OI_PER_SIDE, SKEW_SCALE));
        _list(d, 2, SOL_USD, MarketConfig("SOL-USD", SOL_USD, 0, false, 500, 0, MAX_OI_PER_SIDE, SKEW_SCALE));
        _list(d, 3, EUR_USD, MarketConfig("EUR-USD", EUR_USD, 0, false, 250, 0, MAX_OI_PER_SIDE, SKEW_SCALE));
        _list(d, 4, USD_JPY, MarketConfig("JPY-USD", USD_JPY, 0, true, 100, 0, MAX_OI_PER_SIDE, SKEW_SCALE));
        _list(d, 5, XAU_USD, MarketConfig("XAU-USD", XAU_USD, 0, false, 250, 0, MAX_OI_PER_SIDE, SKEW_SCALE));
        _list(
            d,
            6,
            keccak256("ETH-BTC"),
            MarketConfig("ETH-BTC", ETH_USD, BTC_USD, false, 100, 0, MAX_OI_PER_SIDE, SKEW_SCALE)
        );
        _list(
            d,
            7,
            keccak256(bytes(futureSymbol)),
            MarketConfig(futureSymbol, BTC_USD, 0, false, 250, d.futureExpiry, MAX_OI_PER_SIDE, SKEW_SCALE)
        );
    }

    /// @dev Test collateral only: mints `amount` (TestUSDC caps each mint at 1,000,000) and deposits it as the house.
    function _seedVault(Deployment memory d, address deployer, uint256 amount) internal {
        if (amount == 0) return;
        for (uint256 left = amount; left > 0;) {
            uint256 chunk = left > 1_000_000e6 ? 1_000_000e6 : left;
            TestUSDC(d.usdc).mint(deployer, chunk);
            left -= chunk;
        }
        IERC20(d.usdc).approve(address(d.vault), amount);
        d.vault.deposit(amount, deployer);
    }

    function _list(Deployment memory d, uint256 i, bytes32 marketId, MarketConfig memory cfg) internal {
        d.engine.addMarket(marketId, cfg);
        d.marketIds[i] = marketId;
        d.marketSymbols[i] = cfg.symbol;
    }

    function _report(Deployment memory d, string memory oracleMode, string memory collateral, address owner) internal {
        console2.log("Collateral:          ", d.usdc);
        console2.log("Pyth / publisher:    ", d.pyth);
        console2.log("PythOracle (adapter):", address(d.oracle));
        console2.log("HouseVault  (dpUSDC):", address(d.vault));
        console2.log("RewardToken (DRY): ", address(d.rewardToken));
        console2.log("PerpEngine:          ", address(d.engine));
        console2.log("EngineLens:          ", address(d.lens));
        console2.log("AgentAccountFactory: ", address(d.agentFactory));
        console2.log("TrailingStops:       ", address(d.trailingStops));
        console2.log("TwapOrders:          ", address(d.twapOrders));
        console2.log("Dated future:        ", d.marketSymbols[7]);

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeString(json, "oracleMode", oracleMode);
        vm.serializeString(json, "collateral", collateral);
        vm.serializeAddress(json, "owner", owner);
        vm.serializeAddress(json, "usdc", d.usdc);
        vm.serializeAddress(json, "pyth", d.pyth);
        vm.serializeAddress(json, "publisherOracle", address(d.publisherOracle));
        vm.serializeAddress(json, "pythOracle", address(d.oracle));
        vm.serializeAddress(json, "houseVault", address(d.vault));
        vm.serializeAddress(json, "rewardToken", address(d.rewardToken));
        vm.serializeAddress(json, "perpEngine", address(d.engine));
        vm.serializeAddress(json, "engineLens", address(d.lens));
        vm.serializeAddress(json, "agentFactory", address(d.agentFactory));
        vm.serializeAddress(json, "trailingStops", address(d.trailingStops));
        vm.serializeAddress(json, "twapOrders", address(d.twapOrders));
        vm.serializeUint(json, "futureExpiry", d.futureExpiry);
        vm.serializeBytes32(json, "marketIds", d.marketIds);
        string memory out = vm.serializeString(json, "marketSymbols", d.marketSymbols);
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }

    // ───────────────────────────── Helpers ─────────────────────────────

    /// @notice The next Friday 08:00 UTC that is strictly more than 24 hours after `timestamp`.
    function defaultFutureExpiry(uint256 timestamp) public pure returns (uint64) {
        uint256 day = timestamp / 1 days;
        // 1970-01-01 was a Thursday, so (day + 4) % 7 is the weekday with Sunday = 0 and Friday = 5.
        uint256 daysToFriday = (12 - ((day + 4) % 7)) % 7;
        uint256 expiry = (day + daysToFriday) * 1 days + 8 hours;
        if (expiry <= timestamp + 24 hours) expiry += 7 days;
        return uint64(expiry);
    }

    /// @notice The UTC date of `timestamp` as YYMMDD, the tag in the dated future's symbol.
    function expiryTag(uint256 timestamp) public pure returns (string memory) {
        // Days since 1970-01-01 to a civil date (H. Hinnant's algorithm, valid for the whole uint64 range).
        uint256 z = timestamp / 1 days + 719_468;
        uint256 era = z / 146_097;
        uint256 dayOfEra = z - era * 146_097;
        uint256 yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365;
        uint256 dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100);
        uint256 monthIndex = (5 * dayOfYear + 2) / 153; // 0 = March
        uint256 day = dayOfYear - (153 * monthIndex + 2) / 5 + 1;
        uint256 month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
        uint256 year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
        return string.concat(_twoDigits(year % 100), _twoDigits(month), _twoDigits(day));
    }

    function _twoDigits(uint256 value) internal pure returns (string memory) {
        bytes memory out = new bytes(2);
        out[0] = bytes1(uint8(48 + value / 10));
        out[1] = bytes1(uint8(48 + value % 10));
        return string(out);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
