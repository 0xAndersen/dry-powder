// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";

import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IHouseVault} from "../src/interfaces/IHouseVault.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";

/// @notice Deploys HouseVault, RewardToken and PerpEngine and lists the four launch markets.
///
/// Usage (Arc Testnet):
///   forge script script/Deploy.s.sol:Deploy --rpc-url arc_testnet --broadcast --account <keystore-name>
///
/// Optional environment overrides:
///   USDC_ADDRESS           default: Arc native USDC ERC-20 interface
///   PYTH_ADDRESS           default: Pyth price feed contract on Arc Testnet; required on any other chain
///   OWNER_ADDRESS          default: the deployer. If different, ownership is offered via Ownable2Step and the
///                          new owner must call acceptOwnership().
///   WITHDRAW_LOCK_SECONDS  default: 3600
///   MAX_PRICE_AGE_SECONDS  default: 10 (maximum age of a Pyth price accepted by the engine)
///
/// @dev The three contracts reference each other immutably, so their addresses are predicted from the
///      deployer's nonce. Nothing else may be broadcast from the deployer between the three creations.
contract Deploy is Script {
    /// @dev Arc's native USDC, ERC-20 interface (6 decimals). Same address on every Arc network.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    /// @dev Pyth price feed contract on Arc Testnet (chain id 5042002).
    address internal constant ARC_TESTNET_PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    // Pyth stable-channel feed ids.
    bytes32 internal constant BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 internal constant EUR_USD = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;
    /// @dev Pyth publishes USD/JPY only. The JPY/USD market is listed on this feed with `invert = true`.
    bytes32 internal constant USD_JPY = 0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52;

    struct Deployment {
        HouseVault vault;
        RewardToken rewardToken;
        PerpEngine engine;
    }

    function run() external returns (Deployment memory d) {
        address usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);
        address pyth = vm.envOr("PYTH_ADDRESS", address(0));
        if (pyth == address(0)) {
            // The built-in default is only right for Arc Testnet (and for local simulation). Anywhere else a
            // wrong oracle would be wired in immutably, so the address must be given explicitly.
            require(block.chainid == ARC_TESTNET_CHAIN_ID || block.chainid == 31337, "Deploy: set PYTH_ADDRESS");
            pyth = ARC_TESTNET_PYTH;
        }
        uint256 withdrawLock = vm.envOr("WITHDRAW_LOCK_SECONDS", uint256(1 hours));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address owner = vm.envOr("OWNER_ADDRESS", deployer);

        uint256 nonce = vm.getNonce(deployer);
        address predictedVault = vm.computeCreateAddress(deployer, nonce);
        address predictedToken = vm.computeCreateAddress(deployer, nonce + 1);
        address predictedEngine = vm.computeCreateAddress(deployer, nonce + 2);

        d.vault = new HouseVault(IERC20(usdc), predictedEngine, predictedToken, withdrawLock);
        d.rewardToken = new RewardToken(predictedVault, predictedEngine);
        d.engine = new PerpEngine(
            IERC20(usdc), IPyth(pyth), IHouseVault(predictedVault), IRewardToken(predictedToken), deployer
        );
        require(
            address(d.vault) == predictedVault && address(d.rewardToken) == predictedToken
                && address(d.engine) == predictedEngine,
            "Deploy: address prediction failed"
        );

        // priceId, invert, maxLeverage, maxOiPerSide, skewScale
        d.engine.addMarket(BTC_USD, false, 100, 1_000_000e6, 250_000e6);
        d.engine.addMarket(ETH_USD, false, 100, 1_000_000e6, 250_000e6);
        d.engine.addMarket(EUR_USD, false, 100, 1_000_000e6, 250_000e6);
        d.engine.addMarket(USD_JPY, true, 100, 1_000_000e6, 250_000e6);

        // Price staleness window. The engine's built-in 3s suits keeper-submitted transactions; a person
        // approving in a browser wallet needs longer, at the cost of a wider stale-price window (SECURITY.md).
        d.engine.setRiskParams(vm.envOr("MAX_PRICE_AGE_SECONDS", uint256(10)), 50, 30_000, 5e6);

        if (owner != deployer) d.engine.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("HouseVault  (rcUSDC):", address(d.vault));
        console2.log("RewardToken (HOUSE): ", address(d.rewardToken));
        console2.log("PerpEngine:          ", address(d.engine));

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "usdc", usdc);
        vm.serializeAddress(json, "pyth", pyth);
        vm.serializeAddress(json, "houseVault", address(d.vault));
        vm.serializeAddress(json, "rewardToken", address(d.rewardToken));
        string memory out = vm.serializeAddress(json, "perpEngine", address(d.engine));
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
