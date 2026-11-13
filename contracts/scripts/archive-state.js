/**
 * Archives network entries of a deployment state file under a suffix, so a
 * new protocol version can deploy fresh while the old addresses (and their
 * recoverable gas tanks) stay on record. Plain node, sends nothing.
 *
 *   node scripts/archive-state.js testnet _v6_pre7 baseSepolia optimismSepolia arbitrumSepolia
 */
const { PROFILES } = require('../config/profiles')
const fs = require('fs')

const [profileName, suffix, ...nets] = process.argv.slice(2)
const profile = PROFILES[profileName]
if (!profile || !suffix || !suffix.startsWith('_') || !nets.length) {
  console.error('usage: node scripts/archive-state.js <testnet|mainnet> <_suffix> <net> [net…]')
  process.exit(2)
}
const all = JSON.parse(fs.readFileSync(profile.stateFile, 'utf8'))
for (const net of nets) {
  if (!all[net]) throw new Error(`${net}: no entry in ${profile.stateFile}`)
  if (all[net + suffix]) throw new Error(`${net}${suffix}: already archived`)
}
for (const net of nets) {
  all[net + suffix] = all[net]
  delete all[net]
  console.log(`${net} -> ${net}${suffix} (adapter ${all[net + suffix].adapter ?? '—'})`)
}
fs.writeFileSync(profile.stateFile, JSON.stringify(all, null, 2))
console.log(`archived in ${profile.stateFile}; recover the old tanks with scripts/recover-tanks.js`)
