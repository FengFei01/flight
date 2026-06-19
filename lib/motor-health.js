'use strict';

const AXES = ['roll', 'pitch', 'yaw'];
const FREQ_SPLIT_HZ = 300;

function estimateRPM(throttlePct) {
  return 3000 + (throttlePct / 100) * 27000;
}

function detectBearingWear(axisSpectrum) {
  const { frequencies, magnitudesDB } = axisSpectrum;
  if (!frequencies || frequencies.length < 4) return null;

  let lowSum = 0, lowCount = 0, highSum = 0, highCount = 0;
  for (let i = 0; i < frequencies.length; i++) {
    if (frequencies[i] <= FREQ_SPLIT_HZ) {
      lowSum += magnitudesDB[i];
      lowCount++;
    } else {
      highSum += magnitudesDB[i];
      highCount++;
    }
  }
  if (lowCount === 0 || highCount === 0) return null;

  const lowAvg = lowSum / lowCount;
  const highAvg = highSum / highCount;
  const gap = lowAvg - highAvg;

  if (gap < 10) {
    const severity = gap < 3 ? 'severe' : gap < 6 ? 'moderate' : 'mild';
    return {
      type: 'bearing_wear',
      severity,
      detail: `高频噪声底线偏高 (High-freq noise floor elevated) — gap ${gap.toFixed(1)} dB`,
      _gap: gap,
    };
  }
  return null;
}

function detectImbalance(axisSpectrum, avgThrottlePct) {
  const { peaks } = axisSpectrum;
  if (!peaks || peaks.length === 0) return null;

  const rpm = estimateRPM(avgThrottlePct);
  const f1x = rpm / 60;
  const tolerance = f1x * 0.15;

  for (const peak of peaks) {
    if (Math.abs(peak.freq - f1x) <= tolerance && peak.prominence >= 8) {
      const severity = peak.prominence >= 18 ? 'severe' : peak.prominence >= 12 ? 'moderate' : 'mild';
      return {
        type: 'imbalance',
        severity,
        detail: `1x RPM 尖峰 (1x spike at ~${Math.round(f1x)} Hz, prominence ${peak.prominence.toFixed(1)} dB)`,
        _prominence: peak.prominence,
        _f1x: f1x,
      };
    }
  }
  return null;
}

function detectPropDamage(axisSpectrum, avgThrottlePct) {
  const { peaks } = axisSpectrum;
  if (!peaks || peaks.length === 0) return null;

  const rpm = estimateRPM(avgThrottlePct);
  const f1x = rpm / 60;
  const tolerance = f1x * 0.15;

  const f1xPeak = peaks.find(p => Math.abs(p.freq - f1x) <= tolerance);
  if (!f1xPeak) return null;

  const f2x = f1x * 2;
  const f3x = f1x * 3;
  let harmonicProminence = 0;
  const f2xPeak = peaks.find(p => Math.abs(p.freq - f2x) <= f2x * 0.15);
  const f3xPeak = peaks.find(p => Math.abs(p.freq - f3x) <= f3x * 0.15);
  if (f2xPeak) harmonicProminence += f2xPeak.prominence;
  if (f3xPeak) harmonicProminence += f3xPeak.prominence;

  if (harmonicProminence > f1xPeak.prominence * 0.5) {
    const severity = harmonicProminence > f1xPeak.prominence ? 'severe' : 'moderate';
    return {
      type: 'prop_damage',
      severity,
      detail: `谐波异常 (Harmonic energy at 2x/3x of ${Math.round(f1x)} Hz — ratio ${(harmonicProminence / f1xPeak.prominence).toFixed(2)})`,
      _harmonicRatio: harmonicProminence / f1xPeak.prominence,
    };
  }
  return null;
}

function detectMotorMismatch(bandSpectrum) {
  const roll = bandSpectrum.roll;
  const pitch = bandSpectrum.pitch;
  if (!roll || !pitch) return null;
  if (!roll.magnitudesDB || !pitch.magnitudesDB) return null;
  const n = Math.min(roll.magnitudesDB.length, pitch.magnitudesDB.length);
  if (n < 4) return null;

  let sumR = 0, sumP = 0;
  for (let i = 0; i < n; i++) {
    sumR += roll.magnitudesDB[i];
    sumP += pitch.magnitudesDB[i];
  }
  const meanR = sumR / n;
  const meanP = sumP / n;

  let cov = 0, varR = 0, varP = 0;
  for (let i = 0; i < n; i++) {
    const dr = roll.magnitudesDB[i] - meanR;
    const dp = pitch.magnitudesDB[i] - meanP;
    cov += dr * dp;
    varR += dr * dr;
    varP += dp * dp;
  }

  const denom = Math.sqrt(varR * varP);
  const correlation = denom > 0 ? cov / denom : 1;

  if (correlation < 0.7) {
    const severity = correlation < 0.3 ? 'severe' : correlation < 0.5 ? 'moderate' : 'mild';
    return {
      type: 'motor_mismatch',
      severity,
      detail: `轴间频谱差异大 (Roll/Pitch spectral correlation ${correlation.toFixed(2)})`,
      _correlation: correlation,
    };
  }
  return null;
}

const SEVERITY_DEDUCTIONS = {
  bearing_wear:   { mild: 15, moderate: 22, severe: 30 },
  imbalance:      { mild: 10, moderate: 18, severe: 25 },
  prop_damage:    { mild: 10, moderate: 15, severe: 20 },
  motor_mismatch: { mild: 5,  moderate: 10, severe: 15 },
};

function computeAxisHealth(issues) {
  let score = 100;
  for (const issue of issues) {
    const deductions = SEVERITY_DEDUCTIONS[issue.type];
    if (deductions) score -= deductions[issue.severity] || 10;
  }
  score = Math.max(0, Math.min(100, score));
  const rating = score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical';
  return { score, rating };
}

function escalateSeverity(sev) {
  if (sev === 'mild') return 'moderate';
  if (sev === 'moderate') return 'severe';
  return 'severe';
}

function analyzeSymmetry(axes) {
  const scores = AXES.map(a => axes[a].score);
  const maxScore = Math.max(...scores);
  const variance = scores.reduce((s, v) => s + (maxScore - v) * (maxScore - v), 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const score = Math.max(0, Math.round(100 - stddev * 3));
  const rating = score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical';

  const outliers = [];
  for (const axis of AXES) {
    if (axes[axis].score < maxScore - 15) {
      outliers.push(axis);
    }
  }

  let diagnosis;
  if (outliers.length === 1) {
    const ax = outliers[0].charAt(0).toUpperCase() + outliers[0].slice(1);
    diagnosis = {
      type: 'single_motor',
      message: ax + ' axis motor may have a hardware issue. / ' + ax + '轴电机可能有硬件问题，建议单独检查该电机。',
    };
  } else if (outliers.length >= 2) {
    diagnosis = {
      type: 'multi_motor',
      message: 'Multiple axes show abnormal readings — likely a mounting/frame vibration issue. Check screws and dampening. / 多轴异常，可能是安装或机架振动问题，建议检查螺丝和减震。',
    };
  } else {
    diagnosis = {
      type: 'balanced',
      message: 'All motors are well-matched. / 所有电机一致性良好。',
    };
  }

  return { score, rating, outliers, diagnosis };
}

function analyzeMotorHealth(throttleAnalysis) {
  const defaultResult = {
    axes: {
      roll:  { score: 100, rating: 'healthy', issues: [] },
      pitch: { score: 100, rating: 'healthy', issues: [] },
      yaw:   { score: 100, rating: 'healthy', issues: [] },
    },
    overall: { score: 100, rating: 'healthy' },
    symmetry: { score: 100, rating: 'healthy', outliers: [], diagnosis: { type: 'balanced', message: 'All motors are well-matched. / 所有电机一致性良好。' } },
    issues: [],
  };

  if (!throttleAnalysis || !throttleAnalysis.bands || !Array.isArray(throttleAnalysis.bands)) {
    return defaultResult;
  }

  const validBands = throttleAnalysis.bands.filter(b => b.valid);
  if (validBands.length === 0) return defaultResult;

  const axisIssueMap = {};
  for (const axis of AXES) axisIssueMap[axis] = {};

  for (const band of validBands) {
    if (!band.spectrum || !band.spectrum.axes) continue;
    const avgThrottle = band.averageThrottle || 50;

    for (const axis of AXES) {
      const axisData = band.spectrum.axes[axis];
      if (!axisData) continue;

      const detectors = [
        detectBearingWear(axisData),
        detectImbalance(axisData, avgThrottle),
        detectPropDamage(axisData, avgThrottle),
      ];

      for (const issue of detectors) {
        if (!issue) continue;
        const existing = axisIssueMap[axis][issue.type];
        if (existing) {
          existing.bandCount++;
          if (['moderate', 'severe'].indexOf(issue.severity) >
              ['moderate', 'severe'].indexOf(existing.severity)) {
            existing.severity = issue.severity;
            existing.detail = issue.detail;
          }
        } else {
          axisIssueMap[axis][issue.type] = { ...issue, axis, bandCount: 1 };
        }
      }
    }

    const mismatch = detectMotorMismatch(band.spectrum.axes);
    if (mismatch) {
      for (const axis of ['roll', 'pitch']) {
        const existing = axisIssueMap[axis][mismatch.type];
        if (existing) {
          existing.bandCount++;
        } else {
          axisIssueMap[axis][mismatch.type] = { ...mismatch, axis, bandCount: 1 };
        }
      }
    }
  }

  const result = { axes: {}, overall: { score: 100, rating: 'healthy' }, issues: [] };

  for (const axis of AXES) {
    const issueList = Object.values(axisIssueMap[axis]);
    for (const issue of issueList) {
      if (issue.bandCount >= 3) {
        issue.severity = escalateSeverity(issue.severity);
      }
    }
    const health = computeAxisHealth(issueList);
    result.axes[axis] = { score: health.score, rating: health.rating, issues: issueList };
    result.issues.push(...issueList);
  }

  result.symmetry = analyzeSymmetry(result.axes);

  const minScore = Math.min(result.axes.roll.score, result.axes.pitch.score, result.axes.yaw.score);
  result.overall.score = minScore;
  result.overall.rating = minScore >= 80 ? 'healthy' : minScore >= 50 ? 'warning' : 'critical';

  return result;
}

module.exports = { analyzeMotorHealth, analyzeSymmetry };
