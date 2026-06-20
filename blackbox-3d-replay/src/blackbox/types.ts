export type FrameType = 'I' | 'P' | 'G' | 'H' | 'S' | 'E'

export type NumericRecord = Record<string, number | number[]>

export type LocalPosition = {
  x: number
  y: number
  z: number
}

export type GpsPoint = {
  lat: number
  lon: number
  alt?: number
  speed?: number
  groundCourse?: number
  numSat?: number
}

export type GpsHomePoint = {
  lat: number
  lon: number
  alt?: number
}

export type FlightSample = {
  t: number
  gyro?: [number, number, number]
  gyroUnfilt?: [number, number, number]
  acc?: [number, number, number]
  baroAlt?: number
  gps?: GpsPoint
  gpsHome?: GpsHomePoint
  rc?: number[]
  setpoint?: number[]
  motor?: number[]
  erpm?: number[]
  flightModeFlags?: number
  stateFlags?: number
}

export type ReplayFrame = {
  t: number
  position: LocalPosition
  euler: {
    roll: number
    pitch: number
    yaw: number
  }
  quaternion: {
    x: number
    y: number
    z: number
    w: number
  }
  telemetry: FlightSample
}

export type BlackboxHeaders = {
  product?: string
  dataVersion?: number
  firmwareRevision?: string
  boardInfo?: string
  craftName?: string
  firmwareDate?: string
  logStartDate?: string
  gyroScale?: number
  motorOutput?: [number, number]
  fieldNames: Record<string, string[]>
  fieldSigned: Record<string, number[]>
  fieldPredictor: Record<string, number[]>
  fieldEncoding: Record<string, number[]>
  raw: Record<string, string>
  headerEndOffset: number
}

export type BlackboxSegment = {
  index: number
  byteStart: number
  byteEnd: number
  raw: Uint8Array
  header: Partial<BlackboxHeaders>
}

export type FrameFieldDefinition = {
  frameType: FrameType
  names: string[]
  signed: number[]
  predictor: number[]
  encoding: number[]
  count: number
  nameToIndex: Record<string, number>
}

export type DecodedFrame = {
  frameType: string
  time: number
  values: NumericRecord
  byteOffset?: number
}

export type DecodeIssue = {
  offset: number
  frameType?: string
  message: string
}

export type DecodedSegmentResult = {
  headers: BlackboxHeaders
  frameDefs: Partial<Record<FrameType, FrameFieldDefinition>>
  frames: DecodedFrame[]
  warnings: DecodeIssue[]
  errors: DecodeIssue[]
  stats: {
    decodedFrames: number
    skippedFrames: number
    unsupportedEncodings: number
    monotonicityWarnings: number
  }
}

export type ReplayBuildResult = {
  headers: BlackboxHeaders
  warnings: DecodeIssue[]
  errors: DecodeIssue[]
  stats: DecodedSegmentResult['stats']
  sampleCount: number
  samples: FlightSample[]
}
