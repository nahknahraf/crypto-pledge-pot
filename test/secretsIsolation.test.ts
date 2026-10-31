/** Tests run without the owner's secrets: the loader is told to skip the real file (vitest.config.ts). */
import { expect, it } from 'vitest'
import { loadSecrets } from '../core/loadEnv'

it('the real secrets file is not loaded in tests', () => {
  expect(process.env.CPP_SECRETS_FILE).toBe('none')
  expect(loadSecrets()).toBeUndefined() // nothing read, whatever is in ~/.config/cryptopledgepot/secrets.env
})
