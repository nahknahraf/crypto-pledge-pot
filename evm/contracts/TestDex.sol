// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IMintable {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function mint(address to, uint256 amount) external;
}

/// A fixed-rate "DEX" for local tests only: takes tokenIn, mints tokenOut (a TestUSDC) at num/den.
/// On a real chain, SwapAndLock calls a real DEX router (e.g. Uniswap) with calldata built off-chain.
contract TestDex {
    uint256 public immutable num;
    uint256 public immutable den;
    constructor(uint256 num_, uint256 den_) { num = num_; den = den_; }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        require(IMintable(tokenIn).transferFrom(msg.sender, address(this), amountIn), "in");
        out = amountIn * num / den;
        require(out >= minOut, "minOut");
        IMintable(tokenOut).mint(msg.sender, out);
    }
}
