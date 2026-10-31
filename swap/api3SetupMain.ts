/**
 * npm run api3:setup: get the team's Base Sepolia TESTNET key ready for the
 * API3 deployment and tamper test, with only Base Sepolia ETH from a faucet.
 *
 *  - Creates data/api3-team.key if it does not exist (git-ignored) and prints
 *    its address: send Base Sepolia ETH there.
 *  - Prints the balances: ETH, aUSD, and the token the deployment locks.
 *  - With ETH: mints aUSD from API3's faucet contract (mintFromFaucet, up to
 *    its limit), which pays for AirnodeHub calls over x402.
 *  - With a deployment that has its own TestUSDC (API3_TEST_TOKEN=1 at
 *    deploy), mints test USDC for the tamper test's real lock.
 *
 * Testnet only: the key never holds anything of value.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, parseAbi, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { readDeployment } from './api3Proof'
import { TOKEN_ABI } from './evmChain'

const KEY_FILE = path.join('data', 'api3-team.key')
const AUSD = '0xbeA34973e5f67F18F656A2C6070C64326C791808'
const AUSD_ABI = parseAbi(['function mintFromFaucet(uint256 amount)', 'function faucetLimit() view returns (uint256)', 'function faucetMintedAmount(address account) view returns (uint256)'])
const RPC = process.env.API3_RPC_URL ?? 'https://sepolia.base.org'

if (!fs.existsSync(KEY_FILE)) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true })
  fs.writeFileSync(KEY_FILE, generatePrivateKey(), { mode: 0o600 })
  console.log(`created ${KEY_FILE} (Base Sepolia testnet key, git-ignored)`)
}
const account = privateKeyToAccount(fs.readFileSync(KEY_FILE, 'utf8').trim() as Hex)
const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) })
const d = readDeployment()
const balanceOf = async (token: Hex): Promise<bigint> => await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })

console.log(`team address ${account.address} (Base Sepolia)`)
const eth = await client.getBalance({ address: account.address })
let ausd = await balanceOf(AUSD)
console.log(`  ETH   ${formatEther(eth)}`)
console.log(`  aUSD  ${Number(ausd) / 1e6}`)
if (d !== undefined) console.log(`  ${d.testToken === true ? 'TestUSDC' : 'USDC'}  ${Number(await balanceOf(d.token)) / 1e6} (the token the deployment locks, ${d.token})`)

if (eth === 0n) {
  console.log('\nNo ETH yet: send Base Sepolia ETH to the address above (e.g. https://portal.cdp.coinbase.com/products/faucet or https://www.alchemy.com/faucets/base-sepolia), then run this again.')
  process.exit(0)
}

if (ausd < 100_000n) {
  const limit = await client.readContract({ address: AUSD, abi: AUSD_ABI, functionName: 'faucetLimit' })
  const minted = await client.readContract({ address: AUSD, abi: AUSD_ABI, functionName: 'faucetMintedAmount', args: [account.address] })
  const amount = limit > minted ? limit - minted : 0n
  if (amount === 0n) console.log('\naUSD faucet limit reached for this address')
  else {
    const hash = await wallet.writeContract({ address: AUSD, abi: AUSD_ABI, functionName: 'mintFromFaucet', args: [amount] })
    await client.waitForTransactionReceipt({ hash })
    ausd = await balanceOf(AUSD)
    console.log(`\nminted ${Number(amount) / 1e6} aUSD (tx https://sepolia.basescan.org/tx/${hash}); now ${Number(ausd) / 1e6} aUSD`)
  }
}

if (d?.testToken === true && await balanceOf(d.token) < 10_000_000n) {
  const hash = await wallet.writeContract({ address: d.token, abi: TOKEN_ABI, functionName: 'mint', args: [account.address, 100_000_000n] })
  await client.waitForTransactionReceipt({ hash })
  console.log(`minted 100 TestUSDC for the tamper test's lock (tx https://sepolia.basescan.org/tx/${hash})`)
}

console.log(d === undefined
  ? '\nNext: API3_TEST_TOKEN=1 BRIDGE_PRICE_GUARD=api3 BRIDGE_RPC_URL=https://sepolia.base.org BRIDGE_DEPLOYER_KEY=$(cat data/api3-team.key) npm run evm:deploy, then npm run api3:setup again'
  : '\nNext: npm run evm:verify, then npm run api3:judge -- --send-rejections (twice, 5 minutes apart)')
