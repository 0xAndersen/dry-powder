// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title PublisherOracle
/// @notice A pull oracle with the same call surface PerpEngine uses on Pyth (`getPriceUnsafe`, `getUpdateFee`,
///         `updatePriceFeeds`), fed by price updates signed by authorised publishers instead of by Pyth's
///         network. It exists so the protocol can run where Pyth data is not being delivered: on Arc Testnet
///         nobody pushes Pyth prices and Hermes requires a paid key.
///
/// @dev TESTNET INFRASTRUCTURE. Whoever holds a publisher key decides every price. Do not use with real funds;
///      deploy against the real Pyth contract instead (PythOracle and PerpEngine need no change).
///
///      An update is `abi.encode(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, bytes sig)`
///      where `sig` is the publisher's EIP-191 signature over
///      `keccak256(abi.encode(block.chainid, address(this), id, price, conf, expo, publishTime))`.
///      As with Pyth, anyone may submit a signed update and only a strictly newer one replaces the stored price.
contract PublisherOracle is Ownable2Step {
    mapping(address publisher => bool) public isPublisher;
    mapping(bytes32 id => PythStructs.Price) private _prices;

    event PublisherSet(address indexed publisher, bool allowed);
    event PriceFeedUpdate(bytes32 indexed id, uint64 publishTime, int64 price, uint64 conf);

    error NotPublisher(address signer);
    error PublishTimeInFuture();

    constructor(address owner_, address publisher_) Ownable(owner_) {
        isPublisher[publisher_] = true;
        emit PublisherSet(publisher_, true);
    }

    function setPublisher(address publisher, bool allowed) external onlyOwner {
        isPublisher[publisher] = allowed;
        emit PublisherSet(publisher, allowed);
    }

    /// @notice Hash a publisher signs (before the EIP-191 prefix) for one price.
    function updateDigest(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), id, price, conf, expo, publishTime));
    }

    /// @notice Free, unlike Pyth. Kept so callers written for Pyth work unchanged.
    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        for (uint256 i; i < updateData.length; ++i) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, bytes memory sig) =
                abi.decode(updateData[i], (bytes32, int64, uint64, int32, uint64, bytes));
            address signer = ECDSA.recover(
                MessageHashUtils.toEthSignedMessageHash(updateDigest(id, price, conf, expo, publishTime)), sig
            );
            if (!isPublisher[signer]) revert NotPublisher(signer);
            // A publisher with a fast clock must not be able to park a price that stays "fresh" for longer.
            if (publishTime > block.timestamp + 2) revert PublishTimeInFuture();
            if (publishTime > _prices[id].publishTime) {
                _prices[id] = PythStructs.Price({price: price, conf: conf, expo: expo, publishTime: publishTime});
                emit PriceFeedUpdate(id, publishTime, price, conf);
            }
        }
    }

    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory price) {
        price = _prices[id];
        if (price.publishTime == 0) revert PythErrors.PriceFeedNotFound();
    }
}
