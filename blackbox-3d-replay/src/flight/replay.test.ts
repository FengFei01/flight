import { describe, expect, it } from 'vitest'
import type { DecodedFrame } from '../blackbox/types'
import { estimateAttitude } from './attitude'
import { gpsToLocalENU } from './coordinates'
import { buildFlightTimeline } from './timeline'

describe('gpsToLocalENU', () => {
  it('converts geographic coordinates to local ENU', () => {
    const point = gpsToLocalENU(37.4222, -122.084, 12, 37.4221, -122.0841, 10)
    expect(point.x).toBeGreaterThan(0)
    expect(point.y).toBeGreaterThan(0)
    expect(point.z).toBe(2)
  })
})

describe('timeline and replay', () => {
  it('merges GPS and state frames into the main IMU timeline', () => {
    const frames: DecodedFrame[] = [
      {
        frameType: 'I',
        time: 1_000_000,
        values: {
          time: 1_000_000,
          'gyroADC[0]': 120,
          'gyroADC[1]': -80,
          'gyroADC[2]': 30,
          'accSmooth[0]': 0,
          'accSmooth[1]': 0,
          'accSmooth[2]': 1024,
          baroAlt: 5000,
          'motor[0]': 1200,
          'motor[1]': 1200,
          'motor[2]': 1200,
          'motor[3]': 1200,
        },
      },
      {
        frameType: 'H',
        time: 1_000_000,
        values: {
          'GPS_home[0]': 374221200,
          'GPS_home[1]': -1220845600,
        },
      },
      {
        frameType: 'G',
        time: 1_000_000,
        values: {
          GPS_numSat: 10,
          'GPS_coord[0]': 374221234,
          'GPS_coord[1]': -1220845678,
          GPS_altitude: 5200,
          GPS_speed: 430,
          GPS_ground_course: 900,
        },
      },
      {
        frameType: 'P',
        time: 1_002_000,
        values: {
          time: 1_002_000,
          'gyroADC[0]': 125,
          'gyroADC[1]': -85,
          'gyroADC[2]': 30,
          'accSmooth[0]': 0,
          'accSmooth[1]': 0,
          'accSmooth[2]': 1024,
          baroAlt: 5025,
          'motor[0]': 1210,
          'motor[1]': 1210,
          'motor[2]': 1210,
          'motor[3]': 1210,
        },
      },
      {
        frameType: 'S',
        time: 1_002_000,
        values: {
          flightModeFlags: 3,
          stateFlags: 1,
        },
      },
    ]

    const samples = buildFlightTimeline(frames)
    const replay = estimateAttitude(samples)

    expect(samples).toHaveLength(2)
    expect(samples[0].t).toBe(0)
    expect(samples[0].gps?.lat).toBeCloseTo(37.4221234, 6)
    expect(samples[1].flightModeFlags).toBe(3)
    expect(replay).toHaveLength(2)
    expect(replay[0].position.z).toBeCloseTo(0, 3)
    expect(replay[0].telemetry.gpsHome?.lat).toBeCloseTo(37.42212, 5)
  })
})
