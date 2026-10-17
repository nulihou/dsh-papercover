/**
 * Smoke tests for figure blank detection + Predictor undo path.
 * Run: node --import tsx/esm tests/figures-blank.mjs  (or after build: node tests/figures-blank.mjs)
 */
import { isNearBlankRaster } from '../src/read/figures.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// solid white 8x8 RGB
{
  const raw = new Uint8Array(8 * 8 * 3)
  raw.fill(255)
  assert(isNearBlankRaster(raw, 3), 'solid white should be blank')
}

// solid black
{
  const raw = new Uint8Array(8 * 8 * 3)
  assert(isNearBlankRaster(raw, 3), 'solid black should be blank')
}

// noisy content
{
  const raw = new Uint8Array(64 * 64 * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) & 0xff
  assert(!isNearBlankRaster(raw, 3), 'noisy raster should not be blank')
}

console.log('figures-blank: ok')
