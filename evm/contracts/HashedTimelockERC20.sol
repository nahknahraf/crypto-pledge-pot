// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
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
        /// Kept in storage so readers need no log scans (public RPCs limit eth_getLogs ranges).
        uint64 lockedBlock;
        bytes32 secret;
    }

    mapping(bytes32 => Lock) public locks;
    uint256 public nonce;
    uint256 private entered = 1;

    /// Tokens are external code: no call back into this contract while one of its calls runs.
    /// (Each lock must receive exactly its own amount anyway; this is defence in depth, per a Slither review.)
    modifier nonReentrant() {
        require(entered == 1, "reentrancy");
        entered = 2;
        _;
        entered = 1;
    }

    event Locked(bytes32 indexed id, address indexed sender, address indexed receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter);
    event Claimed(bytes32 indexed id, bytes32 secret);
    event Refunded(bytes32 indexed id);

    function lock(address receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter) external nonReentrant returns (bytes32 id) {
        return _lock(msg.sender, receiver, token, amount, hashlock, refundAfter);
    }

    /// Lock tokens paid by the caller, refundable to `refundTo`. For contracts that act for a user in one
    /// transaction (SwapAndLock): the user, not the contract, gets the refund. The caller pays, so nobody
    /// can lock someone else's tokens.
    function lockFor(address refundTo, address receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter) external nonReentrant returns (bytes32 id) {
        require(refundTo != address(0), "refundTo");
        return _lock(refundTo, receiver, token, amount, hashlock, refundAfter);
    }

    /// The same as lock, with an EIP-2612 permit instead of a separate approve transaction (USDC supports it).
    /// If someone front-runs the permit, it is already spent but the allowance is set, so the lock still works.
    function lockWithPermit(address receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant returns (bytes32 id) {
        try IERC20Permit(token).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        return _lock(msg.sender, receiver, token, amount, hashlock, refundAfter);
    }

    /// Tokens come from msg.sender; `sender` is who may refund (msg.sender, or the user for lockFor).
    function _lock(address sender, address receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter) private returns (bytes32 id) {
        require(receiver != address(0), "receiver");
        require(amount > 0, "amount");
        require(refundAfter > block.timestamp, "refundAfter");
        id = keccak256(abi.encode(sender, receiver, token, amount, hashlock, refundAfter, nonce++));
        // Pull the tokens and check what actually arrived (refuses fee-on-transfer tokens).
        uint256 before = IERC20(token).balanceOf(address(this));
        _call(token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        require(IERC20(token).balanceOf(address(this)) - before == amount, "token");
        locks[id] = Lock(sender, receiver, token, amount, hashlock, refundAfter, State.Locked, uint64(block.number), bytes32(0));
        emit Locked(id, sender, receiver, token, amount, hashlock, refundAfter);
    }

    function claim(bytes32 id, bytes32 secret) external nonReentrant {
        Lock storage l = locks[id];
        require(l.state == State.Locked, "state");
        require(msg.sender == l.receiver, "receiver");
        require(block.timestamp < l.refundAfter, "expired");
        require(sha256(abi.encodePacked(secret)) == l.hashlock, "secret");
        l.state = State.Claimed;
        l.secret = secret;
        emit Claimed(id, secret);
        _call(l.token, abi.encodeCall(IERC20.transfer, (l.receiver, l.amount)));
    }

    function refund(bytes32 id) external nonReentrant {
        Lock storage l = locks[id];
        require(l.state == State.Locked, "state");
        require(msg.sender == l.sender, "sender");
        require(block.timestamp >= l.refundAfter, "early");
        l.state = State.Refunded;
        emit Refunded(id);
        _call(l.token, abi.encodeCall(IERC20.transfer, (l.sender, l.amount)));
    }

    /// Accepts tokens that return true and tokens that return nothing. A token's own revert reason is passed through.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) {
            if (ret.length > 0) assembly { revert(add(ret, 32), mload(ret)) }
            revert("transfer");
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), "transfer");
    }
}
