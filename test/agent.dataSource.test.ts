/** Real data for the agent: Open-Meteo readings, honest labels, honest fallback. (Offline: fetch is injected.) */
import { describe, expect, it } from 'vitest'
import { liveReading, syntheticReading } from '../data-provider/dataProvider'
import { sourceNote } from '../fundraising-agent/brain'

const openMeteo = (current: Record<string, unknown>): typeof fetch => (async () => new Response(JSON.stringify({ current }), { status: 200 })) as unknown as typeof fetch

describe('agent data source', () => {
  it('parses a live Open-Meteo reading and labels it', async () => {
    const r = await liveReading('munich', openMeteo({ time: '2026-10-30T18:00', pm10: 17.6, pm2_5: 12.9, nitrogen_dioxide: 28.0, european_aqi: 42 }))
    expect(r).toEqual({ city: 'munich', date: '2026-10-30', pm25: 13, pm10: 18, no2: 28, aqi: 42, synthetic: false, source: 'Open-Meteo (CAMS)', observedAt: '2026-10-30T18:00' })
  })
  it('refuses an incomplete or failed answer (the provider then falls back, labelled synthetic)', async () => {
    await expect(liveReading('rome', openMeteo({ time: 'x', pm10: null }))).rejects.toThrow(/incomplete/)
    await expect(liveReading('rome', (async () => new Response('', { status: 503 })) as unknown as typeof fetch)).rejects.toThrow(/503/)
    expect(syntheticReading('rome')).toMatchObject({ synthetic: true, source: 'synthetic' })
  })
  it('reports say where the numbers came from', () => {
    const live = { city: 'munich' as const, date: 'd', pm25: 1, pm10: 1, no2: 1, aqi: 1, synthetic: false, source: 'Open-Meteo (CAMS)' }
    expect(sourceNote([live])).toBe('Readings from Open-Meteo (CAMS).')
    expect(sourceNote([syntheticReading('rome')])).toBe('Readings are synthetic demo data.')
    expect(sourceNote([live, syntheticReading('rome')])).toMatch(/some synthetic/)
  })
})
