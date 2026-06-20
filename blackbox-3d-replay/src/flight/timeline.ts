import type { DecodedFrame, FlightSample, GpsHomePoint, GpsPoint } from '../blackbox/types'

export function buildFlightTimeline(frames: DecodedFrame[]): FlightSample[] {
  const mainFrames = frames
    .filter((frame) => frame.frameType === 'I' || frame.frameType === 'P')
    .sort((left, right) => left.time - right.time)

  if (mainFrames.length === 0) {
    return []
  }

  const firstTime = mainFrames[0].time
  const samples = mainFrames.map((frame) => mapMainFrame(frame, firstTime))
  const samplesByTime = samples.map((sample) => sample.t)

  let gpsHome: GpsHomePoint | undefined

  const sideFrames = frames
    .filter((frame) => !['I', 'P', 'E'].includes(frame.frameType))
    .sort((left, right) => left.time - right.time)

  for (const frame of sideFrames) {
    const sampleIndex = findNearestSampleIndex(samplesByTime, Math.max(0, (frame.time - firstTime) / 1_000_000))
    if (sampleIndex < 0) {
      continue
    }

    const sample = samples[sampleIndex]

    if (frame.frameType === 'H') {
      gpsHome = extractGpsHome(frame)
      if (gpsHome) {
        sample.gpsHome = gpsHome
      }
      continue
    }

    if (frame.frameType === 'G') {
      const gps = extractGps(frame)
      if (gps) {
        sample.gps = {
          ...sample.gps,
          ...gps,
        }
      }
      continue
    }

    if (frame.frameType === 'S') {
      mergeState(sample, frame)
    }
  }

  if (!gpsHome) {
    const firstGps = samples.find((sample) => sample.gps)
    if (firstGps?.gps) {
      gpsHome = {
        lat: firstGps.gps.lat,
        lon: firstGps.gps.lon,
        alt: firstGps.baroAlt ?? firstGps.gps.alt ?? 0,
      }
    }
  }

  if (gpsHome) {
    for (const sample of samples) {
      sample.gpsHome ??= gpsHome
    }
  }

  return samples.sort((left, right) => left.t - right.t)
}

function mapMainFrame(frame: DecodedFrame, firstTime: number): FlightSample {
  const sample: FlightSample = {
    t: Math.max(0, (frame.time - firstTime) / 1_000_000),
    gyro: readTriple(frame, 'gyroADC'),
    gyroUnfilt: readTriple(frame, 'gyroUnfilt'),
    acc: readTriple(frame, 'accSmooth'),
    baroAlt: normalizeAltitude(readNumber(frame, 'baroAlt')),
    rc: readArray(frame, 'rcCommand', 4),
    setpoint: readArray(frame, 'setpoint', 4),
    motor: readArray(frame, 'motor', 8),
    erpm: readArray(frame, 'eRPM', 8),
    flightModeFlags: readNumber(frame, 'flightModeFlags'),
    stateFlags: readNumber(frame, 'stateFlags'),
  }

  const gps = extractGps(frame)
  if (gps) {
    sample.gps = gps
  }

  return stripUndefined(sample)
}

function mergeState(sample: FlightSample, frame: DecodedFrame): void {
  const nextFlightMode = readNumber(frame, 'flightModeFlags')
  const nextStateFlags = readNumber(frame, 'stateFlags')

  if (nextFlightMode !== undefined) {
    sample.flightModeFlags = nextFlightMode
  }

  if (nextStateFlags !== undefined) {
    sample.stateFlags = nextStateFlags
  }
}

function extractGps(frame: DecodedFrame): GpsPoint | undefined {
  const latRaw = readNumber(frame, 'GPS_coord[0]')
  const lonRaw = readNumber(frame, 'GPS_coord[1]')

  if (latRaw === undefined || lonRaw === undefined) {
    return undefined
  }

  return stripUndefined({
    lat: latRaw / 1e7,
    lon: lonRaw / 1e7,
    alt: normalizeAltitude(readNumber(frame, 'GPS_altitude')),
    speed: normalizeSpeed(readNumber(frame, 'GPS_speed')),
    groundCourse: normalizeGroundCourse(readNumber(frame, 'GPS_ground_course')),
    numSat: readNumber(frame, 'GPS_numSat'),
  })
}

function extractGpsHome(frame: DecodedFrame): GpsHomePoint | undefined {
  const latRaw = readNumber(frame, 'GPS_home[0]')
  const lonRaw = readNumber(frame, 'GPS_home[1]')

  if (latRaw === undefined || lonRaw === undefined) {
    return undefined
  }

  return stripUndefined({
    lat: latRaw / 1e7,
    lon: lonRaw / 1e7,
  })
}

function readTriple(frame: DecodedFrame, prefix: string): [number, number, number] | undefined {
  const values = [0, 1, 2].map((index) => readNumber(frame, `${prefix}[${index}]`))
  return values.every((value) => typeof value === 'number')
    ? (values as [number, number, number])
    : undefined
}

function readArray(frame: DecodedFrame, prefix: string, maxLength: number): number[] | undefined {
  const values: number[] = []

  for (let index = 0; index < maxLength; index += 1) {
    const value = readNumber(frame, `${prefix}[${index}]`)
    if (value === undefined) {
      break
    }
    values.push(value)
  }

  return values.length > 0 ? values : undefined
}

function readNumber(frame: DecodedFrame, key: string): number | undefined {
  const value = frame.values[key]
  return typeof value === 'number' ? value : undefined
}

function normalizeAltitude(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  return Math.abs(value) > 1000 ? value / 100 : value
}

function normalizeSpeed(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  return value > 120 ? value / 100 : value
}

function normalizeGroundCourse(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  return value > 360 ? value / 10 : value
}

function findNearestSampleIndex(times: number[], target: number): number {
  if (times.length === 0) {
    return -1
  }

  let low = 0
  let high = times.length - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const value = times[mid]

    if (value === target) {
      return mid
    }

    if (value < target) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  if (low >= times.length) {
    return times.length - 1
  }

  if (high < 0) {
    return 0
  }

  return Math.abs(times[low] - target) < Math.abs(times[high] - target) ? low : high
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
