/**
 * HashedTimelockERC20 refusals, on Anvil (BRIDGING_PLAN TBD "contract hardening"):
 * a fee-on-transfer token, a 0 amount, a refundAfter already past, a 0 receiver, and a token that
 * calls back into the HTLC during transferFrom (the reentrancy guard added after a Slither review).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from 'viem'
import { anvil as anvilChain } from 'viem/chains'
import artifacts from '../evm/artifacts.json'
import { anvilAccount, anvilBinary, startAnvil, type Anvil } from '../liquidity-agent/anvil'
import { deployBridgeContracts, HTLC_ABI, mintTestUsdc, TOKEN_ABI } from '../liquidity-agent/evmChain'

const deployer = anvilAccount(0); const sender = anvilAccount(1); const receiver = anvilAccount(2)
const HASH = `0x${'11'.repeat(32)}` as Hex
let node: Anvil, htlc: Address, usdc: Address, fee: Address, evil: Address

describe.skipIf(anvilBinary() === undefined)('HashedTimelockERC20 refuses bad locks', () => {
  const pub = () => createPublicClient({ chain: anvilChain, transport: http(node.rpcUrl) })
  const wallet = () => createWalletClient({ chain: anvilChain, transport: http(node.rpcUrl), account: sender })
  const now = async () => Number((await pub().getBlock()).timestamp)
  const lock = async (token: Address, amount: bigint, refundAfter: number, to: Address = receiver.address) =>
    await pub().simulateContract({ address: htlc, abi: HTLC_ABI, functionName: 'lock', args: [to, token, amount, HASH, BigInt(refundAfter)], account: sender })

  beforeAll(async () => {
    node = await startAnvil()
    ;({ htlc, token: usdc } = await deployBridgeContracts(node.rpcUrl, anvilChain, deployer, { withTestToken: true }) as { htlc: Address, token: Address })
    await mintTestUsdc(node.rpcUrl, anvilChain, deployer, usdc, sender.address, 1_000_000)
    const w = wallet()
    await pub().waitForTransactionReceipt({ hash: await w.writeContract({ address: usdc, abi: TOKEN_ABI, functionName: 'approve', args: [htlc, 10n ** 12n] }) })
    const a = artifacts.FeeOnTransferToken
    const d = createWalletClient({ chain: anvilChain, transport: http(node.rpcUrl), account: deployer })
    fee = (await pub().waitForTransactionReceipt({ hash: await d.deployContract({ abi: a.abi as Abi, bytecode: a.bytecode as Hex }) })).contractAddress!
    await pub().waitForTransactionReceipt({ hash: await d.writeContract({ address: fee, abi: a.abi as Abi, functionName: 'mint', args: [sender.address, 1_000_000n] }) })
    await pub().waitForTransactionReceipt({ hash: await w.writeContract({ address: fee, abi: a.abi as Abi, functionName: 'approve', args: [htlc, 10n ** 12n] }) })
    const e = artifacts.ReentrantToken
    evil = (await pub().waitForTransactionReceipt({ hash: await d.deployContract({ abi: e.abi as Abi, bytecode: e.bytecode as Hex }) })).contractAddress!
    for (const [fn, args] of [['mint', [sender.address, 1_000_000n]], ['arm', [htlc]]] as const) await pub().waitForTransactionReceipt({ hash: await d.writeContract({ address: evil, abi: e.abi as Abi, functionName: fn, args: args as any }) })
    await pub().waitForTransactionReceipt({ hash: await w.writeContract({ address: evil, abi: e.abi as Abi, functionName: 'approve', args: [htlc, 10n ** 12n] }) })
  }, 60_000)
  afterAll(async () => { await node?.stop() })

  it('a normal lock simulates fine (control)', async () => {
    await expect(lock(usdc, 1000n, (await now()) + 3600)).resolves.toBeDefined()
  })
  it('refuses a fee-on-transfer token (balance delta check)', async () => {
    await expect(lock(fee, 1000n, (await now()) + 3600)).rejects.toThrow(/token/)
  })
  it('refuses a 0 amount', async () => {
    await expect(lock(usdc, 0n, (await now()) + 3600)).rejects.toThrow(/amount/)
  })
  it('refuses a refundAfter that is not in the future', async () => {
    await expect(lock(usdc, 1000n, await now())).rejects.toThrow(/refundAfter/)
    await expect(lock(usdc, 1000n, (await now()) - 60)).rejects.toThrow(/refundAfter/)
  })
  it('refuses the 0 receiver', async () => {
    await expect(lock(usdc, 1000n, (await now()) + 3600, '0x0000000000000000000000000000000000000000')).rejects.toThrow(/receiver/)
  })
  it('refuses a token that calls back into the HTLC during transferFrom (reentrancy guard)', async () => {
    // The guard reverts the token's nested lock; the HTLC passes the token's revert reason through.
    // Without the guard the nested lock would succeed and the outer one fail its balance check ("token").
    await expect(lock(evil, 1000n, (await now()) + 3600)).rejects.toThrow(/reentrancy/)
  })
})
