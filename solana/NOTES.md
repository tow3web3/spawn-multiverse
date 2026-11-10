# Solana leg — phase 1 notes

Phase 1 ships the toolchain, a deployable `spawn_gateway` Anchor skeleton
(config PDA + ping event, LiteSVM-tested) and this integration dossier.
Phase 2 turns the skeleton into a real LayerZero OApp wired to our Base
Sepolia hub.

## Toolchain that works on this machine

| Tool | Version |
|---|---|
| rustc / cargo | 1.95.0 |
| solana-cli (Agave) | 3.1.15 |
| anchor-cli (via avm) | 1.0.2 |
| anchor-lang crate | 1.0.2 (program), litesvm 0.10.0 (tests) |

Deploy wallet: `solana/.keys/devnet.json` (gitignored), address
`EzXiHeBppPFfLsWXQrQuSJKexPq8T3xKpizfTJ3EUEt`. Program keypair:
`solana/target/deploy/spawn_gateway-keypair.json` (regenerate anywhere with
`anchor build`; re-run `anchor keys sync` after).

## Phase-1 status

- Program id **`3mypQvfiLtRHQhWStYyQ6cUu6YC4hqUFBXcNNme3H95g`**.
- LiteSVM test green (`cargo test --test test_initialize`): initialize
  stores admin + hub config, ping advances the counter, state verified.
- **Deployed + smoked on localnet** (`anchor deploy` + `RPC=http://127.0.0.1:8899
  node app/smoke.cjs` → initialize ✓, ping ✓, `Pinged` event decoded from
  the tx logs, `SMOKE_OK`). The devnet faucet refused every airdrop
  (IP rate limit) during phase 1, so devnet deploy is pending fuel: once
  `solana airdrop 2 EzXiHeBppPFfLsWXQrQuSJKexPq8T3xKpizfTJ3EUEt -u devnet`
  succeeds (needs ~2.1 SOL total for the 147KB program), run
  `anchor deploy --provider.cluster devnet --provider.wallet .keys/devnet.json`
  then `RPC=https://api.devnet.solana.com node app/smoke.cjs`.

## LayerZero V2 on Solana — the facts (verified)

- **EndpointV2 program id — `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6`**,
  the SAME address on mainnet and devnet. Pulled from the authoritative
  [LayerZero metadata API](https://metadata.layerzero-api.com/v1/metadata)
  and confirmed executable on devnet with `solana account`. Executor:
  `6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn`.
- **eids**: Solana mainnet **30168**, Solana devnet (LayerZero calls it
  "solana-testnet") **40168**. Our hub Base Sepolia is **40245**; OP Sepolia
  40232, Arb Sepolia 40231, Ethereum Sepolia 40161, BSC testnet 40102.
  So the pairing is: `spawn_gateway` (eid 40168) ⇄ hub adapter on Base
  Sepolia (eid 40245).
- **OApp programming model** ([Solana OApp reference](https://docs.layerzero.network/v2/developers/solana/oapp/overview)):
  one crate, `oapp`, vendored from
  [LayerZero-Labs/devtools](https://github.com/LayerZero-Labs/devtools)
  (example: `examples/oapp-solana`; scaffold:
  `LZ_ENABLE_SOLANA_OAPP_EXAMPLE=1 npx create-lz-oapp@latest`).
  - **Register** (one-time, in init): `oapp::endpoint_cpi::register_oapp`
    with the Store PDA as the OApp address and a `delegate` for config.
  - **Send**: `oapp::endpoint_cpi` send path (see `examples/oft-solana` for
    the full outbound flow + `msg_codec.rs` for byte-exact codecs).
  - **Receive**: executor calls our `lz_receive`; FIRST
    `oapp::endpoint_cpi::clear` (burns the nonce — replay protection),
    THEN touch state. `lz_receive_types` /
    `lz_receive_types_v2` instructions must exist so the executor can
    resolve the account list (Solana has no dynamic account access — this
    is the big mental shift from EVM).
  - **Peers**: a Peer PDA per remote eid stores the 32-byte remote address
    (same bytes32 convention as our EVM adapters).

## Venue programs for the future curve adapter (devnet)

- **Meteora Dynamic Bonding Curve** — `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`,
  listed for mainnet AND devnet, confirmed present on devnet on-chain. SDK:
  `@meteora-ag/dynamic-bonding-curve-sdk`.
- **Raydium LaunchLab** — devnet candidate
  `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6` (a real devnet program,
  "DRay" vanity matches Raydium's devnet convention, but NOT yet confirmed
  as LaunchLab — confirm against the
  [Raydium SDK program-addresses table](https://docs.raydium.io/raydium/build/ts-sdk-demo)
  before building on it). SDK: `@raydium-io/raydium-sdk-v2` (LaunchLab IDL
  bundled under `src/raydium/launchpad/`).
- Meteora's manual migrator works on devnet too — useful to rehearse the
  curve→AMM ascension on Solana rails.

## Phase 2 plan — spawn_gateway as a real OApp

1. **Vendor the `oapp` crate** (git dependency on LayerZero-Labs/devtools,
   pinned rev) and refit `Config` into their Store-PDA pattern; add a Peer
   PDA for eid 40245 holding the hub adapter's bytes32 address.
2. **Register**: extend `initialize` to CPI `register_oapp` (delegate =
   admin). Fund the gateway's fee payer (the LZ fee is paid in SOL at send
   time — Solana's version of our EVM "gas tank" is simply the payer
   account in the send accounts).
3. **Codec parity**: port the EVM payload codec byte-for-byte
   (`abi.encode(op, abi.encode(...))` on the EVM side) into a
   `msg_codec.rs`; cross-test vectors generated from the hardhat world so
   both sides agree on every op (OP_SPAWN … OP_FEE_DROP = 13).
4. **EVM side**: on the Base Sepolia hub adapter, `setRoute(1, 40168,
   <spawn_gateway store PDA as bytes32>)` — label 1 is already reserved for
   Solana in lib-deploy's CHAINS.
5. **Receive path**: implement `lz_receive` (clear first) for OP_SYNC_TOKEN
   (create SPL mint replica + metadata, mint authority = gateway PDA),
   OP_DELIVER (mint to buyer ATA), OP_PAYOUT (oUSD-equivalent: devnet USDC
   or a mock SPL), OP_FEE_DROP (phase 3 with a Solana FeeDistributor).
6. **Send path**: `spawn`/`buy`/`sell`/`claim` instructions that take SPL
   payment, then CPI the endpoint send with the executor options (our EVM
   side already runs 4M-gas type-3 options; Solana→EVM options name EVM gas,
   so reuse 4_000_000).
7. **Smoke**: devnet → Base Sepolia spawn + $5 buy mirroring
   `contracts/scripts/testnet-smoke.js`, watched on LayerZero Scan testnet.

**Risk points, honest sizing**
- The `lz_receive_types` account-resolution dance is the hardest part
  (dynamic account lists for "create replica" flows); budget real days.
- `oapp` crate ↔ Anchor 1.0.2 version fit is unverified — the examples may
  pin an older Anchor; a version downgrade of our program (or vendoring
  with patches) is plausible.
- Executor-driven replica creation (OP_SYNC_TOKEN) needs rent funding on
  receive — decide who pays (gateway-owned payer PDA topped up like our EVM
  tanks).
- Devnet airdrops are heavily rate-limited; keep the deploy key funded.

## Sources

- [LayerZero metadata API](https://metadata.layerzero-api.com/v1/metadata) (endpoint ids, eids)
- [Solana OApp reference](https://docs.layerzero.network/v2/developers/solana/oapp/overview)
- [LayerZero devtools (examples)](https://docs.layerzero.network/v2/tools/devtools) · [GitHub](https://github.com/LayerZero-Labs/devtools)
- [Solana SDK](https://docs.layerzero.network/v2/tools/sdks/solana-sdk)
- [Raydium LaunchLab docs](https://docs.raydium.io/products/launchlab) · [code demos](https://docs.raydium.io/products/launchlab/code-demos)
- [Meteora DBC SDK / addresses](https://skills.sh/sendaifun/skills/meteora)
