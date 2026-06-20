type FilePickerProps = {
  fileName?: string
  fileSize?: number
  onPick: (file: File) => void
}

export function FilePicker({ fileName, fileSize, onPick }: FilePickerProps) {
  return (
    <section className="panel-section">
      <div className="section-heading">
        <h2>Blackbox File</h2>
        {fileName ? <span className="mono">{fileName}</span> : null}
      </div>

      <label className="file-picker">
        <input
          type="file"
          accept=".bbl,.BBL"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              onPick(file)
            }
          }}
        />
        <span>Select `.bbl`</span>
      </label>

      <p className="muted">
        Browser-side decoding only. No CSV export and no server preprocessing.
      </p>

      {fileName ? (
        <dl className="key-grid compact">
          <div>
            <dt>Name</dt>
            <dd>{fileName}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(fileSize ?? 0)}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  )
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }

  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}
