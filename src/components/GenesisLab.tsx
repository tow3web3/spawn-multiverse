import { useEffect, useRef, useState } from 'react'
import { useStore, GLOBAL_SUPPLY, START_PRICE, type CreatureLinks, type FeeMode } from '../store'
import { useChainSet } from '../lib/liveChains'
import { fmtNum, fmtPrice } from '../lib/format'
import { cleanLinks, LINK_META } from '../lib/links'
import { processImage, uploadTokenImage } from '../lib/tokenImage'
import { IMAGE_PATH_SAMPLE, MAX_META_BYTES, buildMetaURI, utf8Len } from '../lib/tokenMeta'
import { ChainDots, Sparkle } from './bits'
import { ChainChip, ChainLogo, CoinLogo, coinOf } from './ChainLogos'

const PREVIEW_BG = '#9ccbf5'

export function GenesisLab({
  onClose,
  onSpawned,
}: {
  onClose: () => void
  onSpawned: (num: number) => void
}) {
  const { spawn, connect, wallet, onchain } = useStore()
  const chainSet = useChainSet()
  const liveChains = chainSet.live
  const info = onchain?.chainInfo
  const [name, setName] = useState('')
  const [ticker, setTicker] = useState('')
  const [image, setImage] = useState<string | null>(null)
  /** The same face as the bytes that get hosted at launch (on-chain modes). */
  const [imageBlob, setImageBlob] = useState<Blob | null>(null)
  const [imageError, setImageError] = useState(false)
  /** Why hosting the face failed — the launch then waits for a decision. */
  const [hostErr, setHostErr] = useState<string | null>(null)
  const [hosting, setHosting] = useState(false)
  /** One upload per picked image, even if the wallet step is retried. */
  const hosted = useRef<{ blob: Blob; path: string } | null>(null)
  const [links, setLinks] = useState<CreatureLinks>({})
  const [feeMode, setFeeMode] = useState<FeeMode>('holders')
  const [devBuyStr, setDevBuyStr] = useState('')
  const [busy, setBusy] = useState(false)
  const [spawnErr, setSpawnErr] = useState<string | null>(null)
  /** On-chain: the chain the launch is signed and paid from. */
  const [fromChain, setFromChain] = useState<string | null>(null)
  const [launchFee, setLaunchFee] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // default launch chain: the hub chain's own gateway (instant, and the only
  // one whose launch crosses no bridge), else the first live chain
  const from =
    onchain && liveChains.length
      ? (liveChains.find((c) => c.id === fromChain) ??
        liveChains.find((c) => info?.[c.id]?.local) ??
        liveChains[0])
      : undefined
  const fromInfo = from ? info?.[from.id] : undefined
  const fromInstant = !!onchain && (onchain.network === 'local' || !!fromInfo?.local)
  const feeCoin = coinOf(fromInfo?.nativeSymbol ?? 'ETH')
  const devBuyNum = Number.parseFloat(devBuyStr) || 0
  /** Where a launch reaches other people (public testnet, mainnet) a token
   * must carry its real, hosted image: no launch without one, no placeholder. */
  const imageMustBeHosted = !!onchain && onchain.network !== 'local'

  // the launch fee depends on the strings and on the dev buy: quote it live
  const linksKey = JSON.stringify(cleanLinks(links))
  useEffect(() => {
    if (!onchain?.quoteSpawnFee || !from || onchain.status !== 'ready') return
    if (onchain.sponsored) {
      setLaunchFee(0)
      return
    }
    let stale = false
    const t = window.setTimeout(() => {
      void onchain.quoteSpawnFee!(
        {
          name: name.trim() || 'TURBO PICKLE',
          ticker: ticker.trim() || 'PICKL',
          image: '',
          // the fee follows the payload size: quote with the image path in it
          imageUrl: image ? IMAGE_PATH_SAMPLE : undefined,
          links: cleanLinks(links),
          feeMode,
          devBuyUsd: devBuyNum,
        },
        from.id,
      )
        .then((fee) => !stale && setLaunchFee(fee))
        .catch(() => !stale && setLaunchFee(null))
    }, 350)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onchain?.status, onchain?.sponsored, from?.id, name, ticker, linksKey, feeMode, devBuyNum > 0, image !== null])

  const previewName = (name.trim() || 'TURBO PICKLE').toUpperCase()
  const previewTicker = (ticker.trim() || 'PICKL').toUpperCase()
  // On-chain the links, the fee mode and the image path share one 1024-byte
  // metaURI: check it here, before anything is hosted or signed.
  const metaBytes = utf8Len(
    buildMetaURI({ links: cleanLinks(links), feeMode, image: image ? IMAGE_PATH_SAMPLE : undefined }),
  )
  const metaTooLong = !!onchain && metaBytes > MAX_META_BYTES
  const ready = name.trim().length > 0 && ticker.trim().length > 0 && image !== null && !metaTooLong

  const onFile = async (file: File | undefined | null) => {
    if (!file) return
    try {
      const p = await processImage(file)
      setImage(p.dataUrl)
      setImageBlob(p.blob)
      setImageError(false)
      setHostErr(null)
    } catch {
      setImageError(true)
    }
  }

  const submit = async () => {
    if (!ready || !image || busy) return
    setBusy(true)
    setSpawnErr(null)
    setHostErr(null)
    try {
      // Host the face first: a launch cannot be edited, so the image path
      // has to be in the metaURI the wallet is about to sign.
      let imageUrl: string | undefined
      if (onchain && imageBlob) {
        if (hosted.current?.blob === imageBlob) {
          imageUrl = hosted.current.path
        } else {
          setHosting(true)
          try {
            imageUrl = await uploadTokenImage(imageBlob)
            hosted.current = { blob: imageBlob, path: imageUrl }
          } catch (e) {
            // A local devnet usually runs without the image function: the
            // face simply stays in this browser, as it always did there.
            // Anywhere other people can see the token, no image = no launch.
            if (imageMustBeHosted) {
              setHostErr(e instanceof Error && e.message ? e.message : 'image hosting is unavailable')
              return
            }
          } finally {
            setHosting(false)
          }
        }
      }
      // The dev buy rides INSIDE the spawn — the one FAIR GENESIS exemption.
      let devBuyUsd = 0
      if (devBuyNum > 0) {
        const w = wallet ?? (await connect())
        // the sim has one balance; on-chain the dev buy spends the launch
        // chain's dollars and the provider says so if they fall short
        devBuyUsd = onchain ? devBuyNum : Math.min(devBuyNum, w.balance)
      }
      const c = await spawn({
        name: name.trim(),
        ticker: ticker.trim(),
        image,
        imageUrl,
        links: cleanLinks(links),
        feeMode,
        devBuyUsd,
        chain: from?.id,
      })
      onClose()
      onSpawned(c.num)
    } catch (e) {
      const why = e instanceof Error && e.message ? e.message.split('\n')[0].slice(0, 160) : ''
      setSpawnErr(
        onchain
          ? `SPAWN FAILED — ${(why || 'THE TRANSACTION DID NOT GO THROUGH').toUpperCase()}`
          : 'SPAWN FAILED — TRY AGAIN.',
      )
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
              <br />
              {chainSet.count} CHAINS = 1 LAUNCH
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

            <p className={`${label} mt-7`}>
              02 — GIVE IT A FACE{' '}
              <span className={image ? 'text-lime' : 'text-tang'}>
                {image ? '✓' : imageMustBeHosted ? '— REQUIRED: NO IMAGE, NO LAUNCH' : '— REQUIRED'}
              </span>
            </p>
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
                  all {chainSet.lower} chains.
                  {imageMustBeHosted
                    ? ' Every token here wears its real image: it is shrunk in your browser and hosted by SPAWN! when you launch, so every visitor sees it — and it cannot be changed afterwards.'
                    : onchain
                      ? ' It is shrunk in your browser and hosted by SPAWN! when you launch, so every visitor sees it.'
                      : ''}
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
            {metaTooLong && (
              <p className="mt-2 font-mono text-[10px] font-bold tracking-wide text-down">
                THOSE LINKS ARE TOO LONG TO FIT ON-CHAIN ({metaBytes} / {MAX_META_BYTES} BYTES) —
                SHORTEN THEM TO LAUNCH.
              </p>
            )}

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
              <div className="flex flex-wrap gap-1.5">
                {liveChains.map((ch) => (
                  <ChainChip key={ch.id} id={ch.id} size={30} />
                ))}
                {/* the rest of the six-chain design: shown, greyed, not promised */}
                {chainSet.soon.map((ch) => (
                  <ChainChip key={ch.id} id={ch.id} size={30} dim />
                ))}
              </div>
              <span className="font-mono text-[11px] font-bold text-lime">
                {liveChains.length} / {liveChains.length + chainSet.soon.length} ACTIVATED ✓
              </span>
            </div>
            {chainSet.soon.length > 0 && (
              <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/40">
                Live on this deployment: {chainSet.names}. Coming:{' '}
                {chainSet.soon.map((c) => c.label).join(', ')} — your token will not exist
                there until they are switched on.
              </p>
            )}
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/40">
              💡 You pay the launch on <span className="text-lime">ONE chain only</span> — the
              one you launch from, with its gas token. SPAWN! deploys natively to
              {chainSet.count > 2 ? ` the other ${chainSet.count - 1}` : ' the rest'}. No{' '}
              {chainSet.count} wallets, no {chainSet.count} gas tokens.
            </p>

            {/* on-chain: where the launch is signed from, and what it costs */}
            {onchain && from && (
              <>
                <p className={`${label} mt-5`}>LAUNCH FROM</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {liveChains.map((ch) => (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => setFromChain(ch.id)}
                      aria-pressed={from.id === ch.id}
                      title={info?.[ch.id]?.local ? `${ch.label} — the hub chain: instant` : ch.label}
                      className={`inline-flex items-center gap-1.5 rounded-lg border-2 py-1.5 pl-2 pr-2.5 font-mono text-[10px] font-bold transition ${
                        from.id === ch.id
                          ? 'border-lime bg-lime text-ink'
                          : 'border-white/25 text-white/60 hover:border-white/50'
                      }`}
                    >
                      <ChainLogo id={ch.id} size={16} />
                      {ch.label}
                      {info?.[ch.id]?.local ? ' ⚡' : ''}
                    </button>
                  ))}
                </div>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/40">
                  {fromInstant
                    ? onchain.network === 'local'
                      ? 'Local devnet: the launch lands in one transaction.'
                      : `${from.label} is the hub chain: your token exists there in one transaction, and reaches the other chains a minute or two later.`
                    : `From ${from.label} the launch crosses LayerZero to the hub first: allow 1–3 minutes before it appears.`}{' '}
                  <span className="text-lime">
                    {onchain.sponsored ? (
                      'Network fee: sponsored on this testnet — you only pay gas.'
                    ) : launchFee === null ? (
                      'Network fee: quoting…'
                    ) : launchFee > 0 ? (
                      <>
                        Network fee ≈{' '}
                        {feeCoin && <CoinLogo id={feeCoin} size={13} className="-mt-0.5 mr-0.5" />}
                        {launchFee.toFixed(launchFee < 0.001 ? 6 : 5)} {fromInfo?.nativeSymbol ?? 'ETH'} + gas — it
                        pays the messages that create your token on the other chains
                        {devBuyNum > 0 && !fromInstant ? ' and bring your dev buy home' : ''}. Not refundable.
                      </>
                    ) : (
                      'No network fee — you only pay gas.'
                    )}
                  </span>
                </p>
              </>
            )}

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
              Locked at launch, forever. Fees from all {chainSet.lower} chains land in one
              global pot — one market, one pot.
            </p>

            <p className={`${label} mt-7`}>07 — SNIPE YOUR OWN SPAWN (OPTIONAL)</p>
            <div className="mt-3 flex items-center gap-3 rounded-xl border-3 border-white/20 bg-void px-4 py-3">
              <span className="inline-flex items-center gap-1.5 font-mono text-[13px] font-bold text-white/50">
                {/* on-chain the dev buy is paid in USDC; the simulation's dollars are not */}
                {onchain && <CoinLogo id="usdc" size={16} />}
                DEV BUY $
              </span>
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
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/40">
              🛡 <span className="text-lime">FAIR GENESIS:</span> your launch is snipe-protected —
              block 0 accepts no buys, then for 10 minutes buys pay a snipe tax decaying 30%→1%
              (routed like your fees) with a $250 cap per wallet. Your dev buy rides inside the
              spawn itself and is the one disclosed exemption.
              {onchain && from
                ? ` It is paid in USDC from your ${from.label} balance${
                    fromInfo && wallet ? ` ($${Math.max(fromInfo.usdc, fromInfo.ousd).toFixed(2)} available)` : ''
                  }, approved for the exact amount.`
                : ''}
            </p>

            <button
              onClick={() => void submit()}
              disabled={!ready || busy}
              className="mt-7 w-full rounded-xl border-3 border-white/25 bg-void px-6 py-4 font-mono text-[13px] font-bold tracking-wide text-white shadow-[6px_6px_0_0_#c9f24b] transition hover:-translate-y-1 hover:shadow-[9px_9px_0_0_#c9f24b] active:translate-y-0 active:shadow-[6px_6px_0_0_#c9f24b] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {hosting
                ? '✳ HOSTING THE FACE…'
                : busy
                  ? '✳ SPAWNING ACROSS THE MULTIVERSE…'
                  : '✳ SPAWN ACROSS THE MULTIVERSE ↗'}
            </button>
            {/* why the button is closed, said next to it */}
            {!ready && !busy && (
              <p className="mt-3 font-mono text-[10px] font-bold tracking-wide text-tang">
                {!name.trim() || !ticker.trim()
                  ? 'NAME IT AND GIVE IT A STICKER TO LAUNCH.'
                  : !image
                    ? imageMustBeHosted
                      ? 'ADD ITS IMAGE TO LAUNCH — A TOKEN CANNOT GO LIVE WITHOUT ITS REAL IMAGE.'
                      : 'GIVE IT A FACE TO LAUNCH.'
                    : 'SHORTEN THE LINKS TO LAUNCH.'}
              </p>
            )}
            {hostErr && (
              <div className="mt-3 rounded-xl border-3 border-tang bg-tang/10 p-3">
                <p className="font-mono text-[10px] font-bold leading-relaxed tracking-wide text-tang">
                  COULDN'T HOST YOUR IMAGE — {hostErr.toUpperCase()}. NOTHING HAS BEEN SIGNED. A
                  TOKEN CANNOT LAUNCH WITHOUT ITS REAL IMAGE, AND A LAUNCH CAN'T BE EDITED: TRY
                  AGAIN, OR PICK ANOTHER IMAGE.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={busy}
                    className="rounded-lg border-2 border-lime bg-lime px-3 py-1.5 font-mono text-[10px] font-bold text-ink disabled:opacity-40"
                  >
                    TRY HOSTING AGAIN
                  </button>
                </div>
              </div>
            )}
            {spawnErr && (
              <p className="mt-3 font-mono text-[10px] font-bold tracking-wide text-down">
                {spawnErr}
              </p>
            )}
            <p className="mt-3 font-mono text-[10px] leading-relaxed text-white/35">
              {!ready
                ? '' // the reason the button is closed is said just above
                : !onchain
                  ? 'Simulation — demo money only, no transaction is submitted.'
                  : onchain.network === 'mainnet'
                    ? 'MAINNET — this submits a real transaction and spends real USDC and gas. Unaudited contracts: only what you can lose.'
                    : onchain.network === 'testnet'
                      ? 'Public testnet — real transactions, play money.'
                      : 'Local devnet — real transactions against your own node, play money.'}
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
                <div className="mt-2 flex items-center justify-between gap-2">
                  <ChainDots size="sm" />
                  <p className="font-mono text-[10px] font-bold tracking-wide opacity-50">
                    ↗ {chainSet.count} NATIVE DEPLOYMENTS · 1 TOTAL SUPPLY
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6 space-y-1 font-mono text-[10px] font-bold tracking-wide text-tang">
              <p>CURVE START PRICE: {fmtPrice(START_PRICE)}</p>
              <p>GLOBAL SUPPLY: {fmtNum(GLOBAL_SUPPLY)} — PREDEFINED</p>
              <p>ASCENSION: CURVE → OMNIPOOL AT ~$86K MCAP</p>
              <p>
                GLOBAL GENESIS:{' '}
                {onchain
                  ? 'ONE TRANSACTION, REPLICAS FOLLOW BY MESSAGE'
                  : 'SIMULATED, NOT ATOMIC'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
