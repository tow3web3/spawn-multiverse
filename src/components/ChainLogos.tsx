import { useId } from 'react'

/**
 * The real brand marks of the chains and currencies SPAWN! touches, inline
 * (no external asset, no network request). Geometry comes from each brand's
 * own published mark:
 *  - Base: "The Square" (base/brand-kit, 2025 identity, #0000FF)
 *  - Arbitrum, Optimism: the official marks as redrawn 1:1 by web3icons
 *  - Ethereum, BNB, USDC, Solana: the marks as distributed by
 *    cryptocurrency-icons (Solana in its brand gradient)
 * Every mark carries its name (role="img" + <title>), fills its box, and is
 * drawn to stay legible from 14px up on both the cream and the dark surface.
 */

export type ChainLogoId = 'solana' | 'ethereum' | 'base' | 'bnb' | 'arbitrum' | 'optimism'
export type CoinLogoId = 'usdc' | 'eth' | 'bnb' | 'sol'

export const CHAIN_NAME: Record<ChainLogoId, string> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  base: 'Base',
  bnb: 'BNB Chain',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
}

const COIN_NAME: Record<CoinLogoId, string> = { usdc: 'USDC', eth: 'ETH', bnb: 'BNB', sol: 'SOL' }

interface MarkProps {
  size: number
  name: string
  className?: string
}

function Svg({
  size,
  name,
  className,
  viewBox,
  children,
}: MarkProps & { viewBox: string; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      role="img"
      aria-label={name}
      className={`inline-block shrink-0 align-middle ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      <title>{name}</title>
      {children}
    </svg>
  )
}

function EthereumMark(p: MarkProps) {
  return (
    <Svg {...p} viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#FFF">
        <path fillOpacity=".602" d="M16.498 4v8.87l7.497 3.35z" />
        <path d="M16.498 4L9 16.22l7.498-3.35z" />
        <path fillOpacity=".602" d="M16.498 21.968v6.027L24 17.616z" />
        <path d="M16.498 27.995v-6.028L9 17.616z" />
        <path fillOpacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
        <path fillOpacity=".602" d="M9 16.22l7.498 4.353v-7.701z" />
      </g>
    </Svg>
  )
}

function BnbMark(p: MarkProps) {
  return (
    <Svg {...p} viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="#F0B90B" />
      <path
        fill="#FFF"
        d="M12.116 14.404L16 10.52l3.886 3.886 2.26-2.26L16 6l-6.144 6.144 2.26 2.26zM6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16zm6.116 1.596L16 21.48l3.886-3.886 2.26 2.259L16 26l-6.144-6.144-.003-.003 2.263-2.257zM21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16zm-3.188-.002h.002V16L16 18.294l-2.291-2.29-.004-.004.004-.003.401-.402.195-.195L16 13.706l2.293 2.293z"
      />
    </Svg>
  )
}

/** Solana's three bars in the brand gradient. On a dark disc: the bare bars
 * lose their green end on cream and their purple end on ink. */
function SolanaMark(p: MarkProps) {
  const id = `sol-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <Svg {...p} viewBox="0 0 32 32">
      <defs>
        <linearGradient id={id} x1="7" y1="23" x2="25" y2="9" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      {/* the faint edge keeps the disc readable on the dark surface */}
      <circle cx="16" cy="16" r="15.4" fill="#000" stroke="#fff" strokeOpacity=".3" strokeWidth="1.2" />
      <path
        fill={`url(#${id})`}
        d="M9.925 19.687a.59.59 0 01.415-.17h14.366a.29.29 0 01.207.497l-2.838 2.815a.59.59 0 01-.415.171H7.294a.291.291 0 01-.207-.498l2.838-2.815zm0-10.517A.59.59 0 0110.34 9h14.366c.261 0 .392.314.207.498l-2.838 2.815a.59.59 0 01-.415.17H7.294a.291.291 0 01-.207-.497L9.925 9.17zm12.15 5.225a.59.59 0 00-.415-.17H7.294a.291.291 0 00-.207.498l2.838 2.815c.11.109.26.17.415.17h14.366a.291.291 0 00.207-.498l-2.838-2.815z"
      />
    </Svg>
  )
}

/** Base — "The Square". */
function BaseMark(p: MarkProps) {
  return (
    <Svg {...p} viewBox="-60 -60 1400 1400">
      <path
        fill="#0000FF"
        d="M0,101.12c0-34.64,0-51.95,6.53-65.28,6.25-12.76,16.56-23.07,29.32-29.32C49.17,0,66.48,0,101.12,0h1077.76c34.63,0,51.96,0,65.28,6.53,12.75,6.25,23.06,16.56,29.32,29.32,6.52,13.32,6.52,30.64,6.52,65.28v1077.76c0,34.63,0,51.96-6.52,65.28-6.26,12.75-16.57,23.06-29.32,29.32-13.32,6.52-30.65,6.52-65.28,6.52H101.12c-34.64,0-51.95,0-65.28-6.52-12.76-6.26-23.07-16.57-29.32-29.32-6.53-13.32-6.53-30.65-6.53-65.28V101.12Z"
      />
    </Svg>
  )
}

function ArbitrumMark(p: MarkProps) {
  return (
    <Svg {...p} viewBox="3 3 18 18">
      <path
        fill="#213147"
        d="M4.51514 8.47125V15.5274C4.51514 15.9779 4.75959 16.3944 5.15552 16.6189L11.3599 20.1477C11.7558 20.3722 12.2432 20.3722 12.6392 20.1477L18.8435 16.6189C19.2394 16.3944 19.4839 15.9779 19.4839 15.5274V8.47125C19.4839 8.02072 19.2394 7.60418 18.8435 7.37966L12.6392 3.85086C12.2432 3.62634 11.7558 3.62634 11.3599 3.85086L5.15401 7.37966C4.75809 7.60418 4.51514 8.02072 4.51514 8.47125Z"
      />
      <path
        fill="#12AAFF"
        d="M13.3531 13.3677L12.4682 15.7577C12.4442 15.8241 12.4442 15.8965 12.4682 15.963L13.9905 20.0752L15.7511 19.0738L13.638 13.3677C13.59 13.2363 13.401 13.2363 13.3531 13.3677Z"
      />
      <path
        fill="#12AAFF"
        d="M15.1273 9.3485C15.0793 9.21704 14.8903 9.21704 14.8423 9.3485L13.9575 11.7384C13.9334 11.8049 13.9334 11.8773 13.9575 11.9437L16.4515 18.6764L18.2122 17.6749L15.1273 9.3485Z"
      />
      <path
        fill="#9DCCED"
        d="M11.9984 4.11521C12.0419 4.11521 12.0854 4.12703 12.1244 4.14771L18.8387 7.96602C18.9166 8.01033 18.9647 8.09305 18.9647 8.1802V15.8153C18.9647 15.904 18.9166 15.9852 18.8387 16.0295L12.1244 19.8479C12.0869 19.87 12.0419 19.8803 11.9984 19.8803C11.955 19.8803 11.9114 19.8685 11.8725 19.8479L5.15817 16.0325C5.08019 15.9881 5.0322 15.9055 5.0322 15.8183V8.18167C5.0322 8.09305 5.08019 8.01181 5.15817 7.9675L11.8725 4.14919C11.9114 4.12703 11.955 4.11521 11.9984 4.11521ZM11.9984 3C11.76 3 11.52 3.06056 11.3056 3.18316L4.59277 6.99999C4.16386 7.24371 3.8999 7.69423 3.8999 8.18167V15.8168C3.8999 16.3043 4.16386 16.7548 4.59277 16.9985L11.3071 20.8168C11.5215 20.938 11.76 21 11.9999 21C12.2384 21 12.4783 20.9395 12.6928 20.8168L19.407 16.9985C19.836 16.7548 20.0999 16.3043 20.0999 15.8168V8.18167C20.0999 7.69423 19.836 7.24371 19.407 6.99999L12.6913 3.18316C12.4768 3.06056 12.2369 3 11.9984 3Z"
      />
      <path fill="#213147" d="M7.55859 18.6854L8.17649 17.0192L9.41975 18.0369L8.25747 19.0827L7.55859 18.6854Z" />
      <path
        fill="#FFF"
        d="M11.4334 7.63513H9.73114C9.60366 7.63513 9.48969 7.71342 9.44619 7.83158L5.79736 17.6838L7.55804 18.6854L11.5758 7.83602C11.6133 7.73853 11.5398 7.63513 11.4334 7.63513Z"
      />
      <path
        fill="#FFF"
        d="M14.4117 7.63513H12.7095C12.582 7.63513 12.468 7.71342 12.4245 7.83158L8.2583 19.0812L10.019 20.0827L14.5542 7.83602C14.5902 7.73853 14.5166 7.63513 14.4117 7.63513Z"
      />
    </Svg>
  )
}

/** Optimism: the red disc with the white italic OP. */
function OptimismMark(p: MarkProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="12" fill="#FF0420" />
      <path
        fill="#FFF"
        fillRule="evenodd"
        clipRule="evenodd"
        transform="translate(12 12) scale(0.7) translate(-12 -12)"
        d="M3.96598 15.8003C4.61807 16.2668 5.45548 16.5 6.47819 16.5C7.71385 16.5 8.70121 16.2206 9.44024 15.6622C10.1785 15.0955 10.6981 14.2416 10.9987 13.1002C11.1791 12.4003 11.3339 11.6792 11.4629 10.9373C11.5048 10.672 11.5261 10.451 11.527 10.2742C11.527 9.69135 11.3767 9.19175 11.076 8.77545C10.7669 8.34324 10.3365 8.01244 9.83925 7.82494C9.31535 7.60832 8.72294 7.5 8.062 7.5C5.63269 7.5 4.12587 8.64576 3.54157 10.9373C3.33527 11.7795 3.17647 12.5004 3.0652 13.1002C3.02627 13.323 3.00446 13.5484 3 13.7744C3 14.6498 3.322 15.3251 3.96598 15.8003ZM8.61573 13.0251C8.36926 13.9822 7.68954 14.6056 6.65834 14.6056C5.63821 14.6056 5.29006 13.9159 5.47353 13.0251C5.62826 12.2168 5.783 11.5333 5.93773 10.9749C6.20299 9.94146 6.82855 9.39438 7.89401 9.39438C8.91083 9.39438 9.2424 10.0752 9.06667 10.9749C8.96351 11.5585 8.8132 12.2418 8.61573 13.0251ZM12.5184 16.4104C12.5692 16.4694 12.6403 16.4988 12.7317 16.4988H14.4359C14.523 16.4978 14.607 16.4666 14.6735 16.4104C14.7476 16.3537 14.797 16.2705 14.8117 16.1783L15.35 13.6584H17.083C18.1772 13.6584 19.0327 13.1279 19.6593 12.6559C20.2945 12.1843 20.7162 11.4557 20.9248 10.4697C20.9757 10.2384 21.0007 10.0155 21 9.8011C21 9.05618 20.7162 8.48624 20.1489 8.0913C19.5889 7.6971 18.8455 7.5 17.9186 7.5H14.5862C14.4985 7.50141 14.4141 7.53348 14.3476 7.59063C14.2749 7.64811 14.2261 7.73036 14.2105 7.82162L12.4808 16.1783C12.4623 16.2577 12.4758 16.3411 12.5184 16.4104ZM18.6082 10.4443C18.4513 11.1329 17.8512 11.7629 17.146 11.7629H15.7058L16.2021 9.39438H17.7053C18.217 9.39438 18.6447 9.49606 18.6447 10.0586C18.6447 10.1691 18.6333 10.2976 18.6082 10.4443Z"
      />
    </Svg>
  )
}

function UsdcMark(p: MarkProps) {
  return (
    <Svg {...p} viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <g fill="#FFF">
        <path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z" />
        <path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z" />
      </g>
    </Svg>
  )
}

const CHAIN_MARK: Record<ChainLogoId, (p: MarkProps) => React.ReactElement> = {
  solana: SolanaMark,
  ethereum: EthereumMark,
  base: BaseMark,
  bnb: BnbMark,
  arbitrum: ArbitrumMark,
  optimism: OptimismMark,
}

const COIN_MARK: Record<CoinLogoId, (p: MarkProps) => React.ReactElement> = {
  usdc: UsdcMark,
  eth: EthereumMark,
  bnb: BnbMark,
  sol: SolanaMark,
}

export const isChainLogoId = (id: string): id is ChainLogoId => id in CHAIN_MARK

/** A chain's real logo. Unknown ids render nothing rather than a guess. */
export function ChainLogo({ id, size = 18, className }: { id: string; size?: number; className?: string }) {
  if (!isChainLogoId(id)) return null
  const Mark = CHAIN_MARK[id]
  return <Mark size={size} name={CHAIN_NAME[id]} className={className} />
}

/** A currency's real logo (USDC, and the gas coins). */
export function CoinLogo({ id, size = 14, className }: { id: CoinLogoId; size?: number; className?: string }) {
  const Mark = COIN_MARK[id]
  return <Mark size={size} name={COIN_NAME[id]} className={className} />
}

/** The coin behind a native-currency symbol ("ETH", "tBNB", "SOL"), if we draw it. */
export function coinOf(symbol: string | undefined): CoinLogoId | undefined {
  const s = (symbol ?? '').toUpperCase()
  if (s === 'ETH') return 'eth'
  if (s === 'BNB' || s === 'TBNB') return 'bnb'
  if (s === 'SOL') return 'sol'
  return undefined
}

/**
 * The chain's logo in the app's frame: a white disc with an ink ring — what
 * the coloured letter chips used to be. `size` is the outer diameter.
 */
export function ChainChip({
  id,
  size = 22,
  className = '',
  dim = false,
}: {
  id: string
  size?: number
  className?: string
  /** A chain that is not live here: greyed, dashed ring. */
  dim?: boolean
}) {
  if (!isChainLogoId(id)) return null
  const ring = size >= 22 ? 2 : 1.5
  const inner = size - ring * 2
  // a square mark (Base) must sit inside the disc, corners included
  const logo = Math.round(id === 'base' ? inner * 0.62 : inner - 3)
  return (
    <span
      title={CHAIN_NAME[id]}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-white ${
        dim ? 'border-dashed border-ink/40 opacity-60 grayscale' : 'border-ink'
      } ${className}`}
      style={{ width: size, height: size, borderWidth: ring, borderStyle: dim ? 'dashed' : 'solid' }}
    >
      <ChainLogo id={id} size={logo} />
    </span>
  )
}

export const CHAIN_LOGO_LABELS: { id: ChainLogoId; label: string }[] = [
  { id: 'solana', label: 'SOLANA' },
  { id: 'ethereum', label: 'ETHEREUM' },
  { id: 'base', label: 'BASE' },
  { id: 'bnb', label: 'BNB' },
  { id: 'arbitrum', label: 'ARBITRUM' },
  { id: 'optimism', label: 'OPTIMISM' },
]
