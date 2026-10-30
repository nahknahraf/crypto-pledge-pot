/**
 * Offline demo: the real BitFund server on wallet-toolbox's mock chain, seeded
 * with campaigns in every state by real (mock-chain) wallets running the same
 * client code as the browser. Lets you browse the UI and API with no wallet
 * or funds. Browser wallet actions need `npm run server` (mainnet) instead,
 * because a real wallet's transactions do not exist on the mock chain.
 *
 *   npm run demo        # API on :8787, then `npm run app` → http://localhost:5174
 */
import { BitFund } from '../client/bitfund'
import { BitFundApi } from '../client/bitfundApi'
import { createMockChain, memoryKnex } from '../test/helpers/mockchain'
import { createBitFundApp } from './app'
import { BitFundDb } from './db'

const port = Number(process.env.PORT ?? 8787)
const DAY = 86_400

async function main (): Promise<void> {
  const chain = await createMockChain()
  const arbiter = await chain.makeWallet()
  const db = new BitFundDb(memoryKnex())
  await db.migrate()
  const realNow = (): number => Math.floor(Date.now() / 1000)
  let offset = 0 // seed campaigns "in the past" by shifting the server clock
  const app = createBitFundApp({ wallet: arbiter, db, chainTracker: chain.chainTracker, now: () => realNow() + offset })
  await new Promise<void>(resolve => { app.listen(port, () => resolve()) })
  const url = `http://localhost:${port}`

  const people = await Promise.all(Array.from({ length: 6 }, async () => await chain.makeWallet()))
  for (const w of people) await chain.fund(w, 5_000_000)
  const [ana, ben, chloe, dev, eli, fay] = people.map(w => new BitFund(w, new BitFundApi(url, w)))
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

  console.log(`BitFund demo API on ${url} (mock chain, seeded). Run \`npm run app\` and open http://localhost:5174`)
}

main().catch(e => { console.error(e); process.exit(1) })
