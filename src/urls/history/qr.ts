// A QR code encoder, small and without dependencies: byte mode, error
// correction L or M, versions 1 to 10 (up to 213 bytes at M, 271 at L), which
// is any URL worth putting on a phone. It follows ISO/IEC 18004 the way most
// small encoders do (the structure is Nayuki's, "QR Code generator library").
//
//   encode("https://…")       the modules, true = dark, row by row
//   halfBlocks(modules)       for a terminal: two module rows per text row
//
// The pane draws the half blocks white on black, so the code reads the same on
// a light or a dark terminal: a "light" module is a full block, dark ones are
// spaces, with a quiet zone round it.

export type Ecl = "L" | "M"
export type Qr = { version: number; ecl: Ecl; mask: number; size: number; modules: boolean[][] }

/** [error correction codewords per block, then the blocks' data lengths], per version, for L and M. */
const BLOCKS: Record<Ecl, [number, number[]][]> = {
  L: [
    [7, [19]],
    [10, [34]],
    [15, [55]],
    [20, [80]],
    [26, [108]],
    [18, [68, 68]],
    [20, [78, 78]],
    [24, [97, 97]],
    [30, [116, 116]],
    [18, [68, 68, 69, 69]],
  ],
  M: [
    [10, [16]],
    [16, [28]],
    [26, [44]],
    [18, [32, 32]],
    [24, [43, 43]],
    [16, [27, 27, 27, 27]],
    [18, [31, 31, 31, 31]],
    [22, [38, 38, 39, 39]],
    [22, [36, 36, 36, 37, 37]],
    [26, [43, 43, 43, 43, 44]],
  ],
}
export const MAX_VERSION = 10
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
/** Format bits for each level: L is 01, M is 00. */
const ECL_BITS: Record<Ecl, number> = { L: 1, M: 0 }

export const dataCapacity = (version: number, ecl: Ecl) => BLOCKS[ecl][version - 1][1].reduce((a, b) => a + b, 0)
/** Bytes of payload a version holds in byte mode. */
export const byteCapacity = (version: number, ecl: Ecl) => Math.floor((dataCapacity(version, ecl) * 8 - 4 - (version < 10 ? 8 : 16)) / 8)

// --- GF(256) and Reed-Solomon ---------------------------------------------------------

export function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const out = new Array(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root)
      if (j + 1 < out.length) out[j] ^= out[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return out
}

/** The error correction codewords for one block. */
export function rsRemainder(data: number[], degree: number): number[] {
  const div = rsDivisor(degree)
  const out = new Array(degree).fill(0)
  for (const b of data) {
    const factor = b ^ (out.shift() as number)
    out.push(0)
    div.forEach((c, i) => (out[i] ^= gfMul(c, factor)))
  }
  return out
}

// --- bits ------------------------------------------------------------------------

/** The 15 format bits for a level and mask, BCH-protected and masked. */
export function formatBits(ecl: Ecl, mask: number): number {
  const data = (ECL_BITS[ecl] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** The 18 version bits (version 7 and up). */
export function versionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0

/** The data codewords for a payload: mode, count, bytes, terminator, padding. */
export function dataCodewords(bytes: Uint8Array, version: number, ecl: Ecl): number[] {
  const cap = dataCapacity(version, ecl) * 8
  const bits: number[] = []
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  if (bits.length > cap) throw new Error("too long for this version")
  put(0, Math.min(4, cap - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  return out
}

/** Data and error correction, interleaved across blocks the way a reader takes them back. */
export function interleave(data: number[], version: number, ecl: Ecl): number[] {
  const [ecLen, lens] = BLOCKS[ecl][version - 1]
  const blocks: number[][] = []
  let k = 0
  for (const n of lens) {
    blocks.push(data.slice(k, k + n))
    k += n
  }
  const ecs = blocks.map((b) => rsRemainder(b, ecLen))
  const out: number[] = []
  const longest = Math.max(...lens)
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i])
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i])
  return out
}

// --- the matrix -------------------------------------------------------------------------

type Grid = { size: number; m: boolean[][]; fn: boolean[][] }

function grid(version: number): Grid {
  const size = version * 4 + 17
  return { size, m: Array.from({ length: size }, () => new Array(size).fill(false)), fn: Array.from({ length: size }, () => new Array(size).fill(false)) }
}

const setFn = (g: Grid, x: number, y: number, dark: boolean) => {
  g.m[y][x] = dark
  g.fn[y][x] = true
}

/** Finders, timing, alignment, the dark module, and room for format and version bits. */
function drawFunctions(g: Grid, version: number) {
  const { size } = g
  for (let i = 0; i < size; i++) {
    setFn(g, 6, i, i % 2 === 0)
    setFn(g, i, 6, i % 2 === 0)
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        setFn(g, x, y, d !== 2 && d !== 4)
      }
  }
  finder(3, 3)
  finder(size - 4, 3)
  finder(3, size - 4)
  const pos = ALIGN[version - 1]
  for (let i = 0; i < pos.length; i++)
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(g, pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  drawFormat(g, "L", 0) // reserves the cells; drawn for real after masking
  if (version >= 7) {
    const v = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFn(g, a, b, bit(v, i))
      setFn(g, b, a, bit(v, i))
    }
  }
}

function drawFormat(g: Grid, ecl: Ecl, mask: number) {
  const { size } = g
  const f = formatBits(ecl, mask)
  for (let i = 0; i <= 5; i++) setFn(g, 8, i, bit(f, i))
  setFn(g, 8, 7, bit(f, 6))
  setFn(g, 8, 8, bit(f, 7))
  setFn(g, 7, 8, bit(f, 8))
  for (let i = 9; i < 15; i++) setFn(g, 14 - i, 8, bit(f, i))
  for (let i = 0; i < 8; i++) setFn(g, size - 1 - i, 8, bit(f, i))
  for (let i = 8; i < 15; i++) setFn(g, 8, size - 15 + i, bit(f, i))
  setFn(g, 8, size - 8, true)
}

/** The order data modules are filled in: two columns at a time, up and down, right to left. */
export function dataCells(size: number, fn: boolean[][]): [number, number][] {
  const out: [number, number][] = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!fn[y][x]) out.push([x, y])
      }
  }
  return out
}

/** Whether mask `m` flips the module at column x, row y. */
export function masked(m: number, x: number, y: number): boolean {
  switch (m) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/** The standard penalty: runs, boxes, finder-like patterns, and balance. Lower is easier to read. */
export function penalty(m: boolean[][]): number {
  const size = m.length
  let p = 0
  const line = (get: (i: number) => boolean) => {
    let run = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++
      else {
        if (run >= 5) p += 3 + (run - 5)
        run = 1
      }
    }
    const pat = [true, false, true, true, true, false, true]
    for (let i = 0; i + 7 <= size; i++) {
      if (!pat.every((v, k) => get(i + k) === v)) continue
      const before = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k))
      const after = i + 11 <= size && [7, 8, 9, 10].every((k) => !get(i + k))
      // Off the edge counts as light: the quiet zone.
      const beforeEdge = i < 4 && Array.from({ length: i }, (_, k) => k).every((k) => !get(k))
      const afterEdge = i + 11 > size && Array.from({ length: size - i - 7 }, (_, k) => i + 7 + k).every((k) => !get(k))
      if (before || after || beforeEdge || afterEdge) p += 40
    }
  }
  for (let y = 0; y < size; y++) line((x) => m[y][x])
  for (let x = 0; x < size; x++) line((y) => m[y][x])
  for (let y = 0; y + 1 < size; y++)
    for (let x = 0; x + 1 < size; x++) {
      const c = m[y][x]
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3
    }
  let dark = 0
  for (const r of m) for (const c of r) if (c) dark++
  const total = size * size
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
  return p
}

/** The smallest version (and level) that holds it: M while it fits, else L. */
export function pick(len: number, ecl?: Ecl): { version: number; ecl: Ecl } | null {
  for (const e of ecl ? [ecl] : (["M", "L"] as Ecl[])) for (let v = 1; v <= MAX_VERSION; v++) if (len <= byteCapacity(v, e)) return { version: v, ecl: e }
  return null
}

/** The QR code for `text` (UTF-8, byte mode). Throws when it is longer than version 10 holds. */
export function encode(text: string, o: { ecl?: Ecl; mask?: number } = {}): Qr {
  const bytes = new TextEncoder().encode(text)
  const p = pick(bytes.length, o.ecl)
  if (!p) throw new Error(`too long for a QR code here (${bytes.length} bytes; at most ${byteCapacity(MAX_VERSION, "L")})`)
  const { version, ecl } = p
  const g = grid(version)
  drawFunctions(g, version)
  const words = interleave(dataCodewords(bytes, version, ecl), version, ecl)
  const cells = dataCells(g.size, g.fn)
  cells.forEach(([x, y], i) => {
    g.m[y][x] = i < words.length * 8 && bit(words[i >>> 3], 7 - (i & 7))
  })
  let best: { mask: number; m: boolean[][]; score: number } | null = null
  for (const mask of o.mask !== undefined ? [o.mask] : [0, 1, 2, 3, 4, 5, 6, 7]) {
    const t: Grid = { size: g.size, m: g.m.map((r) => [...r]), fn: g.fn }
    for (const [x, y] of cells) if (masked(mask, x, y)) t.m[y][x] = !t.m[y][x]
    drawFormat(t, ecl, mask)
    const score = penalty(t.m)
    if (!best || score < best.score) best = { mask, m: t.m, score }
  }
  return { version, ecl, mask: best!.mask, size: g.size, modules: best!.m }
}

/**
 * For a terminal: each text row is two module rows. A full block is light, a
 * space dark, so drawn white on black it scans on any terminal theme.
 */
export function halfBlocks(modules: boolean[][], quiet = 2): string[] {
  const size = modules.length
  const light = (x: number, y: number) => x < 0 || y < 0 || x >= size || y >= size || !modules[y][x]
  const rows: string[] = []
  for (let y = -quiet; y < size + quiet; y += 2) {
    let s = ""
    for (let x = -quiet; x < size + quiet; x++) {
      const top = light(x, y)
      const bottom = y + 1 < size + quiet ? light(x, y + 1) : false
      s += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
    }
    rows.push(s)
  }
  return rows
}
