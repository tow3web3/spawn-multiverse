import React from 'react'
import { Composition } from 'remotion'
import { Film } from './Film'
import { DEFAULT_PROPS, FPS, HEIGHT, TOTAL_FRAMES, WIDTH } from './script'

export const RemotionRoot: React.FC = () => (
  <Composition id="Film" component={Film} durationInFrames={TOTAL_FRAMES} fps={FPS} width={WIDTH} height={HEIGHT} defaultProps={DEFAULT_PROPS} />
)
