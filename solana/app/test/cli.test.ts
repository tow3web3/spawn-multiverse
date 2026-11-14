/**
 * The rehearsal command line (scripts/cli.ts) against the local world: the
 * same code path as on devnet, its RPC and its sender swapped for LiteSVM.
 * Dry run by default — nothing may leave unless `--send` is given.
 */
import { expect } from 'chai'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import { CHAIN_LABEL, GatewayClient, decodeNonce, governIx, lzPda, splToE18, toBytes32 } from '../src'
import { CliIo, chainLabel, parseArgs, runCli } from '../../scripts/cli'
import { World } from './harness'
import { HUB_ADAPTER, HUB_EID, HUB_PAD, ONE, wiredWorld } from './fixtures'

const TOK = '0x' + '8b'.repeat(20)
const LEFT_OUT = '0x' + '3c'.repeat(20)
const E18 = 10n ** 18n

describe('the rehearsal command line', function () {
  let w: World
  let user: Keypair
  let client: GatewayClient
  let nonceIn = 0n
  const outbound = () => decodeNonce(w.account(lzPda.nonce(w.pdas.store, HUB_EID, HUB_ADAPTER))!.data).outbound
  const execute = (msg: Parameters<World['execute']>[4]) => w.execute(HUB_EID, HUB_PAD, HUB_ADAPTER, ++nonceIn, msg)

  /** Runs the CLI as `user` (the keypair "file" is the test's key). */
  async function cli(args: string, o: { canSend?: boolean } = {}): Promise<string> {
    const lines: string[] = []
    const io: CliIo = {
      rpc: w.rpc(),
      out: (l) => lines.push(l),
      loadKeypair: () => user,
      send:
        o.canSend === false
          ? undefined
          : async (tx: VersionedTransaction, signer: Keypair) => {
              const sent = w.sendTx(tx, [signer])
              return { signature: 'local', logs: sent.logs }
            },
    }
    await runCli(['--cluster', 'localnet', ...args.split(' ').filter(Boolean)], io)
    return lines.join('\n')
  }
  const fails = async (args: string): Promise<string> => {
    try {
      await cli(args)
    } catch (e) {
      return String(e)
    }
    throw new Error(`"${args}" should have been refused`)
  }

  before(async () => {
    let admin: Keypair
    ;({ w, admin } = await wiredWorld())
    w.send(admin, [governIx.unpause(w.pdas, admin.publicKey)])
    w.enlistExecutor()
    await execute({ op: 'SYNC_TOKEN', hubToken: toBytes32(TOK), name: 'CANARY', symbol: 'CANARY' })
    user = w.newUser()
    w.giveUsdc(user.publicKey, 1_000n * ONE)
    client = await GatewayClient.load(w.rpc())
  })

  it('parses its arguments', () => {
    const { command, opt } = parseArgs(['buy', '--token', TOK, '--usdc', '5', '--send'])
    expect([command, opt.get('usdc'), opt.has('send')]).to.deep.equal(['buy', '5', true])
    expect(() => parseArgs(['buy', '--token'])).to.throw(/needs a value/)
    expect(() => parseArgs(['buy', 'sell'])).to.throw(/unexpected argument/)
    expect([chainLabel('bnb'), chainLabel('Ethereum'), chainLabel('6')]).to.deep.equal([CHAIN_LABEL.bnb, CHAIN_LABEL.ethereum, 6])
    expect(() => chainLabel('mars')).to.throw(/unknown chain/)
  })

  it('status: the store, its prices, the vault, the tank, every route and peer', async () => {
    const out = await cli('status')
    expect(out).to.match(/state\s+open/)
    expect(out).to.match(/legs: trade 1, spawn 3, open 1/)
    expect(out).to.match(/→ bnb\s+move: 6 legs;\s+CCTP peer: n\/a/)
    expect(out).to.match(/→ base\s+move: 1 legs;\s+CCTP peer: 0x0{24}c3c3/)
    expect(out).to.match(/→ optimism\s+move: closed;\s+CCTP peer: none/)
    expect(out).to.match(/lookup table .* frozen/)
    expect(out).to.match(/buy \/ sell \/ claim \/ pull\s+0\.\d+ SOL/)
    expect(out).to.match(/move → ethereum\s+0\.\d+ SOL\s+\(40 legs/)
    expect(out).to.match(/move → optimism\s+closed/)
  })

  it('DRY RUN by default: a buy is built, quoted and simulated — and nothing leaves', async () => {
    const n0 = outbound()
    const out = await cli(`buy --token ${TOK} --usdc 250 --min-tokens 900000 --keypair k.json`)
    expect(out).to.match(/buy 0x8b8b.* with 250 USDC/)
    expect(out).to.match(/minimum\s+900000 tokens/)
    expect(out).to.match(/fee\s+0\.\d+ SOL quoted, ceiling 0\.\d+ SOL/)
    expect(out).to.match(/reply budget 1 leg × 0\.0002 ETH = 0\.0002 ETH/)
    expect(out).to.match(/simulation: ok, \d+ compute units/)
    expect(out).to.match(/DRY RUN — nothing was sent/)
    expect(outbound()).to.equal(n0)
    expect(await client.vaultBalance()).to.equal(0n)
    // a dry run needs no key at all: --owner is enough
    expect(await cli(`buy --token ${TOK} --usdc 1 --min-tokens any --owner ${user.publicKey.toBase58()}`)).to.match(/DRY RUN/)
    // …and it shows a transaction that would fail, with the program's reason
    expect(await cli(`sell --token ${TOK} --tokens 5 --min-usdc any --keypair k.json`)).to.match(/simulation: FAILS/)
  })

  it('refuses to send without a key, a minimum, or (on mainnet) the explicit flag', async () => {
    expect(await fails(`buy --token ${TOK} --usdc 1 --min-tokens any --owner ${user.publicKey.toBase58()} --send`)).to.match(/--send needs --keypair/)
    expect(await fails(`buy --token ${TOK} --usdc 1 --keypair k.json`)).to.match(/--min-tokens is required/)
    expect(await fails(`buy --token ${TOK} --usdc 1 --min-tokens 0 --keypair k.json`)).to.match(/ZeroMinimum/)
    expect(await fails(`buy --token 0x1234 --usdc 1 --min-tokens any --keypair k.json`)).to.match(/20 or 32 bytes|hub address/)
    let err = ''
    await runCli(['buy', '--cluster', 'mainnet-beta', '--token', TOK, '--usdc', '1', '--min-tokens', 'any', '--keypair', 'k.json', '--send'], {
      rpc: w.rpc(),
      out: () => {},
      loadKeypair: () => user,
    }).catch((e) => (err = String(e)))
    expect(err).to.match(/--confirm-mainnet/)
    expect(await fails('frobnicate')).to.match(/unknown command/)
  })

  it('--send: buy, the hub delivers, sell, claim-fees, pull-fees, spawn', async () => {
    let out = await cli(`buy --token ${TOK} --usdc 250 --min-tokens 900000 --keypair k.json --send`)
    expect(out).to.match(/sent: local/)
    expect(out).to.match(/LayerZero charged 0\.\d+ SOL; 1 reply prepaid/)
    expect(await client.vaultBalance()).to.equal(250n * ONE)
    await execute({ op: 'DELIVER', hubToken: toBytes32(TOK), to: user.publicKey.toBytes(), tokens: 1_000_000n * E18, refund: 0n })
    out = await cli(`sell --token ${TOK} --tokens 400000 --min-usdc 87.5 --keypair k.json --send`)
    expect(out).to.match(/minimum\s+87\.5 USDC net/)
    expect(await client.tokenBalance(user.publicKey, w.pdas.mint(toBytes32(TOK)))).to.equal(600_000n * ONE)
    const n0 = outbound()
    await cli(`claim-fees --token ${TOK} --keypair k.json --send`)
    await cli(`pull-fees --token ${TOK} --keypair k.json --send`)
    out = await cli('spawn --name REHEARSAL --symbol RHS --dev-buy 50 --fee-mode 1 --keypair k.json --send')
    expect(out).to.match(/4 replies prepaid/)
    expect(outbound()).to.equal(n0 + 3n)
  })

  it('open: a token that is not on this chain; the rent is announced and paid', async () => {
    let out = await cli(`open --token ${LEFT_OUT} --keypair k.json`)
    expect(out).to.match(/rent\s+0\.00\d+ SOL left at the replica/)
    expect(out).to.match(/DRY RUN/)
    out = await cli(`pending --token ${LEFT_OUT} --keypair k.json`)
    expect(out).to.match(/not open on this chain:  cli open --token 0x3c3c/)
    await cli(`open --token ${LEFT_OUT} --keypair k.json --send`)
    expect(await client.openRent(toBytes32(LEFT_OUT))).to.equal(0n)
    await execute({ op: 'SYNC_TOKEN', hubToken: toBytes32(LEFT_OUT), name: 'LEFT OUT', symbol: 'OUT' })
    expect(await fails(`open --token ${LEFT_OUT} --keypair k.json`)).to.match(/already open/)
  })

  it('balances and pending: a claim, a parked bag — and the command that collects each', async () => {
    // the vault (300) cannot pay a 500-dollar sale: a claim; a bag for a token account that does not exist: parked
    expect(await client.vaultBalance()).to.equal(300n * ONE)
    await execute({ op: 'PAYOUT', to: user.publicKey.toBytes(), usdOut: splToE18(500n * ONE) })
    await execute({ op: 'DELIVER', hubToken: toBytes32(LEFT_OUT), to: user.publicKey.toBytes(), tokens: 12_345n * E18, refund: 0n })
    let out = await cli(`balances --token ${TOK} --keypair k.json`)
    expect(out).to.match(/USDC\s+700 USDC/)
    expect(out).to.match(/claim\s+500 USDC — the vault holds 300 USDC: redeem that much, wait, or move it/)
    expect(out).to.match(/CANARY: 600000 held, 0 staked/)
    expect(out).to.match(/12345 OUT parked:  cli claim-parked --token 0x3c3c/)
    out = await cli('pending --keypair k.json')
    expect(out).to.match(/claim\s+500 USDC/)
    expect(out).to.match(/12345 OUT parked/)
    await cli(`claim-parked --token ${LEFT_OUT} --keypair k.json --send`)
    expect(await client.tokenBalance(user.publicKey, w.pdas.mint(toBytes32(LEFT_OUT)))).to.equal(12_345n * ONE)
    // someone with nothing waiting
    const idle = Keypair.generate().publicKey.toBase58()
    expect(await cli(`pending --owner ${idle}`)).to.match(/nothing is waiting/)
  })

  it('move: part of the claim leaves for BNB; a closed route and too large a move are refused; redeem takes what the vault holds', async () => {
    let out = await cli('move --to-chain bnb --to 0x' + 'd0'.repeat(20) + ' --usdc 100 --keypair k.json')
    expect(out).to.match(/move 100 USDC of claim to chain 4 \(bnb\)/)
    expect(out).to.match(/reply budget 6 legs × 0\.0002 ETH = 0\.0012 ETH/)
    expect(out).to.match(/DRY RUN/)
    expect((await client.userAccount(user.publicKey))!.usdClaim).to.equal(500n * ONE)
    out = await cli('move --to-chain bnb --to 0x' + 'd0'.repeat(20) + ' --usdc 100 --keypair k.json --send')
    expect(out).to.match(/6 replies prepaid/)
    expect((await client.userAccount(user.publicKey))!.usdClaim).to.equal(400n * ONE)
    expect(await fails('move --to-chain optimism --to 0x' + 'd0'.repeat(20) + ' --usdc 1 --keypair k.json')).to.match(/route is closed/)
    expect(await fails('move --to-chain solana --to 0x' + 'd0'.repeat(20) + ' --usdc 1 --keypair k.json')).to.match(/BadDestination/)
    expect(await cli('move --to-chain base --to 0x' + 'd0'.repeat(20) + ' --usdc 401 --keypair k.json')).to.match(/NOT ENOUGH[\s\S]*simulation: FAILS/)
    // the vault holds 300: that much redeems, more does not (yet)
    expect(await cli('redeem --usdc 400 --keypair k.json')).to.match(/simulation: FAILS[\s\S]*VaultShort/)
    out = await cli('redeem --usdc 300 --keypair k.json --send')
    expect(out).to.match(/sent: local/)
    expect((await client.userAccount(user.publicKey))!.usdClaim).to.equal(100n * ONE)
    expect(await cli('pending --keypair k.json')).to.match(/claim\s+100 USDC — the vault holds 0 USDC/)
  })
})
