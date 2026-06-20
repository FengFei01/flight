import { FIELD_ENCODING, FIELD_ENCODING_NAME, signExtend14Bit } from './encoders'
import { parseHeaders } from './headers'
import { FIELD_PREDICTOR, applyPredictor, normalizePredictors } from './predictors'
import { BlackboxReader } from './reader'
import type {
  BlackboxHeaders,
  DecodedFrame,
  DecodedSegmentResult,
  DecodeIssue,
  FrameFieldDefinition,
  FrameType,
  NumericRecord,
} from './types'

const MAIN_FRAME_TYPES: FrameType[] = ['I', 'P']
const FRAME_MARKERS = new Set<number>(['I', 'P', 'G', 'H', 'S', 'E'].map((type) => type.charCodeAt(0)))
const TIME_CHECK_INTERVAL = 1000
const MAX_STORED_ISSUES = 200
const EVENT_TYPES = {
  SYNC_BEEP: 0,
  AUTOTUNE_CYCLE_START: 10,
  AUTOTUNE_CYCLE_RESULT: 11,
  AUTOTUNE_TARGETS: 12,
  INFLIGHT_ADJUSTMENT: 13,
  LOGGING_RESUME: 14,
  DISARM: 15,
  GTUNE_CYCLE_RESULT: 20,
  FLIGHT_MODE: 30,
  TWITCH_TEST: 40,
  LOG_END: 255,
} as const

type DecodeState = {
  headers: BlackboxHeaders
  frameDefs: Partial<Record<FrameType, FrameFieldDefinition>>
  warnings: DecodeIssue[]
  errors: DecodeIssue[]
  stats: DecodedSegmentResult['stats']
  mainValues: number[] | null
  mainValues2: number[] | null
  gpsValues: number[] | null
  gpsHomeValues: number[] | null
  slowValues: number[] | null
  lastMainTime: number
  lastFrameTime: number
}

type DecodeOptions = {
  maxFrames?: number
  maxRuntimeMs?: number
  maxSkippedFrames?: number
}

export function decodeSegment(
  segmentBytes: Uint8Array,
  options: DecodeOptions = {},
): DecodedSegmentResult {
  const headers = parseHeaders(segmentBytes)
  const frameDefs = buildFrameDefinitions(headers)
  const reader = new BlackboxReader(segmentBytes, headers.headerEndOffset)
  const frames: DecodedFrame[] = []
  const decodeStart = performance.now()
  const maxFrames = options.maxFrames ?? Number.POSITIVE_INFINITY
  const maxRuntimeMs = options.maxRuntimeMs ?? Number.POSITIVE_INFINITY
  const maxSkippedFrames = options.maxSkippedFrames ?? Number.POSITIVE_INFINITY

  const state: DecodeState = {
    headers,
    frameDefs,
    warnings: [],
    errors: [],
    stats: {
      decodedFrames: 0,
      skippedFrames: 0,
      unsupportedEncodings: 0,
      monotonicityWarnings: 0,
    },
    mainValues: null,
    mainValues2: null,
    gpsValues: null,
    gpsHomeValues: null,
    slowValues: null,
    lastMainTime: 0,
    lastFrameTime: Number.NEGATIVE_INFINITY,
  }

  while (!reader.eof) {
    if (state.stats.decodedFrames >= maxFrames) {
      state.warnings.push({
        offset: reader.offset,
        message: `Decode capped at ${maxFrames} frames for responsive playback`,
      })
      trimIssueBuffer(state.warnings)
      break
    }

    if (state.stats.skippedFrames >= maxSkippedFrames) {
      state.warnings.push({
        offset: reader.offset,
        message: `Stopped after ${maxSkippedFrames} skipped frames while recovering from parse errors`,
      })
      trimIssueBuffer(state.warnings)
      break
    }

    if (performance.now() - decodeStart >= maxRuntimeMs) {
      state.warnings.push({
        offset: reader.offset,
        message: `Decode timed out after ${Math.round(maxRuntimeMs)}ms; using partial results`,
      })
      trimIssueBuffer(state.warnings)
      break
    }

    const frameStart = reader.offset
    const marker = reader.readByte()

    if (!FRAME_MARKERS.has(marker)) {
      const recovered = recoverNextFrameOffset(segmentBytes, frameStart + 1)
      state.warnings.push({
        offset: frameStart,
        message: `Unexpected byte 0x${marker.toString(16)} while searching for frame marker`,
      })
      trimIssueBuffer(state.warnings)
      state.stats.skippedFrames += 1

      if (recovered < 0) {
        break
      }

      reader.offset = recovered
      continue
    }

    const frameType = String.fromCharCode(marker) as FrameType

    try {
      if (frameType === 'E') {
        skipEventFrame(reader, state)
        continue
      }

      const decoded = decodeFrame(reader, frameType, state, frameStart)
      if (!decoded) {
        continue
      }

      frames.push(decoded)
      state.stats.decodedFrames += 1
      state.lastFrameTime = decoded.time

      if (state.stats.decodedFrames % TIME_CHECK_INTERVAL === 0) {
        checkTimelineMonotonicity(frames, state)
      }
    } catch (error) {
      const recovered = recoverNextFrameOffset(segmentBytes, frameStart + 1)
      state.errors.push({
        offset: frameStart,
        frameType,
        message: error instanceof Error ? error.message : String(error),
      })
      trimIssueBuffer(state.errors)
      state.stats.skippedFrames += 1

      if (recovered < 0) {
        break
      }

      reader.offset = recovered
    }
  }

  return {
    headers,
    frameDefs,
    frames,
    warnings: state.warnings,
    errors: state.errors,
    stats: state.stats,
  }
}

function buildFrameDefinitions(
  headers: BlackboxHeaders,
): Partial<Record<FrameType, FrameFieldDefinition>> {
  const definitions: Partial<Record<FrameType, FrameFieldDefinition>> = {}
  const allTypes: FrameType[] = ['I', 'P', 'G', 'H', 'S']

  for (const frameType of allTypes) {
    const names =
      frameType === 'P'
        ? headers.fieldNames.P?.length
          ? headers.fieldNames.P
          : headers.fieldNames.I ?? []
        : headers.fieldNames[frameType] ?? []

    const signed =
      frameType === 'P'
        ? headers.fieldSigned.P?.length
          ? headers.fieldSigned.P
          : headers.fieldSigned.I ?? []
        : headers.fieldSigned[frameType] ?? []

    const predictor = normalizePredictors(
      frameType,
      frameType === 'P'
        ? headers.fieldPredictor.P?.length
          ? headers.fieldPredictor.P
          : headers.fieldPredictor.I ?? []
        : headers.fieldPredictor[frameType] ?? [],
      names,
    )

    const encoding =
      frameType === 'P'
        ? headers.fieldEncoding.P?.length
          ? headers.fieldEncoding.P
          : headers.fieldEncoding.I ?? []
        : headers.fieldEncoding[frameType] ?? []

    const count =
      frameType === 'P'
        ? names.length
        : Math.max(names.length, signed.length, predictor.length, encoding.length)

    if (count === 0) {
      continue
    }

    const resolvedNames = names.length ? names : new Array(count).fill('').map((_, index) => `${frameType}_${index}`)

    definitions[frameType] = {
      frameType,
      names: resolvedNames,
      signed: fillWithFallback(signed, count, 0),
      predictor: fillWithFallback(predictor, count, 0),
      encoding: fillWithFallback(encoding, count, FIELD_ENCODING.SIGNED_VB),
      count,
      nameToIndex: resolvedNames.reduce<Record<string, number>>((acc, name, index) => {
        acc[name] = index
        return acc
      }, {}),
    }
  }

  return definitions
}

function decodeFrame(
  reader: BlackboxReader,
  frameType: Exclude<FrameType, 'E'>,
  state: DecodeState,
  frameStart: number,
): DecodedFrame | null {
  const frameDef = state.frameDefs[frameType]

  if (!frameDef) {
    state.warnings.push({
      offset: frameStart,
      frameType,
      message: `Missing header definition for frame type ${frameType}`,
    })
    trimIssueBuffer(state.warnings)
    return null
  }

  const previous = getPreviousValues(frameType, state)
  const previous2 = frameType === 'P' || frameType === 'I' ? state.mainValues2 : null
  const current = new Array(frameDef.count).fill(0)
  const valuesScratch = new Array<number>(8).fill(0)

  let index = 0

  while (index < frameDef.count) {
    const predictor = frameDef.predictor[index] ?? 0

    if (predictor === FIELD_PREDICTOR.INC) {
      current[index] = (previous?.[index] ?? 0) + 1
      index += 1
      continue
    }

    const encoding = frameDef.encoding[index]
    const predictionContext = {
      current,
      previous,
      previous2,
      frameDef,
      mainFrameDef: state.frameDefs.I,
      sysConfig: {
        minthrottle: Number(state.headers.raw.minthrottle ?? 1150),
        minMotor: Number(state.headers.motorOutput?.[0] ?? 1000),
        vbatref: Number(state.headers.raw.vbatref ?? 0),
      },
      gpsHomeValues: state.gpsHomeValues,
      lastMainValues: state.mainValues,
    }

    switch (encoding) {
      case FIELD_ENCODING.SIGNED_VB: {
        const rawValue = reader.readSignedVB()
        current[index] = applyPredictor(predictor, rawValue, index, predictionContext)
        index += 1
        break
      }
      case FIELD_ENCODING.UNSIGNED_VB: {
        const rawValue = reader.readUnsignedVB()
        current[index] = applyPredictor(predictor, rawValue, index, predictionContext)
        index += 1
        break
      }
      case FIELD_ENCODING.NEG_14BIT: {
        const rawValue = -signExtend14Bit(reader.readUnsignedVB())
        current[index] = applyPredictor(predictor, rawValue, index, predictionContext)
        index += 1
        break
      }
      case FIELD_ENCODING.TAG8_4S16: {
        reader.readTag8_4S16(state.headers.dataVersion ?? 2, valuesScratch)
        index = applyGroupValues(current, frameDef, index, 4, valuesScratch, predictionContext)
        break
      }
      case FIELD_ENCODING.TAG2_3S32: {
        reader.readTag2_3S32(valuesScratch)
        index = applyGroupValues(current, frameDef, index, 3, valuesScratch, predictionContext)
        break
      }
      case FIELD_ENCODING.TAG2_3SVARIABLE: {
        reader.readTag2_3SVariable(valuesScratch)
        index = applyGroupValues(current, frameDef, index, 3, valuesScratch, predictionContext)
        break
      }
      case FIELD_ENCODING.TAG8_8SVB: {
        const groupCount = countEncodingRun(frameDef.encoding, index, FIELD_ENCODING.TAG8_8SVB, 8)
        reader.readTag8_8SVB(groupCount, valuesScratch)
        index = applyGroupValues(current, frameDef, index, groupCount, valuesScratch, predictionContext)
        break
      }
      case FIELD_ENCODING.NULL:
        current[index] = applyPredictor(predictor, 0, index, predictionContext)
        index += 1
        break
      default:
        state.stats.unsupportedEncodings += 1
        throw new Error(
          `Unsupported encoding ${encoding} (${FIELD_ENCODING_NAME[encoding] ?? 'unknown'}) for ${frameType}:${frameDef.names[index]}`,
        )
    }
  }

  const values = projectNamedValues(frameDef, current)
  const time = resolveFrameTime(frameType, values, state.lastMainTime)

  updateStateHistory(frameType, current, time, state)

  return {
    frameType,
    time,
    values,
    byteOffset: frameStart,
  }
}

function applyGroupValues(
  current: number[],
  frameDef: FrameFieldDefinition,
  startIndex: number,
  count: number,
  scratch: number[],
  predictionContext: Parameters<typeof applyPredictor>[3],
): number {
  let index = startIndex

  for (let groupIndex = 0; groupIndex < count && index < frameDef.count; groupIndex += 1, index += 1) {
    const predictor = frameDef.predictor[index] ?? 0
    current[index] = applyPredictor(predictor, scratch[groupIndex] ?? 0, index, predictionContext)
  }

  return index
}

function countEncodingRun(values: number[], startIndex: number, encoding: number, maxRun: number): number {
  let length = 1

  while (length < maxRun && startIndex + length < values.length && values[startIndex + length] === encoding) {
    length += 1
  }

  return length
}

function projectNamedValues(frameDef: FrameFieldDefinition, values: number[]): NumericRecord {
  const record: NumericRecord = {}

  for (let index = 0; index < frameDef.count; index += 1) {
    record[frameDef.names[index]] = values[index]
  }

  return record
}

function resolveFrameTime(frameType: string, values: NumericRecord, lastMainTime: number): number {
  const timeValue = values.time
  if (typeof timeValue === 'number') {
    return timeValue
  }

  if (MAIN_FRAME_TYPES.includes(frameType as FrameType)) {
    return lastMainTime
  }

  return lastMainTime
}

function getPreviousValues(frameType: FrameType, state: DecodeState): number[] | null {
  switch (frameType) {
    case 'I':
    case 'P':
      return state.mainValues
    case 'G':
      return state.gpsValues
    case 'H':
      return state.gpsHomeValues
    case 'S':
      return state.slowValues
    default:
      return null
  }
}

function updateStateHistory(frameType: FrameType, current: number[], time: number, state: DecodeState): void {
  switch (frameType) {
    case 'I':
    case 'P':
      state.mainValues2 = state.mainValues ? [...state.mainValues] : null
      state.mainValues = [...current]
      state.lastMainTime = time
      break
    case 'G':
      state.gpsValues = [...current]
      break
    case 'H':
      state.gpsHomeValues = [...current]
      break
    case 'S':
      state.slowValues = [...current]
      break
    default:
      break
  }
}

function skipEventFrame(reader: BlackboxReader, state: DecodeState): void {
  const eventType = reader.readByte()

  switch (eventType) {
    case EVENT_TYPES.SYNC_BEEP:
      reader.readUnsignedVB()
      break
    case EVENT_TYPES.FLIGHT_MODE:
      reader.readUnsignedVB()
      reader.readUnsignedVB()
      break
    case EVENT_TYPES.DISARM:
      reader.readUnsignedVB()
      break
    case EVENT_TYPES.AUTOTUNE_CYCLE_START:
      reader.readByte()
      reader.readByte()
      reader.readByte()
      reader.readByte()
      reader.readByte()
      break
    case EVENT_TYPES.AUTOTUNE_CYCLE_RESULT:
      reader.readByte()
      reader.readByte()
      reader.readByte()
      reader.readByte()
      break
    case EVENT_TYPES.AUTOTUNE_TARGETS:
      reader.readS16()
      reader.readS8()
      reader.readS8()
      reader.readS16()
      reader.readS16()
      break
    case EVENT_TYPES.GTUNE_CYCLE_RESULT:
      reader.readByte()
      reader.readSignedVB()
      reader.readS16()
      break
    case EVENT_TYPES.INFLIGHT_ADJUSTMENT: {
      const flag = reader.readByte()
      if (flag < 128) {
        reader.readSignedVB()
      } else {
        reader.readU32()
      }
      break
    }
    case EVENT_TYPES.TWITCH_TEST:
      reader.readByte()
      reader.readU32()
      break
    case EVENT_TYPES.LOGGING_RESUME:
      reader.readUnsignedVB()
      reader.readUnsignedVB()
      break
    case EVENT_TYPES.LOG_END:
      reader.readString('End of log\0'.length)
      break
    default:
      state.warnings.push({
        offset: reader.offset - 2,
        frameType: 'E',
        message: `Unknown event type ${eventType}, attempting to recover`,
      })
      trimIssueBuffer(state.warnings)
      break
  }
}

function recoverNextFrameOffset(bytes: Uint8Array, startIndex: number): number {
  for (let index = startIndex; index < bytes.length; index += 1) {
    if (FRAME_MARKERS.has(bytes[index])) {
      return index
    }
  }

  return -1
}

function checkTimelineMonotonicity(frames: DecodedFrame[], state: DecodeState): void {
  const windowStart = Math.max(0, frames.length - TIME_CHECK_INTERVAL)

  for (let index = windowStart + 1; index < frames.length; index += 1) {
    if (frames[index].time < frames[index - 1].time) {
      state.stats.monotonicityWarnings += 1
      state.warnings.push({
        offset: frames[index].byteOffset ?? 0,
        frameType: frames[index].frameType,
        message: 'Frame time regressed inside the last 1000-frame window',
      })
      trimIssueBuffer(state.warnings)
      return
    }
  }
}

function fillWithFallback(values: number[], count: number, fallback: number): number[] {
  return new Array(count).fill(fallback).map((item, index) => values[index] ?? item)
}

function trimIssueBuffer(issues: DecodeIssue[]): void {
  if (issues.length <= MAX_STORED_ISSUES) {
    return
  }

  issues.splice(MAX_STORED_ISSUES)
}
