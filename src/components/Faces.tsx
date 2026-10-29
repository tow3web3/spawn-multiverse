export type FaceId = 'frog' | 'brain' | 'bork' | 'pickle' | 'mochi' | 'alien'

export const FACE_IDS: FaceId[] = ['frog', 'brain', 'bork', 'pickle', 'mochi', 'alien']

export const FACE_COLOR: Record<FaceId, string> = {
  frog: '#b5e95b',
  brain: '#f7a8ce',
  bork: '#9ccbf5',
  pickle: '#a78bf0',
  mochi: '#f7be7b',
  alien: '#8be0d4',
}

export const FACE_NAME: Record<FaceId, string> = {
  frog: 'GLOOPLING',
  brain: 'BRAIN',
  bork: 'BORK',
  pickle: 'PICKLE',
  mochi: 'MOCHI',
  alien: 'ALIEN',
}

const S = {
  stroke: '#141414',
  strokeWidth: 4.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function Eyes({
  lx,
  rx,
  cy,
  r = 10,
}: {
  lx: number
  rx: number
  cy: number
  r?: number
}) {
  return (
    <>
      <circle cx={lx} cy={cy} r={r} fill="#fff" {...S} strokeWidth={3.5} />
      <circle cx={rx} cy={cy} r={r} fill="#fff" {...S} strokeWidth={3.5} />
      <circle cx={lx + 2} cy={cy + 2} r={r * 0.46} fill="#141414" />
      <circle cx={rx - 2} cy={cy + 2} r={r * 0.46} fill="#141414" />
      <circle cx={lx + 4} cy={cy} r={1.8} fill="#fff" />
      <circle cx={rx} cy={cy} r={1.8} fill="#fff" />
    </>
  )
}

function Blush({ lx, rx, cy, w = 7 }: { lx: number; rx: number; cy: number; w?: number }) {
  return (
    <>
      <ellipse cx={lx} cy={cy} rx={w} ry={w * 0.62} fill="#f79ac4" />
      <ellipse cx={rx} cy={cy} rx={w} ry={w * 0.62} fill="#f79ac4" />
    </>
  )
}

function Frog() {
  return (
    <g>
      <path d="M60 10 L48 28 H72 Z" fill="#dff56c" {...S} strokeWidth={4} />
      <ellipse cx="60" cy="70" rx="45" ry="37" fill="#63c75c" {...S} />
      <circle cx="37" cy="36" r="17" fill="#63c75c" {...S} />
      <circle cx="83" cy="36" r="17" fill="#63c75c" {...S} />
      <Eyes lx={37} rx={83} cy={36} r={11} />
      <Blush lx={21} rx={99} cy={68} />
      <path d="M38 72 Q60 97 82 72 Q60 83 38 72 Z" fill="#302028" {...S} strokeWidth={4} />
    </g>
  )
}

function Brain() {
  return (
    <g>
      <line x1="42" y1="22" x2="35" y2="9" {...S} />
      <circle cx="33" cy="7" r="4" fill="#c9f24b" {...S} strokeWidth={3} />
      <line x1="78" y1="22" x2="85" y2="9" {...S} />
      <circle cx="87" cy="7" r="4" fill="#c9f24b" {...S} strokeWidth={3} />
      <path
        d="M24 78 Q12 64 22 50 Q18 32 38 28 Q46 14 62 20 Q80 12 88 28 Q106 32 102 50 Q112 64 98 78 Q96 96 74 96 L46 96 Q26 96 24 78 Z"
        fill="#f48fb8"
        {...S}
      />
      <path d="M36 42 Q44 34 52 44" fill="none" {...S} strokeWidth={3.5} opacity=".5" />
      <path d="M64 36 Q72 28 80 40" fill="none" {...S} strokeWidth={3.5} opacity=".5" />
      <path d="M30 60 Q38 53 44 62" fill="none" {...S} strokeWidth={3.5} opacity=".5" />
      <Eyes lx={46} rx={76} cy={66} />
      <Blush lx={30} rx={92} cy={80} w={6} />
      <path d="M53 82 Q61 90 69 82" fill="none" {...S} strokeWidth={4} />
    </g>
  )
}

function Bork() {
  return (
    <g>
      <path d="M24 42 L30 8 L54 28 Z" fill="#e8a860" {...S} />
      <path d="M96 42 L90 8 L66 28 Z" fill="#e8a860" {...S} />
      <path d="M31 33 L34 17 L45 26 Z" fill="#f4c7cf" stroke="none" />
      <path d="M89 33 L86 17 L75 26 Z" fill="#f4c7cf" stroke="none" />
      <ellipse cx="60" cy="68" rx="43" ry="37" fill="#e8a860" {...S} />
      <ellipse cx="60" cy="81" rx="24" ry="17" fill="#faeedd" stroke="none" />
      <Eyes lx={40} rx={80} cy={56} />
      <path d="M53 72 L67 72 L60 80 Z" fill="#141414" />
      <path d="M52 87 Q56 92 60 87 Q64 92 68 87" fill="none" {...S} strokeWidth={3.5} />
      <ellipse cx="60" cy="97" rx="6" ry="4" fill="#f27db0" {...S} strokeWidth={3} />
      <Blush lx={24} rx={96} cy={72} w={6} />
    </g>
  )
}

function Pickle() {
  return (
    <g>
      <rect x="54" y="2" width="12" height="18" rx="5" fill="#2f7d3f" {...S} strokeWidth={3.5} />
      <path
        d="M60 12 Q92 12 94 52 Q96 88 78 103 Q60 116 42 103 Q24 88 26 52 Q28 12 60 12 Z"
        fill="#53b45e"
        {...S}
      />
      <circle cx="40" cy="32" r="3.5" fill="#7ed07f" />
      <circle cx="78" cy="28" r="3" fill="#7ed07f" />
      <circle cx="88" cy="58" r="3.5" fill="#7ed07f" />
      <circle cx="33" cy="72" r="3" fill="#7ed07f" />
      <circle cx="70" cy="99" r="3" fill="#7ed07f" />
      <circle cx="52" cy="22" r="2.5" fill="#7ed07f" />
      <Eyes lx={45} rx={75} cy={52} />
      <Blush lx={31} rx={89} cy={66} w={6} />
      <path d="M48 72 Q60 83 72 72" fill="none" {...S} strokeWidth={4} />
    </g>
  )
}

function Mochi() {
  return (
    <g>
      <path d="M60 5 L50 27 L70 27 Z" fill="#f27db0" {...S} strokeWidth={4} />
      <path
        d="M60 22 Q98 22 102 62 Q104 92 82 101 Q60 110 38 101 Q16 92 18 62 Q22 22 60 22 Z"
        fill="#fff6ee"
        {...S}
      />
      <circle cx="44" cy="60" r="5" fill="#141414" />
      <circle cx="76" cy="60" r="5" fill="#141414" />
      <circle cx="46" cy="58" r="1.8" fill="#fff" />
      <circle cx="78" cy="58" r="1.8" fill="#fff" />
      <Blush lx={29} rx={91} cy={73} w={8} />
      <path d="M53 70 Q60 80 67 70 Z" fill="#302028" {...S} strokeWidth={3.5} />
    </g>
  )
}

function Alien() {
  return (
    <g>
      <line x1="42" y1="22" x2="33" y2="7" {...S} />
      <circle cx="31" cy="6" r="4.5" fill="#f27db0" {...S} strokeWidth={3} />
      <line x1="78" y1="22" x2="87" y2="7" {...S} />
      <circle cx="89" cy="6" r="4.5" fill="#f27db0" {...S} strokeWidth={3} />
      <path
        d="M60 14 Q96 14 98 52 Q100 82 80 96 Q60 108 40 96 Q20 82 22 52 Q24 14 60 14 Z"
        fill="#7fd9cc"
        {...S}
      />
      <ellipse cx="44" cy="56" rx="11" ry="15" fill="#141414" />
      <ellipse cx="76" cy="56" rx="11" ry="15" fill="#141414" />
      <ellipse cx="41" cy="50" rx="3.5" ry="5" fill="#fff" />
      <ellipse cx="73" cy="50" rx="3.5" ry="5" fill="#fff" />
      <path d="M54 82 Q60 88 66 82" fill="none" {...S} strokeWidth={4} />
      <Blush lx={27} rx={93} cy={70} w={6} />
    </g>
  )
}

const RENDER: Record<FaceId, () => React.ReactElement> = {
  frog: Frog,
  brain: Brain,
  bork: Bork,
  pickle: Pickle,
  mochi: Mochi,
  alien: Alien,
}

export function Face({
  id,
  size = 120,
  className,
}: {
  id: FaceId
  size?: number
  className?: string
}) {
  const Render = RENDER[id]
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      overflow="visible"
    >
      <Render />
    </svg>
  )
}
