// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IHashedTimelock {
    function lockFor(address refundTo, address receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter) external returns (bytes32);
}

/// Swap any token into USDC on a DEX and lock exactly `amountOut` in the HTLC, in ONE transaction.
/// The donor never holds USDC; if the DEX gives less than `amountOut`, everything reverts and nothing moves.
///
/// Stateless: it holds no funds between transactions, so the arbitrary DEX call can only touch what this
/// transaction brought in. That is why the call lives here and not in the HTLC, which holds everyone's locks.
contract SwapAndLock {
    /// What to swap and what to lock. `amountOut` USDC is locked exactly; the DEX must give at least that.
    struct Order {
        address htlc;
        address tokenIn;
        uint256 amountIn;
        address dex;
        address tokenOut;
        uint256 amountOut;
        address receiver;
        bytes32 hashlock;
        uint64 refundAfter;
    }

    function swapAndLock(Order calldata o, bytes calldata dexCall) external returns (bytes32 id) {
        require(o.dex != o.htlc && o.dex != o.tokenIn && o.dex != o.tokenOut, "dex");
        _call(o.tokenIn, abi.encodeCall(IERC20Min.transferFrom, (msg.sender, address(this), o.amountIn)));
        _call(o.tokenIn, abi.encodeCall(IERC20Min.approve, (o.dex, o.amountIn)));
        uint256 got = _swap(o.dex, o.tokenOut, dexCall);
        require(got >= o.amountOut, "slippage");
        _call(o.tokenIn, abi.encodeCall(IERC20Min.approve, (o.dex, 0)));
        _call(o.tokenOut, abi.encodeCall(IERC20Min.approve, (o.htlc, o.amountOut)));
        id = IHashedTimelock(o.htlc).lockFor(msg.sender, o.receiver, o.tokenOut, o.amountOut, o.hashlock, o.refundAfter);
        // Hand back whatever is left: surplus USDC, and any tokenIn the DEX did not take.
        if (got > o.amountOut) _call(o.tokenOut, abi.encodeCall(IERC20Min.transfer, (msg.sender, got - o.amountOut)));
        uint256 restIn = IERC20Min(o.tokenIn).balanceOf(address(this));
        if (restIn > 0) _call(o.tokenIn, abi.encodeCall(IERC20Min.transfer, (msg.sender, restIn)));
    }

    /// Run the DEX call; return how much tokenOut it delivered to this contract.
    function _swap(address dex, address tokenOut, bytes calldata dexCall) private returns (uint256) {
        uint256 before = IERC20Min(tokenOut).balanceOf(address(this));
        (bool ok, ) = dex.call(dexCall);
        require(ok, "swap");
        return IERC20Min(tokenOut).balanceOf(address(this)) - before;
    }

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer");
    }
}
