/**
 * PID recommendation engine.
 * Owns: analyzing parsed BBL data, producing tuning recommendations,
 *       flight style adjustments, and composite flight score.
 * Does NOT own: BBL file parsing (see services/bbl-parser.js).
 */
const { mapParam, generateCLIFromAnalysis, generateDiffCLI } = require('../public/js/bf-version-map');

/**
 * Flight style profiles — multipliers applied to base PID recommendations.
 * Each style adjusts P, D, FF, filter cutoffs, and scoring weights differently.
 */
const STYLE_PROFILES = {
  freestyle: {
    label: 'Freestyle',
    labelZh: '花飞',
    p: 1.10, d: 1.08, f: 1.05, i: 1.0, dMax: 1.05,
    gyroFilterMult: 1.10,   // open filters for responsiveness
    dtermFilterMult: 1.08,
    scoreWeights: { pidResponse: 0.35, vibration: 0.25, motorHealth: 0.15, filterEffectiveness: 0.25 },
    // Freestyle tolerates mild overshoot for snappiness
    overshootPenalty: 0.6,
    smoothnessPenalty: 0.3,
  },
  racing: {
    label: 'Racing',
    labelZh: '竞速',
    p: 1.0, d: 1.0, f: 1.02, i: 1.05, dMax: 1.0,
    gyroFilterMult: 1.0,
    dtermFilterMult: 1.0,
    scoreWeights: { pidResponse: 0.40, vibration: 0.20, motorHealth: 0.15, filterEffectiveness: 0.25 },
    overshootPenalty: 1.0, // zero tolerance for overshoot
    smoothnessPenalty: 0.5,
  },
  cinematic: {
    label: 'Cinematic',
    labelZh: '航拍',
    p: 0.85, d: 0.80, f: 0.85, i: 1.05, dMax: 0.80,
    gyroFilterMult: 0.80,  // aggressive filtering for jitter-free footage
    dtermFilterMult: 0.75,
    scoreWeights: { pidResponse: 0.20, vibration: 0.35, motorHealth: 0.15, filterEffectiveness: 0.30 },
    overshootPenalty: 1.0,
    smoothnessPenalty: 1.0,  // smoothness is everything
  },
  longrange: {
    label: 'Long Range',
    labelZh: '远航',
    p: 0.90, d: 0.85, f: 0.90, i: 1.10, dMax: 0.85,
    gyroFilterMult: 0.85,  // protective filtering for motor longevity
    dtermFilterMult: 0.80,
    scoreWeights: { pidResponse: 0.20, vibration: 0.25, motorHealth: 0.30, filterEffectiveness: 0.25 },
    overshootPenalty: 0.8,
    smoothnessPenalty: 0.8,
  },
};

/**
 * Analyze parsed BBL data and return PID recommendations.
 * Uses statistical analysis of gyro noise, motor output variance,
 * and error signals to suggest optimized PID values.
 */
function analyzePIDs(parsedData) {
  const { header, frames } = parsedData;
  const current = header.currentPIDs;

  // Compute gyro statistics
  const gyroStats = computeGyroStats(frames.gyro);
  const motorStats = computeMotorStats(frames.motor);

  // Generate recommendations based on noise analysis
  const recommended = {
    roll: recommendAxis('roll', current.roll, gyroStats.roll, motorStats),
    pitch: recommendAxis('pitch', current.pitch, gyroStats.pitch, motorStats),
    yaw: recommendAxis('yaw', current.yaw, gyroStats.yaw, motorStats),
  };

  // Back-fill current with effective input values so the "was XX" display always
  // has data for FF and D_Max even when the BBL header omitted those fields.
  // The recommendation engine already resolved these via defaults — store them
  // on current so the rendering layer can show the original baseline.
  for (const axis of ['roll', 'pitch', 'yaw']) {
    if (!current[axis]) current[axis] = {};
    const defaults = getDefaults(axis);
    if (current[axis].f == null) current[axis].f = defaults.f;
    if (current[axis].dMax == null) current[axis].dMax = defaults.dMax;
  }

  // Compute filter recommendations
  const filterRec = recommendFilters(gyroStats, header.gyroFilter, header.dtermFilter);

  // Build overall assessment
  const assessment = buildAssessment(gyroStats, motorStats, current, recommended);

  return {
    current,
    recommended,
    filters: filterRec,
    assessment,
    gyroStats,
    motorStats,
    header,
    frameCount: frames.count,
    synthetic: !!frames.synthetic,
  };
}

/**
 * Compute statistical properties of gyro data for each axis.
 */
function computeGyroStats(gyro) {
  const stats = {};
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const data = gyro[axis] || [];
    if (data.length === 0) {
      stats[axis] = { mean: 0, stdDev: 0, rms: 0, peak: 0, noiseLevel: 'unknown' };
      continue;
    }

    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const variance = data.reduce((a, b) => a + (b - mean) ** 2, 0) / data.length;
    const stdDev = Math.sqrt(variance);
    const rms = Math.sqrt(data.reduce((a, b) => a + b * b, 0) / data.length);
    const peak = Math.max(...data.map(Math.abs));

    // Classify noise level
    let noiseLevel = 'clean';
    if (rms > 80) noiseLevel = 'noisy';
    else if (rms > 40) noiseLevel = 'moderate';
    else if (rms > 20) noiseLevel = 'acceptable';

    stats[axis] = { mean: round2(mean), stdDev: round2(stdDev), rms: round2(rms), peak, noiseLevel };
  }
  return stats;
}

/**
 * Compute motor output statistics.
 */
function computeMotorStats(motors) {
  const allMotorData = motors.flat().filter(v => v > 0);
  if (allMotorData.length === 0) {
    return { avgThrottle: 0, throttleRange: 0, balance: 'unknown' };
  }

  const avg = allMotorData.reduce((a, b) => a + b, 0) / allMotorData.length;
  const min = Math.min(...allMotorData);
  const max = Math.max(...allMotorData);

  // Check motor balance by comparing averages across motors
  const motorAvgs = motors.map(m => {
    if (m.length === 0) return 0;
    return m.reduce((a, b) => a + b, 0) / m.length;
  }).filter(v => v > 0);

  let balance = 'good';
  if (motorAvgs.length >= 2) {
    const spread = Math.max(...motorAvgs) - Math.min(...motorAvgs);
    if (spread > 200) balance = 'poor';
    else if (spread > 100) balance = 'moderate';
  }

  return { avgThrottle: round2(avg), throttleRange: max - min, balance };
}

/**
 * Recommend PID values for a single axis.
 * Strategy: adjust current values based on noise and motor data.
 * D and D_Max are separate: D = base derivative (d_min in BF 4.3+),
 * D_Max = dynamic ceiling. Yaw typically has D=0, D_Max=0 — respected here.
 */
function recommendAxis(axis, current, gyroStat, motorStats) {
  // Start from current values or BF 4.5 defaults
  const defaults = getDefaults(axis);
  const p = current?.p || defaults.p;
  const i = current?.i || defaults.i;
  // Use dMin if available (BF 4.3+ d_min_* header), otherwise fall back to d
  const d = current?.dMin ?? current?.d ?? defaults.d;
  const f = current?.f ?? defaults.f;
  const dMax = current?.dMax ?? defaults.dMax;

  let recP = p;
  let recI = i;
  let recD = d;
  let recF = f;
  let recDMax = dMax;
  const notes = [];

  // If original D or D_Max is 0 (e.g. Yaw), keep recommended at 0
  const dIsZero = d === 0;
  const dMaxIsZero = dMax === 0;

  // Noise-based P adjustment
  if (gyroStat.noiseLevel === 'noisy') {
    recP = Math.round(p * 0.85);
    if (!dIsZero) recD = Math.round(d * 0.80);
    if (!dMaxIsZero) recDMax = Math.round(dMax * 0.85);
    notes.push('Reduced P and D due to high gyro noise');
  } else if (gyroStat.noiseLevel === 'clean') {
    recP = Math.round(p * 1.10);
    if (!dIsZero) recD = Math.round(d * 1.08);
    if (!dMaxIsZero) recDMax = Math.round(dMax * 1.05);
    notes.push('Increased P and D — noise floor allows more authority');
  }

  // I-term: if mean gyro offset is large, I-term needs to be higher
  if (Math.abs(gyroStat.mean) > 5) {
    recI = Math.round(i * 1.15);
    notes.push('Bumped I-term to correct steady-state drift');
  }

  // FF: adjust based on noise
  if (gyroStat.noiseLevel === 'noisy') {
    recF = Math.round(f * 0.90);
    notes.push('Lowered feed-forward to reduce noise injection');
  }

  // Motor balance affects yaw specifically
  if (axis === 'yaw' && motorStats.balance === 'poor') {
    recP = Math.round(recP * 0.90);
    notes.push('Motor imbalance detected — reduced yaw P');
  }

  // Clamp to reasonable Betaflight ranges — D min is 0 for axes where original=0
  recP = clamp(recP, 20, 100);
  recI = clamp(recI, 30, 200);
  recD = dIsZero ? 0 : clamp(recD, 15, 80);
  recF = clamp(recF, 0, 250);
  recDMax = dMaxIsZero ? 0 : clamp(recDMax, 0, 80);

  return { p: recP, i: recI, d: recD, f: recF, dMax: recDMax, notes };
}

/**
 * BF 4.5 default PID values per axis.
 * d = D_Min (base Derivative), dMax = D_Max (dynamic ceiling).
 */
function getDefaults(axis) {
  const defaults = {
    roll:  { p: 45, i: 80, d: 30, f: 120, dMax: 40 },
    pitch: { p: 47, i: 84, d: 32, f: 125, dMax: 42 },
    yaw:   { p: 45, i: 90, d: 0,  f: 75,  dMax: 0 },
  };
  return defaults[axis] || defaults.roll;
}

/**
 * Compute change magnitude info for a recommended value vs original.
 * Returns { pct, direction, severity } where severity = 'large'|'small'|'none'.
 */
function computeChangeMagnitude(recVal, origVal) {
  if (origVal == null || origVal === 0) return null;
  const diff = recVal - origVal;
  if (diff === 0) return null;
  const pct = Math.round((Math.abs(diff) / origVal) * 100);
  const direction = diff > 0 ? 'up' : 'down';
  const severity = pct > 15 ? 'large' : 'small';
  return { pct, direction, severity };
}

/**
 * Recommend gyro and D-term filter settings based on noise analysis.
 */
function recommendFilters(gyroStats, currentGyro, currentDterm) {
  const noiseLevel = gyroStats.roll?.noiseLevel || 'moderate';

  // Base filter recommendations on noise level
  let gyroLowpass, dtermLowpass;

  switch (noiseLevel) {
    case 'clean':
      gyroLowpass = 300;
      dtermLowpass = 170;
      break;
    case 'acceptable':
      gyroLowpass = 275;
      dtermLowpass = 150;
      break;
    case 'moderate':
      gyroLowpass = 250;
      dtermLowpass = 130;
      break;
    case 'noisy':
      gyroLowpass = 200;
      dtermLowpass = 100;
      break;
    default:
      gyroLowpass = 250;
      dtermLowpass = 150;
  }

  return {
    gyro_lowpass_hz: gyroLowpass,
    dterm_lowpass_hz: dtermLowpass,
    currentGyro,
    currentDterm,
    notes: noiseLevel === 'noisy'
      ? 'High noise detected — tighter filtering recommended. Check prop balance and motor condition.'
      : noiseLevel === 'clean'
        ? 'Clean gyro signal. Filters can be opened up for more responsiveness.'
        : 'Moderate noise floor. Filter settings are within normal range.',
  };
}

/**
 * Build an overall assessment of the tune.
 */
function buildAssessment(gyroStats, motorStats, current, recommended) {
  const items = [];

  // Propwash assessment
  const avgNoise = (gyroStats.roll?.rms || 0 + gyroStats.pitch?.rms || 0) / 2;
  if (avgNoise > 60) {
    items.push({ label: 'Propwash Handling', value: 'Needs Work', status: 'warning' });
  } else if (avgNoise > 30) {
    items.push({ label: 'Propwash Handling', value: 'Acceptable', status: 'ok' });
  } else {
    items.push({ label: 'Propwash Handling', value: 'Excellent', status: 'good' });
  }

  // Noise floor
  const noiseLevel = gyroStats.roll?.noiseLevel || 'unknown';
  items.push({
    label: 'Noise Floor',
    value: capitalize(noiseLevel),
    status: noiseLevel === 'clean' ? 'good' : noiseLevel === 'noisy' ? 'warning' : 'ok',
  });

  // Motor balance
  items.push({
    label: 'Motor Balance',
    value: capitalize(motorStats.balance),
    status: motorStats.balance === 'good' ? 'good' : motorStats.balance === 'poor' ? 'warning' : 'ok',
  });

  // Estimated step response (heuristic: lower D + higher P = faster response)
  const avgP = ((recommended.roll?.p || 45) + (recommended.pitch?.p || 47)) / 2;
  const avgD = ((recommended.roll?.d || 30) + (recommended.pitch?.d || 32)) / 2;
  const estResponseMs = Math.round(30 - (avgP / 10) + (avgD / 5));
  items.push({
    label: 'Est. Step Response',
    value: `${clamp(estResponseMs, 8, 30)}ms`,
    status: estResponseMs < 15 ? 'good' : estResponseMs < 22 ? 'ok' : 'warning',
  });

  return items;
}

/**
 * Generate Betaflight CLI commands from recommended PID values.
 */
function generateCLICommands(analysis, bfVersion) {
  return generateCLIFromAnalysis({
    recommended: analysis.recommended,
    filters: analysis.filters,
    header: analysis.header,
  }, bfVersion || '4.3');
}

/**
 * Generate diff-only CLI export — only parameters that changed from current.
 * Returns empty string if no changes recommended.
 */
function generateDiffCLICommands(analysis, bfVersion) {
  return generateDiffCLI({
    recommended: analysis.recommended,
    current: analysis.current,
    filters: analysis.filters,
    header: analysis.header,
  }, bfVersion || '4.3');
}

/**
 * Generate Chinese tuning effect descriptions based on PID diffs.
 * Dynamically describes what each parameter change means for flight feel.
 */
function generateTuningNotes(current, recommended) {
  const notes = [];
  const axes = ['roll', 'pitch', 'yaw'];
  const axisNames = { roll: 'Roll', pitch: 'Pitch', yaw: 'Yaw' };

  const paramInfo = {
    p: {
      up: '锁定感更强，响应更快',
      down: '手感更柔和，减少过冲',
    },
    i: {
      up: '悬停更稳，抗风性更好',
      down: '减少低速振荡，响应更灵活',
    },
    d: {
      up: '制动更强，减少回弹',
      down: '减少高速抖动和电机发热',
    },
    f: {
      up: '前馈增强，操控更跟手',
      down: '减少操控噪声注入',
    },
    dMax: {
      up: 'D项动态上限提高，快速动作抑制更强',
      down: '降低动态D上限，减少高转速抖动',
    },
  };

  for (const axis of axes) {
    const cur = current[axis] || {};
    const rec = recommended[axis] || {};

    for (const param of ['p', 'i', 'd', 'f', 'dMax']) {
      // For 'd', use dMin original if available (BF 4.3+ separate D_Min/D_Max)
      const curVal = param === 'd' ? (cur.dMin ?? cur[param] ?? 0) : (cur[param] ?? 0);
      const recVal = rec[param] ?? 0;
      const diff = recVal - curVal;
      if (diff === 0) continue;

      const paramLabels = { p: 'P', i: 'I', d: 'D (Base)', f: 'FF', dMax: 'D_Max' };
      const paramLabel = paramLabels[param] || param.toUpperCase();
      const sign = diff > 0 ? '+' : '';
      const pct = curVal !== 0 ? Math.round((diff / curVal) * 100) : 0;
      const pctStr = curVal !== 0 ? ` (${sign}${pct}%)` : '';
      const info = paramInfo[param];
      const desc = diff > 0 ? info.up : info.down;

      notes.push(`${axisNames[axis]} ${paramLabel} ${sign}${diff}${pctStr} → ${desc}`);
    }
  }

  return notes;
}

/**
 * Apply a flight style profile to base analysis results.
 * Returns a new analysis object with style-adjusted PID values and filters.
 */
function applyStyleToAnalysis(baseAnalysis, style) {
  const profile = STYLE_PROFILES[style] || STYLE_PROFILES.freestyle;

  const styled = JSON.parse(JSON.stringify(baseAnalysis));

  // Apply style multipliers to recommended PIDs (respect zero-D axes like Yaw)
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const rec = styled.recommended[axis];
    rec.p = clamp(Math.round(rec.p * profile.p), 20, 100);
    rec.i = clamp(Math.round(rec.i * profile.i), 30, 200);
    rec.d = rec.d === 0 ? 0 : clamp(Math.round(rec.d * profile.d), 15, 80);
    rec.f = clamp(Math.round(rec.f * profile.f), 0, 250);
    rec.dMax = rec.dMax === 0 ? 0 : clamp(Math.round(rec.dMax * profile.dMax), 0, 80);

    // Regenerate per-axis notes for the styled values
    rec.notes = [];
    const cur = styled.current[axis] || {};
    if (rec.p !== (cur.p || 0)) {
      rec.notes.push(rec.p > (cur.p || 0)
        ? 'Increased P for ' + profile.label + ' response'
        : 'Reduced P for ' + profile.label + ' smoothness');
    }
    if (rec.d !== (cur.d || 0)) {
      rec.notes.push(rec.d > (cur.d || 0)
        ? 'Boosted D for propwash handling'
        : 'Lowered D to reduce vibration / motor heat');
    }
  }

  // Apply style filter multipliers
  styled.filters.gyro_lowpass_hz = Math.round(
    baseAnalysis.filters.gyro_lowpass_hz * profile.gyroFilterMult
  );
  styled.filters.dterm_lowpass_hz = Math.round(
    baseAnalysis.filters.dterm_lowpass_hz * profile.dtermFilterMult
  );

  // Rebuild assessment for the styled values
  styled.assessment = buildAssessment(
    styled.gyroStats, styled.motorStats, styled.current, styled.recommended
  );

  styled.style = style;
  styled.styleProfile = { label: profile.label, labelZh: profile.labelZh };
  return styled;
}

/**
 * Compute a 0–100 composite flight score based on analysis data and flight style.
 * Sub-scores: PID response quality, vibration level, motor health, filter effectiveness.
 */
function computeFlightScore(analysis, motorHealth, style) {
  const profile = STYLE_PROFILES[style] || STYLE_PROFILES.freestyle;
  const weights = profile.scoreWeights;

  // 1. PID Response Quality (0-100): how close recommended is to current
  //    Large changes = current tune was poor = lower score
  let pidScore = 100;
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const cur = analysis.current[axis] || {};
    const rec = analysis.recommended[axis] || {};
    for (const param of ['p', 'i', 'd', 'f']) {
      const c = cur[param] || 0;
      const r = rec[param] || 0;
      if (c > 0) {
        const pctDiff = Math.abs(r - c) / c;
        pidScore -= pctDiff * 15 * (param === 'p' || param === 'd' ? profile.overshootPenalty : 1);
      }
    }
  }
  pidScore = clamp(Math.round(pidScore), 0, 100);

  // 2. Vibration Level (0-100): based on gyro RMS noise across axes
  let vibrationScore = 100;
  const gs = analysis.gyroStats || {};
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const rms = (gs[axis] && gs[axis].rms) || 0;
    // Cinematic/LR penalizes vibration more; Freestyle is lenient
    if (rms > 80) vibrationScore -= 25 * profile.smoothnessPenalty;
    else if (rms > 40) vibrationScore -= 15 * profile.smoothnessPenalty;
    else if (rms > 20) vibrationScore -= 5 * profile.smoothnessPenalty;
  }
  vibrationScore = clamp(Math.round(vibrationScore), 0, 100);

  // 3. Motor Health Score (0-100): from motor health analysis if available
  let motorScore = 100;
  if (motorHealth && motorHealth.overall) {
    motorScore = motorHealth.overall.score;
  }

  // 4. Filter Effectiveness (0-100): current filters vs recommended
  //    If recommended filters are close to current = good; if very different = filters need work
  let filterScore = 100;
  const curGyro = analysis.filters.currentGyro;
  const curDterm = analysis.filters.currentDterm;
  const recGyro = analysis.filters.gyro_lowpass_hz;
  const recDterm = analysis.filters.dterm_lowpass_hz;

  if (curGyro && curGyro.lowpass && curGyro.lowpass > 0) {
    const gyroDiff = Math.abs(curGyro.lowpass - recGyro) / recGyro;
    filterScore -= gyroDiff * 40;
  }
  if (curDterm && curDterm.lowpass && curDterm.lowpass > 0) {
    const dtermDiff = Math.abs(curDterm.lowpass - recDterm) / recDterm;
    filterScore -= dtermDiff * 40;
  }
  filterScore = clamp(Math.round(filterScore), 0, 100);

  // Weighted composite
  const total = Math.round(
    pidScore * weights.pidResponse +
    vibrationScore * weights.vibration +
    motorScore * weights.motorHealth +
    filterScore * weights.filterEffectiveness
  );
  const score = clamp(total, 0, 100);

  // Color tier + summary
  let tier, tierZh;
  if (score >= 80) { tier = 'good'; tierZh = '良好'; }
  else if (score >= 50) { tier = 'fair'; tierZh = '一般'; }
  else { tier = 'poor'; tierZh = '需改善'; }

  // Build one-line summary
  const styleLabel = profile.label;
  let summary;
  const worstAxis = findWorstAxis(analysis.gyroStats);
  if (score >= 80) {
    summary = `Your quad is well-tuned for ${styleLabel}` +
      (worstAxis ? ` — minor vibration on ${capitalize(worstAxis)} axis` : '') +
      ` / 你的飞机${styleLabel}调参状态${tierZh}`;
  } else if (score >= 50) {
    summary = `Tune is acceptable for ${styleLabel}, but has room for improvement` +
      (worstAxis ? ` — check ${capitalize(worstAxis)} axis noise` : '') +
      ` / ${styleLabel}模式调参${tierZh}，建议优化`;
  } else {
    summary = `Tune needs significant work for ${styleLabel}` +
      (worstAxis ? ` — high noise on ${capitalize(worstAxis)} axis` : '') +
      ` / ${styleLabel}模式下调参${tierZh}，请认真优化`;
  }

  return {
    score, tier, summary,
    breakdown: { pidResponse: pidScore, vibration: vibrationScore, motorHealth: motorScore, filterEffectiveness: filterScore },
  };
}

/** Find the axis with highest gyro RMS noise. */
function findWorstAxis(gyroStats) {
  if (!gyroStats) return null;
  let worst = null, worstRms = 0;
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const rms = (gyroStats[axis] && gyroStats[axis].rms) || 0;
    if (rms > worstRms) { worstRms = rms; worst = axis; }
  }
  return worst;
}

function round2(n) { return Math.round(n * 100) / 100; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

module.exports = {
  analyzePIDs, generateCLICommands, generateDiffCLICommands, generateTuningNotes,
  applyStyleToAnalysis, computeFlightScore, computeChangeMagnitude, STYLE_PROFILES,
};
