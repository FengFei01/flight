import { parseHeaders } from './headers'
import type { BlackboxSegment } from './types'

const PRIMARY_MARKER = 'H Product:Blackbox flight data recorder'
const GENERIC_MARKER = 'H Product:'
const VERSION_MARKER = 'H Data version:'
const MARKER_SCAN_WINDOW = 1024

export function splitLogSegments(buffer: ArrayBuffer): BlackboxSegment[] {
  const bytes = new Uint8Array(buffer)
  const text = decodeLatin1(bytes)
  const starts = findSegmentStarts(text)

  if (starts.length === 0) {
    const header = parseHeaders(bytes)
    return [
      {
        index: 0,
        byteStart: 0,
        byteEnd: bytes.length,
        raw: bytes.slice(),
        header,
      },
    ]
  }

  return starts.map((byteStart, index) => {
    const byteEnd = starts[index + 1] ?? bytes.length
    const raw = bytes.slice(byteStart, byteEnd)

    return {
      index,
      byteStart,
      byteEnd,
      raw,
      header: parseHeaders(raw),
    }
  })
}

function findSegmentStarts(text: string): number[] {
  const starts: number[] = []

  collectMatchingStarts(text, PRIMARY_MARKER, starts)

  if (starts.length === 0) {
    collectMatchingStarts(text, GENERIC_MARKER, starts)
  }

  return [...new Set(starts)].sort((left, right) => left - right)
}

function collectMatchingStarts(text: string, marker: string, starts: number[]): void {
  let searchFrom = 0

  while (searchFrom < text.length) {
    const match = text.indexOf(marker, searchFrom)
    if (match < 0) {
      break
    }

    const versionWindow = text.slice(match, match + MARKER_SCAN_WINDOW)
    if (versionWindow.includes(VERSION_MARKER)) {
      starts.push(match)
    }

    searchFrom = match + marker.length
  }
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder('iso-8859-1').decode(bytes)
}
