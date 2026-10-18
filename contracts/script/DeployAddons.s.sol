// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AgentAccountFactory} from "../src/AgentAccount.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {TrailingStops} from "../src/TrailingStops.sol";
import {TwapOrders} from "../src/TwapOrders.sol";

/// @notice Deploys the add-ons that sit beside a live venue without changing it (TrailingStops and TwapOrders),
///         wired to the engine and agent account factory already deployed. Both are stateless towards the venue:
///         redeploying one only drops the trails or TWAPs set on the old copy.
///
/// Usage (Arc Testnet; the addresses come from deployments/arc-testnet.json):
///   ENGINE_ADDRESS=0x… AGENT_FACTORY_ADDRESS=0x… \
///     forge script script/DeployAddons.s.sol:DeployAddons --rpc-url arc_testnet --broadcast --account <keystore>
///
/// Writes deployments/<chainId>-addons.json (keeper/scripts/forge-deployment.mjs addons merges it into
/// deployments/arc-testnet.json).
contract DeployAddons is Script {
    function run() external returns (TrailingStops trailingStops, TwapOrders twapOrders) {
        address engine = vm.envAddress("ENGINE_ADDRESS");
        address factory = vm.envAddress("AGENT_FACTORY_ADDRESS");
        require(engine.code.length != 0, "DeployAddons: no contract at ENGINE_ADDRESS");
        // A factory for another engine would wire trails to accounts that trade elsewhere.
        require(
            address(AgentAccountFactory(factory).engine()) == engine, "DeployAddons: the factory is not this engine's"
        );

        vm.startBroadcast();
        trailingStops = new TrailingStops(PerpEngine(engine), AgentAccountFactory(factory));
        twapOrders = new TwapOrders(PerpEngine(engine), AgentAccountFactory(factory));
        vm.stopBroadcast();

        console2.log("TrailingStops:", address(trailingStops));
        console2.log("TwapOrders:   ", address(twapOrders));
        string memory json = "addons";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "engine", engine);
        vm.serializeAddress(json, "agentFactory", factory);
        vm.serializeAddress(json, "trailingStops", address(trailingStops));
        string memory out = vm.serializeAddress(json, "twapOrders", address(twapOrders));
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), "-addons.json"));
    }
}
