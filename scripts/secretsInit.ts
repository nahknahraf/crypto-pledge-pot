/**
 * npm run secrets:init: create the secrets file (see core/loadEnv.ts and docs/KEYS.md) with every key the
 * project reads, empty, readable only by you; on an existing file, add the keys it lacks. Never prints values.
 */
import { ensureSecretsFile, filledKeys, secretsFile } from './secretsFile'

const file = secretsFile()
const { created, added } = ensureSecretsFile(file)
if (created) console.log(`created ${file} (mode 600). See docs/KEYS.md for what goes in it.`)
else console.log(`${file} exists.${added.length > 0 ? ` Added empty slots: ${added.join(', ')}.` : ''} Keys with a value: ${filledKeys(file).join(', ') || 'none'}`)
