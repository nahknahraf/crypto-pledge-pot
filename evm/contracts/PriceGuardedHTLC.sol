// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {HashedTimelockERC20} from "./HashedTimelockERC20.sol";
import {AirnodeV2Attestation} from "./api3/AirnodeV2Attestation.sol";
import {ProjectedJson} from "./api3/ProjectedJson.sol";

/// @title A USDC → BSV swap lock that checks the swap rate against API3 AirnodeHub data
/// @notice The other-chain half of a CryptoPledgePot atomic swap (see HashedTimelockERC20), with one addition: a
/// donor can only lock stablecoins if the number of satoshis the liquidity agent promised for them is within
/// `maxDeviationBps` of the market rate, as an Airnode v2 on AirnodeHub signed it moments ago.
///
/// Why on chain: the donor's agent could check the quote off-chain too, but then the donor trusts that code and its
/// data source. Here the contract itself refuses an unfair or stale quote, so a manipulated quote cannot get the
/// donor's funds locked at all, whoever built the transaction.
///
/// How the data is trusted (AirnodeHub "from API to contract"):
///  1. The Airnode signs keccak256(requestHash, timestamp, data) with EIP-191. `AirnodeV2Attestation.verify` recovers
///     the signer and requires it to be `airnode`, the address this contract stores at deployment.
///  2. `requestHash` is also stored at deployment, never taken from the caller. It covers the operation, its
///     parameters and the response projection, so a signed response to any other request (another coin, another
///     field, another currency) recovers a different signer and is refused.
///  3. The signature covers `timestamp`, so the freshness checks below cannot be faked.
///  4. The projection fixes the shape of `data`: {"price":<USD per BSV>,"updatedAt":<time>}. Providers write the
///     time differently (CoinPaprika: an ISO 8601 string; Nodary: Unix milliseconds), so `priceTimeFormat` says which.
///
/// Anyone may submit the signed response (the donor's agent, the liquidity agent, a keeper): the contract trusts the
/// signature, not the submitter.
///
/// Assumptions, stated: the locked token is a USD stablecoin worth 1 USD (USDC); BSV has 8 decimals (satoshis).
contract PriceGuardedHTLC is HashedTimelockERC20 {
    /// @notice Address the Airnode signs with, e.g. CoinPaprika's on AirnodeHub (from the x-airnode extension)
    address public immutable airnode;

    /// @notice Hash of the only request whose responses are accepted (BSV/USD with a fixed projection)
    bytes32 public immutable requestHash;

    /// @notice Largest allowed difference between the quoted and the fair amount of satoshis, in basis points (200 = 2%)
    uint256 public immutable maxDeviationBps;

    /// @notice Longest time from the Airnode signing the response to the lock
    uint256 public immutable maxResponseAge;

    /// @notice Longest time from the data source taking the price to the lock
    uint256 public immutable maxPriceAge;

    /// @notice Decimals of the stablecoin (6 for USDC)
    uint8 public immutable tokenDecimals;

    /// @notice How the signed data writes `updatedAt`
    enum TimeFormat { IsoString, UnixMillis }
    TimeFormat public immutable priceTimeFormat;

    /// @notice What was checked for each lock, so anyone can audit the rate later
    struct PriceCheck {
        uint256 quotedSats;
        uint256 fairSats;
        uint256 priceUsd18;
        uint64 priceTimestamp;
    }

    mapping(bytes32 => PriceCheck) public priceChecks;

    /// @notice Hashlocks already used: one swap (one secret) can lock the donor's tokens only once
    mapping(bytes32 => bool) public hashlockUsed;

    event PriceChecked(bytes32 indexed id, uint256 quotedSats, uint256 fairSats, uint256 priceUsd18, uint64 priceTimestamp);

    error UseLockWithPrice();
    error ResponseTooOld(uint256 responseTimestamp);
    error PriceTooOld(uint256 priceTimestamp);
    error PriceFromTheFuture(uint256 priceTimestamp);
    error ZeroPrice();
    error RateOutsideTolerance(uint256 quotedSats, uint256 fairSats, uint256 maxDeviationBps);
    error HashlockAlreadyUsed(bytes32 hashlock);

    /// @dev Small clock differences between the data source, the Airnode and the chain are normal.
    uint256 private constant CLOCK_SKEW = 5 minutes;

    constructor(
        address airnode_,
        bytes32 requestHash_,
        uint256 maxDeviationBps_,
        uint256 maxResponseAge_,
        uint256 maxPriceAge_,
        uint8 tokenDecimals_,
        TimeFormat priceTimeFormat_
    ) {
        require(airnode_ != address(0), "airnode");
        require(maxDeviationBps_ > 0 && maxDeviationBps_ < 10_000, "deviation");
        airnode = airnode_;
        requestHash = requestHash_;
        maxDeviationBps = maxDeviationBps_;
        maxResponseAge = maxResponseAge_;
        maxPriceAge = maxPriceAge_;
        tokenDecimals = tokenDecimals_;
        priceTimeFormat = priceTimeFormat_;
    }

    /// @notice Locks without a price check are not possible on this contract
    function lock(address, address, uint256, bytes32, uint64) external pure override returns (bytes32) {
        revert UseLockWithPrice();
    }

    /// @notice Lock stablecoins for a swap, after checking the quoted rate against signed BSV/USD data
    /// @param receiver The liquidity agent's address (claims the tokens with the secret)
    /// @param token The stablecoin
    /// @param amount Amount in the token's smallest unit (micro-USDC)
    /// @param hashlock sha256(secret), the same as the BSV AtomicSwap's
    /// @param refundAfter When the donor may take the tokens back
    /// @param quotedSats Satoshis the liquidity agent promised to lock on BSV for `amount`
    /// @param timestamp `timestamp` of the signed response (seconds)
    /// @param data `data` of the signed response, the exact bytes the Airnode signed
    /// @param signature `signature` of the signed response
    function lockWithPrice(
        address receiver,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint64 refundAfter,
        uint256 quotedSats,
        uint256 timestamp,
        bytes calldata data,
        bytes calldata signature
    ) external returns (bytes32 id) {
        (uint256 priceUsd18, uint256 priceTimestamp) = checkedPrice(timestamp, data, signature);
        uint256 fair = fairSats(amount, priceUsd18);
        if (!withinTolerance(quotedSats, fair)) revert RateOutsideTolerance(quotedSats, fair, maxDeviationBps);
        // Duplicate execution: replaying the same lock (same hashlock) is refused, so one quote and one signed
        // response cannot lock a swap twice. Reusing a fresh price for a different swap is fine and intended.
        if (hashlockUsed[hashlock]) revert HashlockAlreadyUsed(hashlock);
        hashlockUsed[hashlock] = true;

        id = _lock(receiver, token, amount, hashlock, refundAfter);
        priceChecks[id] = PriceCheck(quotedSats, fair, priceUsd18, uint64(priceTimestamp));
        emit PriceChecked(id, quotedSats, fair, priceUsd18, uint64(priceTimestamp));
    }

    /// @notice Verify a signed BSV/USD response and return its price, as lockWithPrice would use it
    /// @dev A view, so agents can check a response (and the quote, with fairSats/withinTolerance) before paying gas.
    /// @return priceUsd18 USD per BSV with 18 decimals
    /// @return priceTimestamp When the data source took the price (seconds)
    function checkedPrice(uint256 timestamp, bytes calldata data, bytes calldata signature)
        public
        view
        returns (uint256 priceUsd18, uint256 priceTimestamp)
    {
        // 1. Signer and request: the stored airnode and request hash go into the check, never the caller's.
        AirnodeV2Attestation.verify(airnode, requestHash, timestamp, data, signature);

        // 2. The response is fresh. The signature covers the timestamp, so it is trustworthy from here on.
        if (timestamp + maxResponseAge < block.timestamp) revert ResponseTooOld(timestamp);

        // 3. The price itself is fresh: a fresh signature can still carry an old observation.
        priceUsd18 = ProjectedJson.readUint(data, "price", 18);
        priceTimestamp = priceTimeFormat == TimeFormat.IsoString
            ? ProjectedJson.readTimestamp(data, "updatedAt")
            : ProjectedJson.readUint(data, "updatedAt", 0) / 1000;
        if (priceTimestamp + maxPriceAge < block.timestamp) revert PriceTooOld(priceTimestamp);
        if (priceTimestamp > block.timestamp + CLOCK_SKEW) revert PriceFromTheFuture(priceTimestamp);
        if (priceUsd18 == 0) revert ZeroPrice();
    }

    /// @notice Satoshis that `amount` of the stablecoin is worth at `priceUsd18` (USD per BSV, 18 decimals)
    /// @dev amount / 10^tokenDecimals USD ÷ (priceUsd18 / 1e18) USD per BSV × 1e8 sats per BSV
    function fairSats(uint256 amount, uint256 priceUsd18) public view returns (uint256) {
        return (amount * 1e8 * 1e18) / (priceUsd18 * 10 ** tokenDecimals);
    }

    /// @notice Whether `quotedSats` is within ±maxDeviationBps of `fair`
    /// @dev Both directions: a far too low quote cheats the donor; a far too high one is a sign of bad or manipulated
    /// data on one side, and the swap should not go ahead on it either.
    function withinTolerance(uint256 quotedSats, uint256 fair) public view returns (bool) {
        uint256 diff = quotedSats > fair ? quotedSats - fair : fair - quotedSats;
        return diff * 10_000 <= fair * maxDeviationBps;
    }
}
