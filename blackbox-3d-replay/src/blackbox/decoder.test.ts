import { describe, expect, it } from 'vitest'
import { decodeSegment } from './decoder'
import { BlackboxReader } from './reader'

describe('BlackboxReader', () => {
  it('decodes tag2_3S32 short form', () => {
    const reader = new BlackboxReader(Uint8Array.from([0x1c]))
    expect(reader.readTag2_3S32()).toEqual([1, -1, 0])
  })

  it('decodes tag8_8SVB grouped signed values', () => {
    const reader = new BlackboxReader(Uint8Array.from([0x05, ...encodeSignedVB(7), ...encodeSignedVB(-3)]))
    expect(reader.readTag8_8SVB(3).slice(0, 3)).toEqual([7, 0, -3])
  })
})

describe('decodeSegment', () => {
  it('decodes I/P/G/H/S frames and skips E frames without crashing', () => {
    const bytes = createSyntheticSegment()
    const result = decodeSegment(Uint8Array.from(bytes))

    expect(result.errors).toHaveLength(0)
    expect(result.frames.map((frame) => frame.frameType)).toEqual(['I', 'H', 'G', 'S', 'P', 'G'])
    expect(result.frames[0].values['gyroADC[0]']).toBe(120)
    expect(result.frames[4].time).toBe(1_002_000)
    expect(result.frames[4].values['gyroADC[0]']).toBe(125)
    expect(result.frames[2].values['GPS_coord[0]']).toBe(374221234)
  })
})

function createSyntheticSegment(): number[] {
  const headerLines = [
    'H Product:Blackbox flight data recorder by Betaflight',
    'H Data version:2',
    'H Firmware revision:Betaflight 4.5.0',
    'H Board information:STM32 TEST',
    'H Craft name:Bench Rig',
    'H gyro_scale:0.00106526',
    'H motorOutput:1000,2000',
    'H Field I name:time,gyroADC[0],gyroADC[1],gyroADC[2],accSmooth[0],accSmooth[1],accSmooth[2],baroAlt,motor[0],motor[1],motor[2],motor[3]',
    'H Field I signed:0,1,1,1,1,1,1,1,0,0,0,0',
    'H Field I predictor:0,0,0,0,0,0,0,0,0,0,0,0',
    'H Field I encoding:1,0,0,0,0,0,0,0,1,1,1,1',
    'H Field P predictor:10,1,1,1,1,1,1,1,1,1,1,1',
    'H Field P encoding:1,0,0,0,0,0,0,0,0,0,0,0',
    'H Field G name:GPS_numSat,GPS_coord[0],GPS_coord[1],GPS_altitude,GPS_speed,GPS_ground_course',
    'H Field G signed:0,1,1,1,0,0',
    'H Field G predictor:0,1,1,1,0,0',
    'H Field G encoding:1,0,0,0,1,1',
    'H Field H name:GPS_home[0],GPS_home[1]',
    'H Field H signed:1,1',
    'H Field H predictor:0,0',
    'H Field H encoding:0,0',
    'H Field S name:flightModeFlags,stateFlags',
    'H Field S signed:0,0',
    'H Field S predictor:0,0',
    'H Field S encoding:1,1',
    '',
  ]

  const bytes = [...new TextEncoder().encode(headerLines.join('\n'))]

  bytes.push(
    'I'.charCodeAt(0),
    ...encodeUnsignedVB(1_000_000),
    ...encodeSignedVB(120),
    ...encodeSignedVB(-80),
    ...encodeSignedVB(30),
    ...encodeSignedVB(0),
    ...encodeSignedVB(0),
    ...encodeSignedVB(1024),
    ...encodeSignedVB(5000),
    ...encodeUnsignedVB(1200),
    ...encodeUnsignedVB(1210),
    ...encodeUnsignedVB(1195),
    ...encodeUnsignedVB(1205),
  )

  bytes.push(
    'H'.charCodeAt(0),
    ...encodeSignedVB(374221200),
    ...encodeSignedVB(-1220845600),
  )

  bytes.push(
    'G'.charCodeAt(0),
    ...encodeUnsignedVB(10),
    ...encodeSignedVB(374221234),
    ...encodeSignedVB(-1220845678),
    ...encodeSignedVB(5200),
    ...encodeUnsignedVB(430),
    ...encodeUnsignedVB(900),
  )

  bytes.push(
    'S'.charCodeAt(0),
    ...encodeUnsignedVB(3),
    ...encodeUnsignedVB(1),
  )

  bytes.push(
    'P'.charCodeAt(0),
    ...encodeUnsignedVB(2000),
    ...encodeSignedVB(5),
    ...encodeSignedVB(-5),
    ...encodeSignedVB(0),
    ...encodeSignedVB(0),
    ...encodeSignedVB(0),
    ...encodeSignedVB(0),
    ...encodeSignedVB(25),
    ...encodeSignedVB(10),
    ...encodeSignedVB(10),
    ...encodeSignedVB(10),
    ...encodeSignedVB(10),
  )

  bytes.push(
    'G'.charCodeAt(0),
    ...encodeUnsignedVB(10),
    ...encodeSignedVB(12),
    ...encodeSignedVB(15),
    ...encodeSignedVB(10),
    ...encodeUnsignedVB(470),
    ...encodeUnsignedVB(920),
  )

  bytes.push(
    'E'.charCodeAt(0),
    255,
    ...new TextEncoder().encode('End of log\0'),
  )

  return bytes
}

function encodeUnsignedVB(value: number): number[] {
  const bytes: number[] = []
  let working = value >>> 0

  while (working >= 0x80) {
    bytes.push((working & 0x7f) | 0x80)
    working >>>= 7
  }

  bytes.push(working)
  return bytes
}

function encodeSignedVB(value: number): number[] {
  const zigzag = ((value << 1) ^ (value >> 31)) >>> 0
  return encodeUnsignedVB(zigzag)
}
