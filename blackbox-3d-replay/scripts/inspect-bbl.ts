import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { decodeSegment } from '../src/blackbox/decoder'
import { splitLogSegments } from '../src/blackbox/segment'
import { buildReplayFrames } from '../src/flight/replay'
import { buildFlightTimeline } from '../src/flight/timeline'

const targetPath = process.argv[2]

if (!targetPath) {
  console.error('Usage: npm exec tsx scripts/inspect-bbl.ts /path/to/file.bbl')
  process.exit(1)
}

const absolutePath = resolve(targetPath)

console.log(`Inspecting ${basename(absolutePath)}`)
const fileStart = performance.now()
const buffer = readFileSync(absolutePath)
const fileReadMs = performance.now() - fileStart

const segmentStart = performance.now()
const segments = splitLogSegments(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
)
const segmentMs = performance.now() - segmentStart

console.log(`fileSize=${buffer.byteLength} bytes readMs=${fileReadMs.toFixed(1)} splitMs=${segmentMs.toFixed(1)}`)
console.log(`segments=${segments.length}`)

segments.forEach((segment) => {
  const decodeStart = performance.now()
  const decoded = decodeSegment(segment.raw)
  const decodeMs = performance.now() - decodeStart

  const timelineStart = performance.now()
  const samples = buildFlightTimeline(decoded.frames)
  const timelineMs = performance.now() - timelineStart

  const replayStart = performance.now()
  const replay = buildReplayFrames(samples)
  const replayMs = performance.now() - replayStart

  const gpsFrames = replay.filter((frame) => frame.telemetry.gps).length
  const duration = replay[replay.length - 1]?.t ?? 0

  console.log(`segment=${segment.index + 1}`)
  console.log(
    [
      `bytes=${segment.byteStart}-${segment.byteEnd}`,
      `craft=${segment.header.craftName ?? 'n/a'}`,
      `firmware=${segment.header.firmwareRevision ?? 'n/a'}`,
      `decodeMs=${decodeMs.toFixed(1)}`,
      `timelineMs=${timelineMs.toFixed(1)}`,
      `replayMs=${replayMs.toFixed(1)}`,
    ].join(' '),
  )
  console.log(
    [
      `decodedFrames=${decoded.stats.decodedFrames}`,
      `warnings=${decoded.warnings.length}`,
      `errors=${decoded.errors.length}`,
      `samples=${samples.length}`,
      `replayFrames=${replay.length}`,
      `gpsFrames=${gpsFrames}`,
      `durationSec=${duration.toFixed(2)}`,
    ].join(' '),
  )

  if (decoded.errors.length) {
    const first = decoded.errors[0]
    console.log(`firstError offset=${first.offset} frame=${first.frameType ?? 'n/a'} msg=${first.message}`)
  }

  if (decoded.warnings.length) {
    const first = decoded.warnings[0]
    console.log(`firstWarning offset=${first.offset} frame=${first.frameType ?? 'n/a'} msg=${first.message}`)
  }
})
