/**
 * Offline demo: the real CryptoPledgePot server on wallet-toolbox's mock chain, seeded
 * with campaigns in every state by real (mock-chain) wallets running the same
 * client code as the browser. Lets you browse the UI and API with no wallet
 * or funds. Browser wallet actions need `npm run server` (mainnet) instead,
 * because a real wallet's transactions do not exist on the mock chain.
 *
 *   npm run demo        # API on :8787, then `npm run app` → http://localhost:5174
 */
import { CryptoPledgePot } from '../client/cryptoPledgePot'
import { CryptoPledgePotApi } from '../client/cryptoPledgePotApi'
import { createMockChain, memoryKnex } from '../test/helpers/mockchain'
import { CryptoPledgePotAgent, type StepOutcome } from '../agent/agent'
import { MockBrain } from '../agent/brain'
import { createDataProviderApp, serveDataProvider } from '../agent/dataProvider'
import { createAgentApp } from '../agent/http'
import { Ledger, memoryStore, type AgentState, type SpendEntry } from '../agent/ledger'
import { createCappedPayer } from '../agent/pay402'
import { createCryptoPledgePotApp } from './app'
import { CryptoPledgePotDb } from './db'

const port = Number(process.env.PORT ?? 8787)
const DAY = 86_400

async function main (): Promise<void> {
  const chain = await createMockChain()
  const arbiter = await chain.makeWallet()
  const db = new CryptoPledgePotDb(memoryKnex())
  await db.migrate()
  const realNow = (): number => Math.floor(Date.now() / 1000)
  let offset = 0 // seed campaigns "in the past" by shifting the server clock
  const app = createCryptoPledgePotApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => realNow() + offset })
  await new Promise<void>(resolve => { app.listen(port, () => resolve()) })
  const url = `http://localhost:${port}`

  const people = await Promise.all(Array.from({ length: 6 }, async () => await chain.makeWallet()))
  for (const w of people) await chain.fund(w, 5_000_000)
  const [ana, ben, chloe, dev, eli, fay] = people.map(w => new CryptoPledgePot(w, new CryptoPledgePotApi(url, w)))
  const now = realNow()

  // 1. Active campaign, still raising.
  {
    const { meta } = await ana.launch({
      title: 'Open-source weather stations for Nairobi schools',
      description: 'We build solar-powered weather stations with students and publish all data openly.\n\nMilestone 1 buys sensors, milestone 2 installs 10 stations, milestone 3 funds the open data portal.',
      goal: 2_000_000,
      deadline: now + 12 * DAY,
      refundAfter: now + 90 * DAY,
      milestones: [{ title: 'Buy sensors and boards', percent: 30 }, { title: 'Install 10 stations', percent: 40 }, { title: 'Open data portal', percent: 30 }]
    })
    await ben.donate(meta, 250_000, { name: 'Ben', message: 'Love that the data is open!' })
    await chloe.donate(meta, 1_000, { name: 'Chloe', message: 'A tiny tip from a student 🙂' })
    await dev.donate(meta, 400_000, { name: 'Dev' })
    await eli.donate(meta, 120_000)
  }

  // 2. Funded, milestone 1 released, milestone 2 vote in progress.
  {
    offset = -20 * DAY
    const { campaignId, meta } = await ben.launch({
      title: 'Community repair café: tools and first year of rent',
      description: 'A place where neighbours fix things instead of throwing them away.',
      goal: 600_000,
      deadline: now - 10 * DAY,
      refundAfter: now + 60 * DAY,
      milestones: [{ title: 'Tools and workbenches', percent: 50 }, { title: 'Six months of rent', percent: 25 }, { title: 'Next six months', percent: 25 }]
    })
    await ana.donate(meta, 300_000, { name: 'Ana', message: 'See you at the first session.' })
    await fay.donate(meta, 250_000, { name: 'Fay' })
    await chloe.donate(meta, 100_000, { name: 'Chloe' })
    offset = 0
    await ben.release(campaignId)
    await ben.postUpdate(campaignId, 2, 'Workbenches are in and we held three sessions. 41 items repaired so far. Photos are in the café window.')
    await ana.vote(campaignId, 2, true)
    await chloe.vote(campaignId, 2, false)
  }

  // 3. Completed.
  {
    offset = -40 * DAY
    const { campaignId, meta } = await chloe.launch({
      title: 'Translate the BSV wallet guide into Spanish',
      description: 'A complete, reviewed translation, published under CC-BY.',
      goal: 150_000,
      deadline: now - 30 * DAY,
      refundAfter: now + 30 * DAY,
      milestones: [{ title: 'Translation', percent: 60 }, { title: 'Review and publish', percent: 40 }]
    })
    await dev.donate(meta, 100_000, { name: 'Dev', message: '¡Vamos!' })
    await eli.donate(meta, 60_000, { name: 'Eli' })
    offset = 0
    await chloe.release(campaignId)
    await chloe.postUpdate(campaignId, 2, 'Reviewed by two native speakers and published.')
    await dev.vote(campaignId, 2, true)
    await chloe.release(campaignId)
  }

  // 4. Missed its goal; one donor already took the early refund.
  {
    offset = -15 * DAY
    const { meta } = await dev.launch({
      title: 'Indie film: "Blocks of Time"',
      description: 'A short film about time-stamping a family archive on chain.',
      goal: 10_000_000,
      deadline: now - 5 * DAY,
      refundAfter: now + 40 * DAY,
      milestones: [{ title: 'Pre-production', percent: 20 }, { title: 'Shoot', percent: 50 }, { title: 'Post and festival entries', percent: 30 }]
    })
    const p = await fay.donate(meta, 50_000, { name: 'Fay', message: 'Good luck!' })
    await ana.donate(meta, 20_000)
    offset = 0
    await fay.refund(p.id, 'failed')
  }

  // 5. An AI agent service: funded, milestone 1 released and spent on paid API
  //    calls, its report posted; the backers' vote on milestone 2 is open.
  {
    const dataPort = Number(process.env.DATA_PORT ?? 8790)
    const agentPort = Number(process.env.AGENT_PORT ?? 8791)
    const providerWallet = await chain.makeWallet()
    const agentWallet = await chain.makeWallet()
    await chain.fund(agentWallet, 20_000)
    await serveDataProvider(createDataProviderApp(providerWallet, 50), dataPort)
    const dataHost = `localhost:${dataPort}`
    const ledger = new Ledger(memoryStore<SpendEntry[]>([]))
    const state = memoryStore<AgentState>({ worked: [] })
    const agentApi = new CryptoPledgePotApi(url, agentWallet)
    let last: StepOutcome | undefined
    const mission = 'Map urban air quality across European cities and publish open reports for anyone to use.'
    const agent = new CryptoPledgePotAgent({
      mission,
      campaign: {
        title: 'AirWatch: an AI agent buying open air-quality data',
        description: 'I am an autonomous AI agent. Back me and I will buy air-quality readings from a pay-per-call data API, one BSV micropayment per reading, and publish a report for each milestone with a link to every payment. You only fund the next milestone after you have seen my report.',
        goal: 40_000,
        deadline: now - DAY,
        refundAfter: now + 14 * DAY,
        milestones: [{ title: 'First readings: 5 cities', percent: 40 }, { title: 'Full coverage: 10 cities', percent: 60 }],
        kind: 'agent',
        agentUrl: `http://localhost:${agentPort}`
      },
      dataUrl: `http://${dataHost}`,
      pricePerCall: 50,
      maxSpendPerMilestone: 250,
      feeReserve: 1_000
    }, { wallet: agentWallet, cryptopledgepot: new CryptoPledgePot(agentWallet, agentApi), api: agentApi, brain: new MockBrain(), ledger, state, pay: createCappedPayer({ wallet: agentWallet, allowedHosts: [dataHost], maxPricePerCall: 50 }) })
    createAgentApp({ wallet: agentWallet, ledger, state, chainTracker: chain.chainTracker, mission, spendable: async () => await agent.spendable(), lastOutcome: () => last })
      .listen(agentPort)

    offset = -2 * DAY
    last = await agent.step() // launch
    const { meta } = await new CryptoPledgePotApi(url).campaign(state.load().campaignId!)
    await ana.donate(meta, 20_000, { name: 'Ana', message: 'Curious to see what an agent does with this.' })
    await eli.donate(meta, 15_000, { name: 'Eli' })
    await fay.donate(meta, 10_000, { name: 'Fay', message: 'Open data FTW' })
    offset = 0
    last = await agent.step() // release milestone 1
    last = await agent.step() // buy data, post report → vote on milestone 2 opens
    await fay.vote(state.load().campaignId!, 2, true)
  }

  console.log(`CryptoPledgePot demo API on ${url} (mock chain, seeded). Run \`npm run app\` and open http://localhost:5174`)
}

main().catch(e => { console.error(e); process.exit(1) })
