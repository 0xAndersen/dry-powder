// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @dev The two calls of Safe v1.4.1's proxy factory and singleton this script uses.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @notice Hands the venue's owner keys to a timelock that a multisig controls (roadmap item 100): after it, no
///         single key can change a fee, a risk limit or a market, and every change waits `TIMELOCK_DELAY_SECONDS`
///         in public before anyone can execute it.
///
/// Usage (the broadcaster must own the engine, and the publisher oracle if one is given):
///   ENGINE_ADDRESS=0x… [PUBLISHER_ORACLE_ADDRESS=0x…] SAFE_ADDRESS=0x… [TIMELOCK_DELAY_SECONDS=172800] \
///     forge script script/Governance.s.sol:Governance --rpc-url arc_testnet --broadcast --account <keystore>
/// Instead of SAFE_ADDRESS, SAFE_OWNERS=0xA,0xB,0xC and SAFE_THRESHOLD=2 create a Safe first (v1.4.1, at its
/// canonical addresses on Arc Testnet, docs/ARC_NOTES.md; SAFE_FACTORY, SAFE_SINGLETON, SAFE_FALLBACK_HANDLER
/// override them elsewhere).
///
/// End state:
///  - a TimelockController with the multisig as its only proposer and canceller, anyone as executor, no admin;
///  - the engine (and the oracle) owned by the timelock, ownership accepted;
///  - the broadcaster holding no role and no ownership.
/// The ownership handover runs through the timelock itself at a zero delay that the same batch then raises, so it
/// completes in one run instead of waiting out the delay.
contract Governance is Script {
    address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    uint256 internal constant DEFAULT_DELAY = 2 days;

    function run() external returns (TimelockController timelock, address safe) {
        return handOver(
            vm.envAddress("ENGINE_ADDRESS"),
            vm.envOr("PUBLISHER_ORACLE_ADDRESS", address(0)),
            vm.envOr("SAFE_ADDRESS", address(0)),
            vm.envOr("TIMELOCK_DELAY_SECONDS", DEFAULT_DELAY)
        );
    }

    /// @notice {run} with its inputs as arguments (`safe` zero: create one from SAFE_OWNERS and SAFE_THRESHOLD).
    function handOver(address engine, address oracle, address safe_, uint256 delay)
        public
        returns (TimelockController timelock, address safe)
    {
        require(delay != 0, "Governance: a zero delay is no timelock");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        require(Ownable2Step(engine).owner() == deployer, "Governance: the broadcaster does not own the engine");
        if (oracle != address(0)) {
            require(Ownable2Step(oracle).owner() == deployer, "Governance: the broadcaster does not own the oracle");
        }

        safe = safe_ == address(0) ? _createSafe() : safe_;

        // The broadcaster is a proposer only for the handover below, and gives the role up at the end of it.
        address[] memory proposers = new address[](2);
        (proposers[0], proposers[1]) = (safe, deployer);
        address[] memory executors = new address[](1); // address(0): anyone may execute a ready operation
        timelock = new TimelockController(0, proposers, executors, address(0));

        Ownable2Step(engine).transferOwnership(address(timelock));
        if (oracle != address(0)) Ownable2Step(oracle).transferOwnership(address(timelock));

        uint256 n = oracle != address(0) ? 3 : 2;
        address[] memory targets = new address[](n);
        uint256[] memory values = new uint256[](n);
        bytes[] memory calls = new bytes[](n);
        targets[0] = engine;
        calls[0] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        if (oracle != address(0)) {
            targets[1] = oracle;
            calls[1] = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        }
        targets[n - 1] = address(timelock);
        calls[n - 1] = abi.encodeCall(TimelockController.updateDelay, (delay));
        bytes32 salt = keccak256("dry-powder/governance/handover");
        timelock.scheduleBatch(targets, values, calls, bytes32(0), salt, 0);
        timelock.executeBatch(targets, values, calls, bytes32(0), salt);

        timelock.renounceRole(timelock.PROPOSER_ROLE(), deployer);
        timelock.renounceRole(timelock.CANCELLER_ROLE(), deployer);
        vm.stopBroadcast();

        console2.log("Multisig:  ", safe);
        console2.log("Timelock:  ", address(timelock));
        console2.log("Delay (s): ", delay);
        string memory json = "governance";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "engine", engine);
        vm.serializeAddress(json, "publisherOracle", oracle);
        vm.serializeAddress(json, "multisig", safe);
        vm.serializeUint(json, "delaySeconds", delay);
        string memory out = vm.serializeAddress(json, "timelock", address(timelock));
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), "-governance.json"));
    }

    /// @dev A Safe of SAFE_OWNERS with SAFE_THRESHOLD signatures, from the canonical v1.4.1 factory.
    function _createSafe() internal returns (address) {
        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        uint256 threshold = vm.envUint("SAFE_THRESHOLD");
        require(threshold != 0 && threshold <= owners.length, "Governance: SAFE_THRESHOLD out of range");
        bytes memory setup = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            threshold,
            address(0),
            bytes(""),
            vm.envOr("SAFE_FALLBACK_HANDLER", SAFE_FALLBACK_HANDLER),
            address(0),
            uint256(0),
            address(0)
        );
        address factory = vm.envOr("SAFE_FACTORY", SAFE_FACTORY);
        require(factory.code.length != 0, "Governance: no Safe factory on this chain");
        return ISafeProxyFactory(factory)
            .createProxyWithNonce(
                vm.envOr("SAFE_SINGLETON", SAFE_SINGLETON), setup, uint256(keccak256(abi.encode(owners, threshold)))
            );
    }
}
