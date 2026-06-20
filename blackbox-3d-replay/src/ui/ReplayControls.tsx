type ReplayControlsProps = {
  currentTime: number
  duration: number
  playbackRate: number
  isPlaying: boolean
  gyroScale: number
  onSeek: (time: number) => void
  onTogglePlay: () => void
  onPlaybackRateChange: (value: number) => void
  onGyroScaleChange: (value: number) => void
}

const PLAYBACK_RATES = [0.5, 1, 2, 4]

export function ReplayControls({
  currentTime,
  duration,
  playbackRate,
  isPlaying,
  gyroScale,
  onSeek,
  onTogglePlay,
  onPlaybackRateChange,
  onGyroScaleChange,
}: ReplayControlsProps) {
  return (
    <section className="controls-bar">
      <button type="button" className="primary-button" onClick={onTogglePlay}>
        {isPlaying ? 'Pause' : 'Play'}
      </button>

      <div className="time-slider">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={Math.max(duration / 1000, 0.01)}
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        <div className="timeline-label">
          <span className="mono">{formatTime(currentTime)}</span>
          <span className="mono">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="control-stack">
        <label>
          <span>Speed</span>
          <select value={playbackRate} onChange={(event) => onPlaybackRateChange(Number(event.target.value))}>
            {PLAYBACK_RATES.map((value) => (
              <option key={value} value={value}>
                {value}x
              </option>
            ))}
          </select>
        </label>

        <label className="gyro-scale-control">
          <span>Gyro Scale</span>
          <input
            type="range"
            min={0.2}
            max={3}
            step={0.05}
            value={gyroScale}
            onChange={(event) => onGyroScaleChange(Number(event.target.value))}
          />
          <strong className="mono">{gyroScale.toFixed(2)}x</strong>
        </label>
      </div>
    </section>
  )
}

function formatTime(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = safe - minutes * 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`
}
