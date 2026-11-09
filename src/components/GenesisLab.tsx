import { useEffect, useState } from 'react'
import { useStore, GLOBAL_SUPPLY, START_PRICE, type CreatureLinks, type FeeMode } from '../store'
import { CHAINS } from '../lib/chains'
import { randomChain } from '../engine/market'
import { fmtNum, fmtPrice } from '../lib/format'
import { cleanLinks, LINK_META } from '../lib/links'
import { Sparkle } from './bits'

const PREVIEW_BG = '#9ccbf5'

/** Center-crop to a square, downscale, and return a compact data URL. */
async function processImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('unreadable image'))
      img.src = url
    })
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    const s = Math.min(img.width, img.height)
    ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
    return canvas.toDataURL('image/webp', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function GenesisLab({
  onClose,
  onSpawned,
}: {
  onClose: () => void
  onSpawned: (num: number) => void
}) {
  const { spawn, trade, connect, onchain } = useStore()
  const liveChains = onchain?.chains ? CHAINS.filter((c) => onchain.chains!.includes(c.id)) : CHAINS
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [imageError, setImageError] = useState(false)
  const [links, setLinks] = useState<CreatureLinks>({})
  const [feeMode, setFeeMode] = useState<FeeMode>('holders')
  const [devBuyStr, setDevBuyStr] = useState('')
  const [busy, setBusy] = useState(false)
  const [spawnErr, setSpawnErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const previewName = (name.trim() || 'TURBO PICKLE').toUpperCase()
  const previewTicker = (ticker.trim() || 'PICKL').toUpperCase()
  const ready = name.trim().length > 0 && ticker.trim().length > 0 && image !== null

  const onFile = async (file: File | undefined | null) => {
    if (!file) return
    try {
      setImage(await processImage(file))
      setImageError(false)
    } catch {
      setImageError(true)
    }
  }

  const submit = async () => {
    if (!ready || !image || busy) return
    setBusy(true)
    setSpawnErr(null)
    try {
      const c = await spawn({
        name: name.trim(),
        ticker: ticker.trim(),
        image,
        links: cleanLinks(links),
        feeMode,
      })
      const devBuy = Number.parseFloat(devBuyStr) || 0
      if (devBuy > 0) {
        const w = await connect()
        await trade(c.num, 'buy', Math.min(devBuy, w.balance), randomChain())
      }
      onClose()
      onSpawned(c.num)
    } catch {
      setSpawnErr('SPAWN FAILED — IS THE LOCAL CHAIN RUNNING? CHECK THE NODE AND TRY AGAIN.')
    } finally {
      setBusy(false)
    }
  }

  const label = 'font-mono text-[10px] font-bold tracking-[0.15em] text-white/60'
  const input =
    'mt-2 w-full rounded-xl border-3 border-white/20 bg-void px-4 py-3 font-mono text-[13px] font-bold tracking-wide text-white outline-none transition placeholder:text-white/25 focus:border-lime'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-5xl animate-pop overflow-hidden rounded-3xl border-3 border-ink shadow-[12px_12px_0_0_#a78bf0]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Genesis Lab"
      >
        {/* header */}
        <div className="relative border-b-3 border-ink bg-lime px-6 py-5 sm:px-8">
          <p className="font-mono text-[10px] font-bold tracking-[0.2em]">
            ✳ GENESIS LAB / CREATE YOUR OWN CREATURE
          </p>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="font-display text-[clamp(1.8rem,4vw,3rem)] leading-tight tracking-wide">
              BUILD A LITTLE MENACE.
            </h2>
            <p className="pb-1 text-right font-mono text-[10px] font-bold tracking-wide opacity-70">
              STEP 01 / 01
              <br />6 CHAINS = 1 LAUNCH
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute -right-0 -top-0 m-3 flex h-10 w-10 items-center justify-center rounded-xl border-3 border-ink bg-white font-bold shadow-brutal-sm transition hover:rotate-90"
          >
            ✕
          </button>
        </div>

        <div className="grid bg-panel lg:grid-cols-[1.15fr_1fr]">
          {/* form */}
          <div className="p-6 sm:p-8">
            <p className={label}>01 — GIVE IT A PERSONALITY</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-[1.6fr_1fr]">
              <div>
                <label className={label} htmlFor="meme-name">
                  MEME NAME
                </label>
                <input
                  id="meme-name"
                  className={input}
                  placeholder="Turbo Pickle"
                  maxLength={24}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className={label} htmlFor="meme-ticker">
                  STICKER
                </label>
                <input
                  id="meme-ticker"
                  className={input}
                  placeholder="PICKL"
                  maxLength={6}
                  value={ticker}
                  onChange={(e) =>
                    setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                  }
                />
              </div>
            </div>

            <p className={`${label} mt-7`}>02 — GIVE IT A FACE</p>
            <label
              className="mt-3 flex cursor-pointer items-center gap-4 rounded-xl border-3 border-dashed border-white/25 bg-void p-4 transition hover:border-lime"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                void onFile(e.dataTransfer.files?.[0])
              }}
            >
              {image ? (
                <img
                  src={image}
                  alt="Token face preview"
                  className="h-20 w-20 shrink-0 rounded-full border-3 border-ink bg-white object-cover"
                />
              ) : (
                <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-3 border-dashed border-white/25 font-display text-3xl text-white/30">
                  ?
                </span>
              )}
              <span className="min-w-0">
                <span className="block font-mono text-[12px] font-bold tracking-wide text-white">
                  {image ? 'FACE LOCKED IN — CLICK TO SWAP' : 'UPLOAD AN IMAGE (PNG / JPG / WEBP)'}
                </span>
                <span className="mt-1 block font-mono text-[10px] leading-relaxed text-white/40">
                  Click or drop it here. Square works best — this face follows your token onto
                  all six chains.
                </span>
                {imageError && (
                  <span className="mt-1 block font-mono text-[10px] font-bold text-down">
                    COULDN'T READ THAT IMAGE — TRY ANOTHER ONE.
                  </span>
                )}
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  void onFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>

            <p className={`${label} mt-7`}>03 — DROP ITS LINKS (OPTIONAL)</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {LINK_META.map(({ kind, label: linkLabel, placeholder }) => (
                <div key={kind}>
                  <label className={label} htmlFor={`link-${kind}`}>
                    {linkLabel}
                  </label>
                  <input
                    id={`link-${kind}`}
                    className={input}
                    placeholder={placeholder}
                    maxLength={120}
                    value={links[kind] ?? ''}
                    onChange={(e) => setLinks((l) => ({ ...l, [kind]: e.target.value }))}
                  />
                </div>
              ))}
            </div>

            <p className={`${label} mt-7`}>04 — ONE GLOBAL SUPPLY (PREDEFINED)</p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border-3 border-white/20 bg-void px-4 py-3">
              <span className="font-mono text-[13px] font-bold tracking-wide text-white">
                {fmtNum(GLOBAL_SUPPLY)} TOKENS
              </span>
              <span className="rounded-md border-2 border-lime/60 px-2 py-1 font-mono text-[9px] font-bold tracking-wide text-lime">
                🔒 FIXED FOR EVERY CREATURE
              </span>
            </div>
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/40">
              Same supply for everyone, allocated across all native deployments — not one full
              supply per chain. No supply games.
            </p>

            <p className={`${label} mt-7`}>05 — ALL CHAINS SPAWN TOGETHER</p>
            <div className="mt-3 flex items-center justify-between rounded-xl border-3 border-white/20 bg-void px-4 py-3">
              <div className="flex gap-1.5">
                {liveChains.map((ch) => (
                  <span
                    key={ch.id}
                    title={ch.label}
                    className="flex h-7 min-w-7 items-center justify-center rounded-md border-2 border-ink bg-lime px-1 font-mono text-[10px] font-bold text-ink"
                  >
                    {ch.short}
                  </span>
                ))}
              </div>
              <span className="font-mono text-[11px] font-bold text-lime">
                {liveChains.length} / 6 ACTIVATED ✓
              </span>
            </div>
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/40">
              💡 You pay the launch on <span className="text-lime">ONE chain only</span> — the
              one you launch from, with its gas token. SPAWN! deploys natively to the other
              five. No 6 wallets, no 6 gas tokens.
            </p>

            <p className={`${label} mt-7`}>06 — WHO EATS THE 1% TRADING FEE?</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(
                [
                  ['holders', '💚 100% HOLDERS', 'Every fee streams to the people holding.'],
                  ['split', '🤝 50 / 50', 'Half to holders, half to you.'],
                  ['dev', '👑 100% DEV', 'All fees are yours to claim.'],
                  ['burn', '🔥 BUYBACK & BURN', 'Fees auto-buy the token and burn it.'],
                ] as [FeeMode, string, string][]
              ).map(([m, title, desc]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setFeeMode(m)}
                  aria-pressed={feeMode === m}
                  className={`rounded-xl border-3 p-3 text-left transition ${
                    feeMode === m
                      ? 'border-lime bg-lime/10 shadow-[4px_4px_0_0_#c9f24b]'
                      : 'border-white/20 bg-void hover:border-white/40'
                  }`}
                >
                  <span className="block font-mono text-[11px] font-bold tracking-wide text-white">
                    {title}
                  </span>
                  <span className="mt-1 block font-mono text-[9px] leading-relaxed text-white/40">
                    {desc}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/40">
              Locked at launch, forever. Fees from all six chains land in one global pot —
              one market, one pot.
            </p>

            <p className={`${label} mt-7`}>07 — SNIPE YOUR OWN SPAWN (OPTIONAL)</p>
            <div className="mt-3 flex items-center gap-3 rounded-xl border-3 border-white/20 bg-void px-4 py-3">
              <span className="font-mono text-[13px] font-bold text-white/50">DEV BUY $</span>
              <input
                value={devBuyStr}
                onChange={(e) => setDevBuyStr(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder="0"
                className="w-24 bg-transparent font-mono text-[13px] font-bold text-white outline-none placeholder:text-white/25"
                aria-label="Dev buy amount in USD"
              />
              <span className="ml-auto font-mono text-[9px] font-bold leading-tight text-white/35">
                FIRST BUY ON THE CURVE,
                <br />
                STRAIGHT FROM YOUR WALLET
              </span>
            </div>

            <button
              onClick={() => void submit()}
              disabled={!ready || busy}
              className="mt-7 w-full rounded-xl border-3 border-white/25 bg-void px-6 py-4 font-mono text-[13px] font-bold tracking-wide text-white shadow-[6px_6px_0_0_#c9f24b] transition hover:-translate-y-1 hover:shadow-[9px_9px_0_0_#c9f24b] active:translate-y-0 active:shadow-[6px_6px_0_0_#c9f24b] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {busy ? '✳ SPAWNING ACROSS THE MULTIVERSE…' : '✳ SPAWN ACROSS THE MULTIVERSE ↗'}
            </button>
            {spawnErr && (
              <p className="mt-3 font-mono text-[10px] font-bold tracking-wide text-down">
                {spawnErr}
              </p>
            )}
            <p className="mt-3 font-mono text-[10px] leading-relaxed text-white/35">
              {ready
                ? 'Demo money only — in on-chain mode this submits real transactions to the local SPAWN! deployment.'
                : 'Name it, tick it, give it a face — then the multiverse opens.'}
            </p>
          </div>

          {/* preview */}
          <div className="border-t-3 border-ink/60 bg-void p-6 sm:p-8 lg:border-l-3 lg:border-t-0">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] font-bold tracking-[0.2em] text-lime">
                ✳ YOUR FUTURE PROBLEM
              </p>
              <p className="font-mono text-[10px] font-bold tracking-wide text-white/40">
                PRE-LAUNCH
              </p>
            </div>

            <div className="mt-5 overflow-hidden rounded-2xl border-3 border-ink bg-white shadow-[8px_8px_0_0_#f06eaa]">
              <div
                className="dot-grid relative flex h-56 items-center justify-center border-b-3 border-ink"
                style={{ background: PREVIEW_BG }}
              >
                <Sparkle size={26} className="absolute left-[16%] top-[18%] animate-twinkle" />
                <Sparkle
                  size={16}
                  className="absolute right-[18%] top-[30%] animate-twinkle"
                  style={{ animationDelay: '-1s' }}
                />
                <Sparkle
                  size={20}
                  className="absolute bottom-[16%] right-[26%] animate-twinkle"
                  style={{ animationDelay: '-2s' }}
                />
                <div className="animate-floaty">
                  {image ? (
                    <img
                      src={image}
                      alt=""
                      className="h-[150px] w-[150px] rounded-full border-3 border-ink bg-white object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex h-[150px] w-[150px] items-center justify-center rounded-full border-3 border-dashed border-ink/40 bg-white/40 font-display text-6xl text-ink/30">
                      ?
                    </div>
                  )}
                </div>
              </div>
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 truncate font-display text-2xl tracking-wide">
                    {previewName}
                  </h3>
                  <span className="pt-1 font-mono text-[11px] font-bold opacity-60">
                    ${previewTicker}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[10px] font-bold tracking-wide opacity-50">
                  ↗ 6 NATIVE DEPLOYMENTS · 1 TOTAL SUPPLY
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-1 font-mono text-[10px] font-bold tracking-wide text-tang">
              <p>CURVE START PRICE: {fmtPrice(START_PRICE)}</p>
              <p>GLOBAL SUPPLY: {fmtNum(GLOBAL_SUPPLY)} — PREDEFINED</p>
              <p>ASCENSION: CURVE → OMNIPOOL AT ~$86K MCAP</p>
              <p>GLOBAL GENESIS: SIMULATED, NOT ATOMIC</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
