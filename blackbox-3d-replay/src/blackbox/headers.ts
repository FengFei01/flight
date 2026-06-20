import type { BlackboxHeaders } from './types'

const HEADER_FRAME_TYPES = ['I', 'P', 'G', 'H', 'S'] as const

export function parseHeaders(segmentBytes: Uint8Array): BlackboxHeaders {
  const headers: BlackboxHeaders = {
    fieldNames: {},
    fieldSigned: {},
    fieldPredictor: {},
    fieldEncoding: {},
    raw: {},
    headerEndOffset: 0,
  }

  for (const frameType of HEADER_FRAME_TYPES) {
    headers.fieldNames[frameType] = []
    headers.fieldSigned[frameType] = []
    headers.fieldPredictor[frameType] = []
    headers.fieldEncoding[frameType] = []
  }

  let offset = 0
  let sawHeader = false

  while (offset < segmentBytes.length) {
    const lineStart = offset

    while (offset < segmentBytes.length && segmentBytes[offset] !== 0x0a) {
      offset += 1
    }

    const lineEnd = offset > lineStart && segmentBytes[offset - 1] === 0x0d ? offset - 1 : offset
    const line = decodeLatin1(segmentBytes.subarray(lineStart, lineEnd))

    if (offset < segmentBytes.length && segmentBytes[offset] === 0x0a) {
      offset += 1
    }

    if (!line.startsWith('H ')) {
      headers.headerEndOffset = sawHeader ? lineStart : 0
      break
    }

    sawHeader = true
    headers.headerEndOffset = offset

    const separatorIndex = line.indexOf(':', 2)
    if (separatorIndex < 0) {
      continue
    }

    const key = line.slice(2, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    headers.raw[key] = value

    switch (key) {
      case 'Product':
        headers.product = value
        break
      case 'Data version':
        headers.dataVersion = parseNumber(value)
        break
      case 'Firmware revision':
      case 'Firmware version':
        headers.firmwareRevision = value
        break
      case 'Board information':
        headers.boardInfo = value
        break
      case 'Craft name':
        headers.craftName = value
        break
      case 'Firmware date':
        headers.firmwareDate = value
        break
      case 'Log start datetime':
      case 'Log start date':
        headers.logStartDate = value
        break
      case 'gyro_scale':
        headers.gyroScale = parseFloat(value)
        break
      case 'motorOutput': {
        const output = value
          .split(',')
          .map((item) => Number(item.trim()))
          .filter((item) => Number.isFinite(item))

        if (output.length >= 2) {
          headers.motorOutput = [output[0], output[1]]
        }
        break
      }
      default:
        parseFieldHeader(headers, key, value)
        break
    }
  }

  return headers
}

function parseFieldHeader(headers: BlackboxHeaders, key: string, value: string): void {
  const match = /^Field ([A-Z]) (name|signed|predictor|encoding)$/.exec(key)
  if (!match) {
    return
  }

  const [, frameType, kind] = match

  if (kind === 'name') {
    headers.fieldNames[frameType] = splitCommaList(value)
    return
  }

  const numbers = splitCommaNumbers(value)

  if (kind === 'signed') {
    headers.fieldSigned[frameType] = numbers
    return
  }

  if (kind === 'predictor') {
    headers.fieldPredictor[frameType] = numbers
    return
  }

  headers.fieldEncoding[frameType] = numbers
}

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitCommaNumbers(value: string): number[] {
  return value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item))
}

function parseNumber(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder('iso-8859-1').decode(bytes)
}
