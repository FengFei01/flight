import type { BlackboxSegment } from '../blackbox/types'

type SegmentSelectorProps = {
  segments: BlackboxSegment[]
  selectedIndex: number
  onSelect: (index: number) => void
}

export function SegmentSelector({ segments, selectedIndex, onSelect }: SegmentSelectorProps) {
  return (
    <section className="panel-section">
      <div className="section-heading">
        <h2>Segments</h2>
        <span className="mono">{segments.length}</span>
      </div>

      <div className="segment-list">
        {segments.map((segment) => (
          <button
            key={segment.index}
            type="button"
            className={`segment-item${segment.index === selectedIndex ? ' active' : ''}`}
            onClick={() => onSelect(segment.index)}
          >
            <strong>Segment {segment.index + 1}</strong>
            <span>{segment.header.craftName ?? segment.header.product ?? 'Blackbox log'}</span>
            <span className="muted">
              bytes {segment.byteStart.toLocaleString()} - {segment.byteEnd.toLocaleString()}
            </span>
            <span className="muted">
              v{segment.header.dataVersion ?? '?'} {segment.header.firmwareRevision ?? ''}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
