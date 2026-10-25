// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {DeployAddons} from "../script/DeployAddons.s.sol";
import {AgentAccountFactory} from "../src/AgentAccount.sol";
import {IEngine} from "../src/interfaces/IEngine.sol";
import {TrailingStops} from "../src/TrailingStops.sol";
import {TwapOrders} from "../src/TwapOrders.sol";

/// @dev The add-on script against the fixture's engine. Its two environment variables are set only here.
contract DeployAddonsTest is Base {
    function test_deploysTheAddOns_wiredToTheVenue_andRefusesAnotherEnginesFactory() public {
        AgentAccountFactory factory = new AgentAccountFactory(IERC20(address(usdc)), engine);
        vm.setEnv("ENGINE_ADDRESS", vm.toString(address(engine)));
        vm.setEnv("AGENT_FACTORY_ADDRESS", vm.toString(address(factory)));
        (TrailingStops ts, TwapOrders tw) = new DeployAddons().run();
        assertEq(address(ts.engine()), address(engine));
        assertEq(address(ts.factory()), address(factory));
        assertEq(address(tw.engine()), address(engine));
        assertEq(address(tw.factory()), address(factory));
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), "-addons.json"));
        assertEq(vm.parseJsonAddress(json, ".trailingStops"), address(ts));
        assertEq(vm.parseJsonAddress(json, ".twapOrders"), address(tw));
        assertEq(vm.parseJsonAddress(json, ".engine"), address(engine));

        // A factory deployed for another engine is refused.
        IEngine other = IEngine(makeAddr("otherEngine"));
        vm.etch(address(other), hex"00");
        AgentAccountFactory foreign = new AgentAccountFactory(IERC20(address(usdc)), other);
        vm.setEnv("AGENT_FACTORY_ADDRESS", vm.toString(address(foreign)));
        DeployAddons script = new DeployAddons();
        vm.expectRevert(bytes("DeployAddons: the factory is not this engine's"));
        script.run();
    }
}
