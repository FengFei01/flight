import type { FlightSample, ReplayFrame } from '../blackbox/types'
import { estimateAttitude, ATTITUDE_CONFIG } from './attitude'

export function buildReplayFrames(
  samples: FlightSample[],
  gyroScale = ATTITUDE_CONFIG.gyroScale,
): ReplayFrame[] {
  return estimateAttitude(samples, {
    ...ATTITUDE_CONFIG,
    gyroScale,
  })
}
