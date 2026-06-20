import { useEffect, useMemo, useRef, useState } from 'react'
import { splitLogSegments } from './blackbox/segment'
import type { BlackboxSegment, ReplayBuildResult, ReplayFrame } from './blackbox/types'
import { buildReplayFrames } from './flight/replay'
import { FlightScene } from './render/FlightScene'
import { FilePicker } from './ui/FilePicker'
import { ReplayControls } from './ui/ReplayControls'
import { SegmentSelector } from './ui/SegmentSelector'
import { TelemetryPanel } from './ui/TelemetryPanel'
import './App.css'

type FileState = {
  name: string
  size: number
}

function App() {
  const [fileState, setFileState] = useState<FileState | null>(null)
  const [segments, setSegments] = useState<BlackboxSegment[]>([])
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState(0)
  const [decodeResult, setDecodeResult] = useState<ReplayBuildResult | null>(null)
  const [replayFrames, setReplayFrames] = useState<ReplayFrame[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [playheadTime, setPlayheadTime] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [gyroScale, setGyroScale] = useState(1)
  const [isDecoding, setIsDecoding] = useState(false)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [loadedSegmentIndex, setLoadedSegmentIndex] = useState<number | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    const worker = new Worker(new URL('./blackbox/replay.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<{ requestId: number; result?: ReplayBuildResult; error?: string }>) => {
      if (event.data.requestId !== requestIdRef.current) {
        return
      }

      setIsDecoding(false)

      if (event.data.error) {
        setDecodeError(event.data.error)
        setDecodeResult(null)
        return
      }

      setDecodeError(null)
      setDecodeResult(event.data.result ?? null)
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!segments.length) {
      setDecodeResult(null)
      setDecodeError(null)
      setIsDecoding(false)
      setLoadedSegmentIndex(null)
      return
    }
  }, [segments])

  useEffect(() => {
    if (loadedSegmentIndex === null || !segments.length) {
      return
    }

    const activeSegment = segments[loadedSegmentIndex] ?? segments[0]
    requestIdRef.current += 1
    setIsDecoding(true)
    setDecodeError(null)
    workerRef.current?.postMessage({
      requestId: requestIdRef.current,
      segmentBytes: activeSegment.raw,
    })
    setPlayheadTime(0)
    setIsPlaying(false)
  }, [loadedSegmentIndex, segments])

  useEffect(() => {
    if (!decodeResult) {
      setReplayFrames([])
      return
    }

    const nextReplayFrames = buildReplayFrames(decodeResult.samples, gyroScale)
    setReplayFrames(nextReplayFrames)
    setPlayheadTime(0)
  }, [decodeResult, gyroScale])

  useEffect(() => {
    if (!isPlaying || replayFrames.length < 2) {
      return
    }

    let frameHandle = 0
    let lastTimestamp = 0
    const duration = replayFrames[replayFrames.length - 1]?.t ?? 0

    const tick = (timestamp: number) => {
      if (lastTimestamp === 0) {
        lastTimestamp = timestamp
      }

      const deltaSeconds = ((timestamp - lastTimestamp) / 1000) * playbackRate
      lastTimestamp = timestamp

      setPlayheadTime((current) => {
        const next = current + deltaSeconds
        if (next >= duration) {
          setIsPlaying(false)
          return duration
        }
        return next
      })

      frameHandle = window.requestAnimationFrame(tick)
    }

    frameHandle = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameHandle)
  }, [isPlaying, playbackRate, replayFrames])

  const duration = replayFrames[replayFrames.length - 1]?.t ?? 0
  const playbackDisabled = isDecoding || replayFrames.length < 2
  const playLabel = isDecoding ? 'Decoding...' : isPlaying ? 'Pause' : 'Play'
  const currentFrameIndex = useMemo(
    () => findFrameIndexByTime(replayFrames, playheadTime),
    [replayFrames, playheadTime],
  )
  const currentFrame = replayFrames[currentFrameIndex]

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Betaflight Blackbox 3D Replay</h1>
          <p>
            Decode `.bbl` in the browser, split log segments, rebuild timeline, and play the
            aircraft path with attitude.
          </p>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-panel">
          <FilePicker
            fileName={fileState?.name}
            fileSize={fileState?.size}
            onPick={async (file) => {
              const buffer = await file.arrayBuffer()
              const nextSegments = splitLogSegments(buffer)
              setFileState({ name: file.name, size: file.size })
              setSegments(nextSegments)
              setSelectedSegmentIndex(0)
              setLoadedSegmentIndex(null)
              setDecodeResult(null)
              setReplayFrames([])
              setDecodeError(null)
            }}
          />

          {segments.length > 0 ? (
            <SegmentSelector
              segments={segments}
              selectedIndex={selectedSegmentIndex}
              onLoad={() => setLoadedSegmentIndex(selectedSegmentIndex)}
              isLoading={isDecoding}
              canLoad={segments.length > 0}
              onSelect={setSelectedSegmentIndex}
            />
          ) : null}

          <section className="panel-section">
            <div className="section-heading">
              <h2>Status</h2>
            </div>

            <dl className="key-grid compact">
              <div>
                <dt>Segments</dt>
                <dd>{segments.length || 'n/a'}</dd>
              </div>
              <div>
                <dt>Current</dt>
                <dd>{segments.length ? selectedSegmentIndex + 1 : 'n/a'}</dd>
              </div>
              <div>
                <dt>Loaded</dt>
                <dd>{loadedSegmentIndex === null ? 'none' : loadedSegmentIndex + 1}</dd>
              </div>
              <div>
                <dt>Decoded Frames</dt>
                <dd>{decodeResult?.stats.decodedFrames ?? 0}</dd>
              </div>
              <div>
                <dt>Timeline Samples</dt>
                <dd>{decodeResult?.sampleCount ?? 0}</dd>
              </div>
              <div>
                <dt>Replay Frames</dt>
                <dd>{replayFrames.length}</dd>
              </div>
              <div>
                <dt>Decoding</dt>
                <dd>{isDecoding ? 'running' : 'idle'}</dd>
              </div>
              <div>
                <dt>GPS</dt>
                <dd>{replayFrames.some((frame) => frame.telemetry.gps) ? 'available' : 'none'}</dd>
              </div>
              <div>
                <dt>Attitude</dt>
                <dd>{replayFrames.length ? 'available' : 'none'}</dd>
              </div>
            </dl>
          </section>

          {decodeError ? (
            <section className="panel-section">
              <div className="section-heading">
                <h2>Decode Error</h2>
              </div>
              <p className="muted">{decodeError}</p>
            </section>
          ) : null}

          {decodeResult ? (
            <section className="panel-section">
              <div className="section-heading">
                <h2>Header</h2>
              </div>

              <dl className="key-grid compact">
                <div>
                  <dt>Craft</dt>
                  <dd>{decodeResult.headers.craftName ?? 'n/a'}</dd>
                </div>
                <div>
                  <dt>Product</dt>
                  <dd>{decodeResult.headers.product ?? 'n/a'}</dd>
                </div>
                <div>
                  <dt>Data Version</dt>
                  <dd>{decodeResult.headers.dataVersion ?? 'n/a'}</dd>
                </div>
                <div>
                  <dt>Firmware</dt>
                  <dd>{decodeResult.headers.firmwareRevision ?? 'n/a'}</dd>
                </div>
                <div>
                  <dt>Board</dt>
                  <dd>{decodeResult.headers.boardInfo ?? 'n/a'}</dd>
                </div>
                <div>
                  <dt>Gyro Scale</dt>
                  <dd>{decodeResult.headers.gyroScale ?? 'n/a'}</dd>
                </div>
              </dl>
            </section>
          ) : null}

          {decodeResult?.warnings.length ? (
            <section className="panel-section">
              <div className="section-heading">
                <h2>Warnings</h2>
                <span className="mono">{decodeResult.warnings.length}</span>
              </div>
              <ul className="issue-list">
                {decodeResult.warnings.slice(0, 20).map((issue, index) => (
                  <li key={`${issue.offset}-${index}`}>
                    <strong>{issue.frameType ?? 'decoder'}</strong>
                    <span>{issue.message}</span>
                    <span className="mono">@{issue.offset}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {decodeResult?.errors.length ? (
            <section className="panel-section">
              <div className="section-heading">
                <h2>Errors</h2>
                <span className="mono">{decodeResult.errors.length}</span>
              </div>
              <ul className="issue-list">
                {decodeResult.errors.slice(0, 12).map((issue, index) => (
                  <li key={`${issue.offset}-${index}`}>
                    <strong>{issue.frameType ?? 'decoder'}</strong>
                    <span>{issue.message}</span>
                    <span className="mono">@{issue.offset}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>

        <main className="scene-panel">
          <FlightScene replayFrames={replayFrames} currentFrameIndex={currentFrameIndex} />
        </main>

        <TelemetryPanel frame={currentFrame} />
      </div>

      <ReplayControls
        currentTime={playheadTime}
        duration={duration}
        playbackRate={playbackRate}
        isPlaying={isPlaying}
        gyroScale={gyroScale}
        disabled={playbackDisabled}
        playLabel={playLabel}
        onSeek={setPlayheadTime}
        onTogglePlay={() => setIsPlaying((value) => !value)}
        onPlaybackRateChange={setPlaybackRate}
        onGyroScaleChange={setGyroScale}
      />
    </div>
  )
}

function findFrameIndexByTime(frames: ReplayFrame[], targetTime: number): number {
  if (frames.length === 0) {
    return 0
  }

  let low = 0
  let high = frames.length - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)

    if (frames[mid].t === targetTime) {
      return mid
    }

    if (frames[mid].t < targetTime) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return Math.max(0, Math.min(frames.length - 1, low))
}

export default App
