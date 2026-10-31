// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title Verifies responses signed by an Airnode v2
/// @notice An Airnode v2, which serves the APIs on AirnodeHub, signs every response with EIP-191 over
/// keccak256(requestHash, timestamp, data), as https://airnodehub-docs.api3.org/airnode/attestation describes.
library AirnodeV2Attestation {
    error NotSignedByAirnode(address signer);

    /// @notice Recovers the address that signed a response
    /// @param requestHash Hash of the request that the response answers
    /// @param timestamp Unix time in seconds at which the Airnode signed the response
    /// @param data Bytes of the `data` string that the Airnode signed, such as {"price":2443.95}
    /// @param signature 65-byte signature
    function recoverSigner(bytes32 requestHash, uint256 timestamp, bytes memory data, bytes memory signature)
        internal
        pure
        returns (address)
    {
        bytes32 digest = keccak256(abi.encodePacked(requestHash, timestamp, data));
        return ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature);
    }

    /// @notice Reverts unless `airnode` signed `data` as its response to the request with `requestHash`
    /// @dev Use an Airnode address and a request hash that your contract stores, never the ones that come with the
    /// response. This function does not check `timestamp`, so check yourself that the response is fresh enough.
    function verify(address airnode, bytes32 requestHash, uint256 timestamp, bytes memory data, bytes memory signature)
        internal
        pure
    {
        address signer = recoverSigner(requestHash, timestamp, data, signature);
        if (signer != airnode) revert NotSignedByAirnode(signer);
    }
}
