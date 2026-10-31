// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// The other-chain half of a CryptoPledgePot atomic swap.
///
/// The sender locks ERC-20 tokens for a receiver under sha256(secret), the
/// same 32-byte hashlock as the BSV AtomicSwap contract. The receiver claims
/// with the secret before `refundAfter` (which publishes the secret in the
/// Claimed event); after it, only the sender can take the tokens back.
/// No owner, no admin, no upgrade path.
contract HashedTimelockERC20 {
    enum State { None, Locked, Claimed, Refunded }

    struct Lock {
        address sender;
        address receiver;
        address token;
        uint256 amount;
        bytes32 hashlock;
        uint64 refundAfter;
        State state;
    }

    mapping(bytes32 => Lock) public locks;
    uint256 public nonce;

    event Locked(bytes32 indexed id, address indexed sender, address indexed receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter);
    event Claimed(bytes32 indexed id, bytes32 secret);
    event Refunded(bytes32 indexed id);

    function lock(address receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter) external virtual returns (bytes32 id) {
        return _lock(receiver, token, amount, hashlock, refundAfter);
    }

    /// The lock itself, shared with contracts that add checks before it (PriceGuardedHTLC).
    function _lock(address receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter) internal returns (bytes32 id) {
        require(receiver != address(0), "receiver");
        require(amount > 0, "amount");
        require(refundAfter > block.timestamp, "refundAfter");
        id = keccak256(abi.encode(msg.sender, receiver, token, amount, hashlock, refundAfter, nonce++));
        // Pull the tokens and check what actually arrived (refuses fee-on-transfer tokens).
        uint256 before = IERC20(token).balanceOf(address(this));
        _call(token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        require(IERC20(token).balanceOf(address(this)) - before == amount, "token");
        locks[id] = Lock(msg.sender, receiver, token, amount, hashlock, refundAfter, State.Locked);
        emit Locked(id, msg.sender, receiver, token, amount, hashlock, refundAfter);
    }

    function claim(bytes32 id, bytes32 secret) external {
        Lock storage l = locks[id];
        require(l.state == State.Locked, "state");
        require(msg.sender == l.receiver, "receiver");
        require(block.timestamp < l.refundAfter, "expired");
        require(sha256(abi.encodePacked(secret)) == l.hashlock, "secret");
        l.state = State.Claimed;
        emit Claimed(id, secret);
        _call(l.token, abi.encodeCall(IERC20.transfer, (l.receiver, l.amount)));
    }

    function refund(bytes32 id) external {
        Lock storage l = locks[id];
        require(l.state == State.Locked, "state");
        require(msg.sender == l.sender, "sender");
        require(block.timestamp >= l.refundAfter, "early");
        l.state = State.Refunded;
        emit Refunded(id);
        _call(l.token, abi.encodeCall(IERC20.transfer, (l.sender, l.amount)));
    }

    /// Accepts tokens that return true and tokens that return nothing.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer");
    }
}
