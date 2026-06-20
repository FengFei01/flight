import { describe, expect, it } from 'vitest'
import { parseHeaders } from './headers'
import { splitLogSegments } from './segment'

describe('splitLogSegments', () => {
  it('detects multiple log segments from repeated text headers', () => {
    const segmentA = `H Product:Blackbox flight data recorder by Betaflight\nH Data version:2\nH Craft name:Alpha\nI\x01\x02\x03`
    const segmentB = `H Product:Blackbox flight data recorder by Betaflight\nH Data version:2\nH Craft name:Bravo\nP\x04\x05\x06`
    const text = `${segmentA}${segmentB}`
    const buffer = new TextEncoder().encode(text).buffer

    const segments = splitLogSegments(buffer)

    expect(segments).toHaveLength(2)
    expect(segments[0].header.craftName).toBe('Alpha')
    expect(segments[1].header.craftName).toBe('Bravo')
    expect(segments[0].byteStart).toBe(0)
    expect(segments[1].byteStart).toBeGreaterThan(segments[0].byteEnd - 4)
  })
})

describe('parseHeaders', () => {
  it('parses field descriptors and header end offset', () => {
    const headerText = [
      'H Product:Blackbox flight data recorder by Betaflight',
      'H Data version:2',
      'H Firmware revision:Betaflight 4.5.0',
      'H Board information:STM32 TEST',
      'H Craft name:Bench Rig',
      'H Field I name:time,gyroADC[0],gyroADC[1],gyroADC[2]',
      'H Field I signed:0,1,1,1',
      'H Field I predictor:0,0,0,0',
      'H Field I encoding:1,0,0,0',
      'I',
    ].join('\n')

    const headers = parseHeaders(new TextEncoder().encode(headerText))

    expect(headers.product).toContain('Betaflight')
    expect(headers.dataVersion).toBe(2)
    expect(headers.boardInfo).toBe('STM32 TEST')
    expect(headers.fieldNames.I).toEqual(['time', 'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]'])
    expect(headers.fieldSigned.I).toEqual([0, 1, 1, 1])
    expect(headers.fieldEncoding.I).toEqual([1, 0, 0, 0])
    expect(headers.headerEndOffset).toBeGreaterThan(0)
  })
})
