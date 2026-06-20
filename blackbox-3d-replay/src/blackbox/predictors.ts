import type { FrameFieldDefinition } from './types'

export const FIELD_PREDICTOR = {
  ZERO: 0,
  PREVIOUS: 1,
  STRAIGHT_LINE: 2,
  AVERAGE_2: 3,
  MINTHROTTLE: 4,
  MOTOR_0: 5,
  INC: 6,
  HOME_COORD: 7,
  P1500: 8,
  VBATREF: 9,
  LAST_MAIN_FRAME_TIME: 10,
  MINMOTOR: 11,
  HOME_COORD_1: 256,
} as const

type PredictorContext = {
  current: number[]
  previous: number[] | null
  previous2: number[] | null
  frameDef: FrameFieldDefinition
  mainFrameDef?: FrameFieldDefinition
  sysConfig: {
    minthrottle: number
    minMotor: number
    vbatref: number
  }
  gpsHomeValues?: number[] | null
  lastMainValues?: number[] | null
}

export function normalizePredictors(
  frameType: string,
  predictors: number[],
  names: string[],
): number[] {
  const normalized = [...predictors]
  let homeCoordSeen = 0

  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] !== FIELD_PREDICTOR.HOME_COORD) {
      continue
    }

    const name = names[index] ?? ''

    if (name.endsWith('[1]')) {
      normalized[index] = FIELD_PREDICTOR.HOME_COORD_1
      continue
    }

    if (frameType === 'G' || frameType === 'H') {
      if (homeCoordSeen > 0) {
        normalized[index] = FIELD_PREDICTOR.HOME_COORD_1
      }
      homeCoordSeen += 1
    }
  }

  return normalized
}

export function applyPredictor(
  predictor: number,
  rawValue: number,
  fieldIndex: number,
  context: PredictorContext,
): number {
  const value = coerceSigned32(rawValue)

  switch (predictor) {
    case FIELD_PREDICTOR.ZERO:
      return value
    case FIELD_PREDICTOR.MINTHROTTLE:
      return value + context.sysConfig.minthrottle
    case FIELD_PREDICTOR.MINMOTOR:
      return value + context.sysConfig.minMotor
    case FIELD_PREDICTOR.P1500:
      return value + 1500
    case FIELD_PREDICTOR.MOTOR_0: {
      const motor0Index =
        context.mainFrameDef?.nameToIndex['motor[0]'] ??
        context.frameDef.nameToIndex['motor[0]']

      if (motor0Index === undefined) {
        return value
      }

      return value + (context.current[motor0Index] ?? context.previous?.[motor0Index] ?? 0)
    }
    case FIELD_PREDICTOR.VBATREF:
      return value + context.sysConfig.vbatref
    case FIELD_PREDICTOR.PREVIOUS:
      return value + (context.previous?.[fieldIndex] ?? 0)
    case FIELD_PREDICTOR.STRAIGHT_LINE:
      if (!context.previous || !context.previous2) {
        return value + (context.previous?.[fieldIndex] ?? 0)
      }
      return value + 2 * context.previous[fieldIndex] - context.previous2[fieldIndex]
    case FIELD_PREDICTOR.AVERAGE_2:
      if (!context.previous || !context.previous2) {
        return value + (context.previous?.[fieldIndex] ?? 0)
      }
      return value + Math.trunc((context.previous[fieldIndex] + context.previous2[fieldIndex]) / 2)
    case FIELD_PREDICTOR.HOME_COORD:
      return value + (context.gpsHomeValues?.[0] ?? 0)
    case FIELD_PREDICTOR.HOME_COORD_1:
      return value + (context.gpsHomeValues?.[1] ?? 0)
    case FIELD_PREDICTOR.LAST_MAIN_FRAME_TIME: {
      const timeIndex = context.mainFrameDef?.nameToIndex.time ?? context.frameDef.nameToIndex.time
      return value + (timeIndex === undefined ? 0 : context.lastMainValues?.[timeIndex] ?? 0)
    }
    default:
      return value
  }
}

function coerceSigned32(value: number): number {
  return value > 0x7fffffff ? value - 0x100000000 : value
}
