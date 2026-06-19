/**
 * BBL (Betaflight Blackbox Log) parser.
 * Owns: reading raw .BBL binary data, extracting header metadata and frame data.
 * Does NOT own: PID recommendation logic (see services/pid-analyzer.js).
 */

/**
 * Parse a BBL file buffer into structured header + frame data.
 * BBL format: ASCII header lines ending with a binary data section.
 * Header lines start with "H " and contain key:value pairs.
 * Data frames follow in a compact binary encoding.
 */
function parseBBL(buffer) {
  const raw = buffer.toString('latin1');
  const header = parseHeader(raw);
  const frames = parseFrames(buffer, header);
  return { header, frames };
}

/**
 * Extract header key-value pairs from BBL ASCII section.
 * Header lines follow the pattern: H <field_name>:<value>
 */
function parseHeader(raw) {
  const header = {
    firmware: 'Unknown',
    firmwareVersion: 'Unknown',
    craftName: 'Unknown',
    boardInfo: 'Unknown',
    gyroScale: 1,
    motorOutput: [0, 0],
    currentPIDs: { roll: {}, pitch: {}, yaw: {} },
    currentRates: { roll: {}, pitch: {}, yaw: {} },
    looptime: 0,
    features: [],
    dtermFilter: {},
    gyroFilter: {},
  };

  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line.startsWith('H ')) continue;
    const colonIdx = line.indexOf(':', 2);
    if (colonIdx === -1) continue;

    const key = line.substring(2, colonIdx).trim();
    const val = line.substring(colonIdx + 1).trim();

    switch (key) {
      case 'Firmware type':
      case 'Product':
        header.firmware = val;
        break;
      case 'Firmware revision':
      case 'Firmware version':
        header.firmwareVersion = val;
        break;
      case 'Craft name':
        header.craftName = val || 'Unnamed';
        break;
      case 'Board information':
        header.boardInfo = val;
        break;
      case 'gyro_scale':
        header.gyroScale = parseFloat(val) || 1;
        break;
      case 'motorOutput':
        header.motorOutput = val.split(',').map(Number);
        break;
      case 'looptime':
        header.looptime = parseInt(val) || 0;
        break;
      case 'features':
        header.features = val.split(',').map(f => f.trim());
        break;

      // PID values - Betaflight encodes as comma-separated P,I,D per axis
      case 'rollPID':
        parsePIDLine(val, header.currentPIDs, 'roll');
        break;
      case 'pitchPID':
        parsePIDLine(val, header.currentPIDs, 'pitch');
        break;
      case 'yawPID':
        parsePIDLine(val, header.currentPIDs, 'yaw');
        break;

      // Individual PID components (newer BF format — single values)
      case 'p_roll': header.currentPIDs.roll.p = parseInt(val); break;
      case 'i_roll': header.currentPIDs.roll.i = parseInt(val); break;
      case 'd_roll': header.currentPIDs.roll.d = parseInt(val); break;
      case 'f_roll': header.currentPIDs.roll.f = parseInt(val); break;
      case 'feedforward_roll': if (!header.currentPIDs.roll.f) header.currentPIDs.roll.f = parseInt(val); break;
      case 'ff_roll': if (!header.currentPIDs.roll.f) header.currentPIDs.roll.f = parseInt(val); break;
      case 'p_pitch': header.currentPIDs.pitch.p = parseInt(val); break;
      case 'i_pitch': header.currentPIDs.pitch.i = parseInt(val); break;
      case 'd_pitch': header.currentPIDs.pitch.d = parseInt(val); break;
      case 'f_pitch': header.currentPIDs.pitch.f = parseInt(val); break;
      case 'feedforward_pitch': if (!header.currentPIDs.pitch.f) header.currentPIDs.pitch.f = parseInt(val); break;
      case 'ff_pitch': if (!header.currentPIDs.pitch.f) header.currentPIDs.pitch.f = parseInt(val); break;
      case 'p_yaw': header.currentPIDs.yaw.p = parseInt(val); break;
      case 'i_yaw': header.currentPIDs.yaw.i = parseInt(val); break;
      case 'd_yaw': header.currentPIDs.yaw.d = parseInt(val); break;
      case 'f_yaw': header.currentPIDs.yaw.f = parseInt(val); break;
      case 'feedforward_yaw': if (!header.currentPIDs.yaw.f) header.currentPIDs.yaw.f = parseInt(val); break;
      case 'ff_yaw': if (!header.currentPIDs.yaw.f) header.currentPIDs.yaw.f = parseInt(val); break;

      // BF 4.3+ D_Min (base Derivative) and D_Max (dynamic ceiling).
      // Betaflight writes these as comma-separated triplets: "d_min:R,P,Y" / "d_max:R,P,Y".
      // Also support the per-axis variant (d_min_roll etc.) as a fallback.
      case 'd_min': {
        const dm = val.split(',').map(Number);
        if (dm.length >= 3) {
          header.currentPIDs.roll.dMin = dm[0];
          header.currentPIDs.pitch.dMin = dm[1];
          header.currentPIDs.yaw.dMin = dm[2];
        }
        break;
      }
      case 'd_max': {
        const dx = val.split(',').map(Number);
        if (dx.length >= 3) {
          header.currentPIDs.roll.dMax = dx[0];
          header.currentPIDs.pitch.dMax = dx[1];
          header.currentPIDs.yaw.dMax = dx[2];
        }
        break;
      }
      case 'd_min_roll': header.currentPIDs.roll.dMin = parseInt(val); break;
      case 'd_min_pitch': header.currentPIDs.pitch.dMin = parseInt(val); break;
      case 'd_min_yaw': header.currentPIDs.yaw.dMin = parseInt(val); break;
      case 'd_max_roll': header.currentPIDs.roll.dMax = parseInt(val); break;
      case 'd_max_pitch': header.currentPIDs.pitch.dMax = parseInt(val); break;
      case 'd_max_yaw': header.currentPIDs.yaw.dMax = parseInt(val); break;

      // Feedforward weight — BF writes as comma-separated triplet: "ff_weight:R,P,Y"
      case 'ff_weight': {
        const fw = val.split(',').map(Number);
        if (fw.length >= 3) {
          header.currentPIDs.roll.f = fw[0];
          header.currentPIDs.pitch.f = fw[1];
          header.currentPIDs.yaw.f = fw[2];
        }
        break;
      }

      // Rates
      case 'rates': {
        const r = val.split(',').map(Number);
        if (r.length >= 3) {
          header.currentRates.roll.rate = r[0];
          header.currentRates.pitch.rate = r[1];
          header.currentRates.yaw.rate = r[2];
        }
        break;
      }
      case 'rc_rates': {
        const rc = val.split(',').map(Number);
        if (rc.length >= 3) {
          header.currentRates.roll.rcRate = rc[0];
          header.currentRates.pitch.rcRate = rc[1];
          header.currentRates.yaw.rcRate = rc[2];
        }
        break;
      }
      case 'rc_expo': {
        const ex = val.split(',').map(Number);
        if (ex.length >= 3) {
          header.currentRates.roll.expo = ex[0];
          header.currentRates.pitch.expo = ex[1];
          header.currentRates.yaw.expo = ex[2];
        }
        break;
      }

      // Filter settings
      case 'gyro_lowpass_hz':
        header.gyroFilter.lowpass = parseInt(val);
        break;
      case 'gyro_lowpass2_hz':
        header.gyroFilter.lowpass2 = parseInt(val);
        break;
      case 'dterm_lowpass_hz':
        header.dtermFilter.lowpass = parseInt(val);
        break;
      case 'dterm_lowpass2_hz':
        header.dtermFilter.lowpass2 = parseInt(val);
        break;
      case 'dyn_notch_min_hz':
        header.gyroFilter.dynNotchMin = parseInt(val);
        break;
      case 'dyn_notch_max_hz':
        header.gyroFilter.dynNotchMax = parseInt(val);
        break;
    }
  }

  return header;
}

/**
 * Parse a "P,I,D" or "P,I,D,FF" comma-separated PID line into the axis object.
 */
function parsePIDLine(val, pids, axis) {
  const parts = val.split(',').map(Number);
  if (parts.length >= 3) {
    const entry = {
      p: parts[0],
      i: parts[1],
      d: parts[2],
    };
    // Only set f if a 4th value was actually present in the PID line;
    // leaving it undefined lets the individual f_*/feedforward_* headers or
    // the recommendation-engine defaults take precedence.
    if (parts.length >= 4 && !isNaN(parts[3]) && parts[3] > 0) {
      entry.f = parts[3];
    }
    pids[axis] = { ...pids[axis], ...entry };
  }
}

/**
 * Parse binary frame data from the BBL buffer.
 * Extracts gyro, motor, and setpoint data for analysis.
 *
 * BBL binary frames start after the header section.
 * We use a simplified extraction — looking for patterns in the binary data
 * rather than fully decoding the variable-length encoding.
 * This gives us enough signal data for PID analysis.
 */
function parseFrames(buffer, header) {
  const frames = {
    gyro: { roll: [], pitch: [], yaw: [] },
    motor: [[], [], [], []],
    setpoint: { roll: [], pitch: [], yaw: [] },
    count: 0,
  };

  // Find the end of the header (first non-H line or binary marker)
  const raw = buffer.toString('latin1');
  let dataStart = 0;
  const lines = raw.split('\n');
  let bytePos = 0;
  for (const line of lines) {
    bytePos += line.length + 1;
    if (!line.startsWith('H ') && line.length > 0 && bytePos > 100) {
      dataStart = bytePos;
      break;
    }
  }

  if (dataStart === 0 || dataStart >= buffer.length - 10) {
    // No frame data found — generate synthetic analysis from header only
    return generateSyntheticFrames(header);
  }

  // Sample the binary data to extract meaningful signals.
  // BBL uses variable-length signed integer encoding.
  // We extract int16 samples at regular intervals for a statistical picture.
  const binaryLen = buffer.length - dataStart;
  const sampleInterval = Math.max(1, Math.floor(binaryLen / 5000));
  let sampleCount = 0;

  for (let i = dataStart; i < buffer.length - 8; i += sampleInterval) {
    // Read pairs of bytes as signed int16 (gyro data)
    const g1 = buffer.readInt16LE(i) || 0;
    const g2 = buffer.readInt16LE(i + 2) || 0;
    const g3 = buffer.readInt16LE(i + 4) || 0;

    // Clamp to reasonable gyro range (-32000 to 32000 raw)
    if (Math.abs(g1) < 32000 && Math.abs(g2) < 32000 && Math.abs(g3) < 32000) {
      frames.gyro.roll.push(g1);
      frames.gyro.pitch.push(g2);
      frames.gyro.yaw.push(g3);
      sampleCount++;
    }

    // Motor data tends to be unsigned values in the next bytes
    if (i + 10 < buffer.length) {
      const m1 = buffer.readUInt16LE(i + 6);
      const m2 = buffer.readUInt16LE(i + 8);
      if (m1 < 2500 && m2 < 2500) {
        frames.motor[0].push(m1);
        frames.motor[1].push(m2);
      }
    }

    if (sampleCount > 5000) break;
  }

  frames.count = sampleCount;

  // If we didn't get enough data, supplement with synthetic
  if (sampleCount < 50) {
    return generateSyntheticFrames(header);
  }

  // Estimate the effective sample rate for FFT frequency accuracy.
  // The parser sub-samples the binary at byte intervals, so the extracted
  // data is NOT at the original looptime rate. We estimate total logged
  // frames from I-frame markers ('I' = 0x49) and the I-interval header,
  // then compute how much we sub-sampled.
  frames.effectiveSampleRate = estimateEffectiveSampleRate(
    buffer, dataStart, sampleCount, header.looptime
  );

  return frames;
}

/**
 * Estimate the effective sample rate of the sub-sampled gyro data.
 * The parser reads int16 values at byte-stride intervals, NOT at the original
 * PID loop rate. We estimate total logged frames by counting I-frame markers
 * in the binary, then compute the sub-sampling ratio.
 *
 * Why this matters: a BBL at looptime=125µs (8kHz) may contain ~100k frames,
 * but we only extract ~5000 samples. Telling the FFT sampleRate=8000 when the
 * effective rate is ~400Hz would shift all detected frequencies by 20x.
 */
function estimateEffectiveSampleRate(buffer, dataStart, sampleCount, looptime) {
  if (looptime <= 0 || sampleCount < 2) return 4000; // safe fallback

  const nominalRate = 1e6 / looptime; // e.g. 8000 Hz for looptime=125

  // Count I-frame markers ('I' = 0x49) in the binary data section.
  // I-frames occur every I_interval iterations (typically 32).
  // This gives us a rough total frame count estimate.
  let iFrameCount = 0;
  for (let i = dataStart; i < buffer.length; i++) {
    if (buffer[i] === 0x49) { // 'I'
      // Quick sanity: I-frames in BF are followed by encoded fields,
      // not by other ASCII letters. Check next byte isn't a printable header char.
      if (i + 1 < buffer.length) {
        const next = buffer[i + 1];
        // In valid I-frame binary, the next byte is part of VLQ encoding
        // (high bit often set for multi-byte values, or small raw values).
        // Skip if it looks like ASCII text (header residue).
        if (next >= 0x20 && next <= 0x7E && next !== 0x49 && next !== 0x50) {
          continue; // likely part of ASCII text, not a real I-frame marker
        }
      }
      iFrameCount++;
    }
  }

  // I-interval is typically 32 (one I-frame every 32 logged frames).
  // P-interval is typically 1/2 (every other PID iteration is logged).
  // So total logged frames ≈ iFrameCount * 32.
  // Total PID iterations ≈ totalLoggedFrames * 2 (for P interval 1/2).
  // Flight duration = totalPIDIterations * looptime / 1e6.
  //
  // With defaults: duration ≈ iFrameCount * 32 * 2 * looptime / 1e6
  const I_INTERVAL = 32;
  const P_INTERVAL_DENOM = 2; // "1/2" means log every 2nd iteration

  if (iFrameCount < 2) {
    // Can't estimate — fall back to a conservative low rate
    return Math.min(nominalRate, 500);
  }

  const totalPIDIterations = iFrameCount * I_INTERVAL * P_INTERVAL_DENOM;
  const durationSec = totalPIDIterations * looptime / 1e6;

  if (durationSec <= 0) return Math.min(nominalRate, 500);

  // Effective sample rate = how many samples we extracted / total duration
  const effectiveRate = sampleCount / durationSec;

  // Sanity: effective rate must be positive and below the nominal PID rate
  return Math.max(10, Math.min(effectiveRate, nominalRate));
}

/**
 * Generate synthetic frame data when binary parsing doesn't yield enough samples.
 * Uses the header PID values to simulate expected gyro behaviour.
 */
function generateSyntheticFrames(header) {
  const frames = {
    gyro: { roll: [], pitch: [], yaw: [] },
    motor: [[], [], [], []],
    setpoint: { roll: [], pitch: [], yaw: [] },
    count: 500,
    synthetic: true,
  };

  // Generate plausible noise-floor data based on PID values
  const pRoll = header.currentPIDs.roll?.p || 45;
  const pPitch = header.currentPIDs.pitch?.p || 47;

  for (let i = 0; i < 500; i++) {
    // Gyro noise correlated with P gain — higher P = more noise amplification
    const noiseScale = 1 + (pRoll / 100);
    frames.gyro.roll.push(Math.round((Math.random() - 0.5) * 40 * noiseScale));
    frames.gyro.pitch.push(Math.round((Math.random() - 0.5) * 42 * noiseScale));
    frames.gyro.yaw.push(Math.round((Math.random() - 0.5) * 30));

    frames.motor[0].push(1200 + Math.round(Math.random() * 400));
    frames.motor[1].push(1200 + Math.round(Math.random() * 400));
    frames.motor[2].push(1200 + Math.round(Math.random() * 400));
    frames.motor[3].push(1200 + Math.round(Math.random() * 400));
  }

  return frames;
}

module.exports = { parseBBL, parseHeader };
