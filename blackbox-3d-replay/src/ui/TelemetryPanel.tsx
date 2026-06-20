import type { ReplayFrame } from '../blackbox/types'
import { radToDeg } from '../flight/coordinates'

type TelemetryPanelProps = {
  frame?: ReplayFrame
}

export function TelemetryPanel({ frame }: TelemetryPanelProps) {
  if (!frame) {
    return (
      <aside className="telemetry-panel">
        <div className="section-heading">
          <h2>Telemetry</h2>
        </div>
        <p className="muted">Choose a segment to inspect live telemetry.</p>
      </aside>
    )
  }

  const { telemetry } = frame

  return (
    <aside className="telemetry-panel">
      <div className="section-heading">
        <h2>Telemetry</h2>
        <span className="mono">{frame.t.toFixed(2)} s</span>
      </div>

      <dl className="key-grid">
        <div>
          <dt>Lat / Lon</dt>
          <dd>
            {telemetry.gps
              ? `${telemetry.gps.lat.toFixed(6)}, ${telemetry.gps.lon.toFixed(6)}`
              : 'n/a'}
          </dd>
        </div>
        <div>
          <dt>Altitude</dt>
          <dd>{formatNumber(telemetry.baroAlt ?? telemetry.gps?.alt, 'm')}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{formatNumber(telemetry.gps?.speed, 'm/s')}</dd>
        </div>
        <div>
          <dt>GPS Sats</dt>
          <dd>{telemetry.gps?.numSat ?? 'n/a'}</dd>
        </div>
        <div>
          <dt>Roll / Pitch / Yaw</dt>
          <dd>
            {`${radToDeg(frame.euler.roll).toFixed(1)} / ${radToDeg(frame.euler.pitch).toFixed(1)} / ${radToDeg(frame.euler.yaw).toFixed(1)}`}
          </dd>
        </div>
        <div>
          <dt>Gyro</dt>
          <dd>{formatArray(telemetry.gyro, 1)}</dd>
        </div>
        <div>
          <dt>Acc</dt>
          <dd>{formatArray(telemetry.acc, 0)}</dd>
        </div>
        <div>
          <dt>Motors</dt>
          <dd>{formatArray(telemetry.motor, 0)}</dd>
        </div>
        <div>
          <dt>RC Command</dt>
          <dd>{formatArray(telemetry.rc, 0)}</dd>
        </div>
      </dl>
    </aside>
  )
}

function formatNumber(value: number | undefined, suffix = ''): string {
  return value === undefined ? 'n/a' : `${value.toFixed(2)}${suffix ? ` ${suffix}` : ''}`
}

function formatArray(value: number[] | undefined, digits: number): string {
  return value?.length ? value.map((item) => item.toFixed(digits)).join(', ') : 'n/a'
}
