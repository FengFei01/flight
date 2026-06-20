/// <reference lib="webworker" />

import { decodeSegment } from './decoder'
import type { FlightSample, ReplayBuildResult } from './types'
import { buildFlightTimeline } from '../flight/timeline'

const MAX_TIMELINE_SAMPLES = 6000
const MAX_DECODED_FRAMES = 12000
const MAX_SKIPPED_FRAMES = 3000
const MAX_DECODE_RUNTIME_MS = 1500

type WorkerRequest = {
  requestId: number
  segmentBytes: Uint8Array
}

type WorkerResponse = {
  requestId: number
  result?: ReplayBuildResult
  error?: string
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { requestId, segmentBytes } = event.data

  try {
    const decoded = decodeSegment(segmentBytes, {
      maxFrames: MAX_DECODED_FRAMES,
      maxRuntimeMs: MAX_DECODE_RUNTIME_MS,
      maxSkippedFrames: MAX_SKIPPED_FRAMES,
    })
    const timeline = buildFlightTimeline(decoded.frames)
    const samples = downsampleSamples(timeline, MAX_TIMELINE_SAMPLES)

    const result: ReplayBuildResult = {
      headers: decoded.headers,
      warnings: decoded.warnings,
      errors: decoded.errors,
      stats: decoded.stats,
      sampleCount: timeline.length,
      samples,
    }

    const response: WorkerResponse = { requestId, result }
    self.postMessage(response)
  } catch (error) {
    const response: WorkerResponse = {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }
    self.postMessage(response)
  }
}

function downsampleSamples(samples: FlightSample[], maxSamples: number): FlightSample[] {
  if (samples.length <= maxSamples) {
    return samples
  }

  const output: FlightSample[] = []
  const step = (samples.length - 1) / (maxSamples - 1)

  for (let index = 0; index < maxSamples; index += 1) {
    output.push(samples[Math.round(index * step)])
  }

  return output
}
