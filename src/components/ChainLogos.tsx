/** Official-style chain marks, drawn inline (no external assets). */

export type ChainLogoId = 'solana' | 'ethereum' | 'base' | 'bnb' | 'arbitrum' | 'optimism'

function diamond(cx: number, cy: number, r: number) {
  return `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`
}

export function ChainLogo({ id, size = 18 }: { id: ChainLogoId; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true as const }
  switch (id) {
    case 'solana':
      return (
        <svg {...common}>
          <defs>
            <linearGradient id="solg" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#9945FF" />
              <stop offset="1" stopColor="#14F195" />
            </linearGradient>
          </defs>
          <path fill="url(#solg)" d="M6.2 4 H19.8 L16.4 7.6 H2.8 Z" />
          <path fill="url(#solg)" d="M2.8 10.2 H16.4 L19.8 13.8 H6.2 Z" />
          <path fill="url(#solg)" d="M6.2 16.4 H19.8 L16.4 20 H2.8 Z" />
        </svg>
      )
    case 'ethereum':
      return (
        <svg {...common}>
          <path fill="#627EEA" d="M12 2 L18.8 12.1 L12 16.2 L5.2 12.1 Z" />
          <path fill="#627EEA" opacity="0.65" d="M12 17.8 L18.8 13.7 L12 22 L5.2 13.7 Z" />
        </svg>
      )
    case 'base':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" fill="#0052FF" />
          <rect x="1" y="10.6" width="11.5" height="2.8" rx="1.4" fill="#fff" />
        </svg>
      )
    case 'bnb':
      return (
        <svg {...common}>
          <path fill="#F3BA2F" d={diamond(12, 12, 3)} />
          <path fill="#F3BA2F" d={diamond(12, 5, 3)} />
          <path fill="#F3BA2F" d={diamond(12, 19, 3)} />
          <path fill="#F3BA2F" d={diamond(5, 12, 3)} />
          <path fill="#F3BA2F" d={diamond(19, 12, 3)} />
        </svg>
      )
    case 'arbitrum':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" fill="#213147" />
          <path fill="#12AAFF" d="M11 6.5 L6.5 17.5 L9 17.5 L13.5 6.5 Z" />
          <path fill="#9DCCED" d="M13.8 10.5 L11 17.5 L13.5 17.5 L16.3 10.5 Z" />
          <path fill="#12AAFF" d="M14.6 6.5 L12.9 6.5 L17 17.5 L18.7 13 Z" opacity="0.9" />
        </svg>
      )
    case 'optimism':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" fill="#FF0420" />
          <text
            x="12"
            y="15.5"
            textAnchor="middle"
            fontFamily="Arial, sans-serif"
            fontWeight="900"
            fontSize="9.5"
            fill="#fff"
          >
            OP
          </text>
        </svg>
      )
  }
}

export const CHAIN_LOGO_LABELS: { id: ChainLogoId; label: string }[] = [
  { id: 'solana', label: 'SOLANA' },
  { id: 'ethereum', label: 'ETHEREUM' },
  { id: 'base', label: 'BASE' },
  { id: 'bnb', label: 'BNB' },
  { id: 'arbitrum', label: 'ARBITRUM' },
  { id: 'optimism', label: 'OPTIMISM' },
]
