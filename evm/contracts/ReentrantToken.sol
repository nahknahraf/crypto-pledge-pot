// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IHtlcLock {
    function lock(address receiver, address token, uint256 amount, bytes32 hashlock, uint64 refundAfter) external returns (bytes32);
}

/// Tests only: an ERC-20 whose transferFrom calls back into the HTLC (once) before moving tokens.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public target;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function arm(address htlc) external { target = htlc; balanceOf[address(this)] += 1000; allowance[address(this)][htlc] = 1000; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (target != address(0)) {
            address t = target;
            target = address(0);
            IHtlcLock(t).lock(address(1), address(this), 1, bytes32(uint256(1)), uint64(block.timestamp + 3600));
        }
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
