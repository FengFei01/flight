/**
 * Betaflight version-aware CLI parameter mapping.
 * Maps internal parameter names to the correct CLI names for each BF version.
 * UMD: works as Node require() and browser <script> (window.BfVersionMap).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BfVersionMap = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  var BF_VERSIONS = ['4.2', '4.3', '4.4', '4.5'];

  // Internal name → { '4.2': cliName, ... }
  // null means the parameter does not exist in that version (skip it)
  var PARAM_MAP = {
    d_max_roll:      { '4.2': 'd_max_roll',  '4.3': 'd_max_roll',  '4.4': 'd_max_roll',  '4.5': null },
    d_max_pitch:     { '4.2': 'd_max_pitch', '4.3': 'd_max_pitch', '4.4': 'd_max_pitch', '4.5': null },
    d_max_yaw:       { '4.2': 'd_max_yaw',   '4.3': 'd_max_yaw',   '4.4': 'd_max_yaw',   '4.5': null },
    gyro_lowpass_hz:  { '4.2': 'gyro_lowpass_hz',  '4.3': 'gyro_lpf1_static_hz',  '4.4': 'gyro_lpf1_static_hz',  '4.5': 'gyro_lpf1_static_hz' },
    dterm_lowpass_hz: { '4.2': 'dterm_lowpass_hz', '4.3': 'dterm_lpf1_static_hz', '4.4': 'dterm_lpf1_static_hz', '4.5': 'dterm_lpf1_static_hz' },
  };

  function mapParam(internalName, bfVersion) {
    var entry = PARAM_MAP[internalName];
    if (!entry) return internalName;
    var ver = bfVersion || '4.3';
    if (entry.hasOwnProperty(ver)) return entry[ver];
    return internalName;
  }

  function detectBfVersion(firmwareVersionStr) {
    if (!firmwareVersionStr) return '4.3';
    var m = String(firmwareVersionStr).match(/(\d+)\.(\d+)/);
    if (!m) return '4.3';
    var key = m[1] + '.' + m[2];
    if (BF_VERSIONS.indexOf(key) !== -1) return key;
    return '4.3';
  }

  function generateCLIFromAnalysis(data, bfVersion) {
    var rec = data.recommended;
    var filters = data.filters;
    var header = data.header || {};
    var ver = bfVersion || '4.3';
    var lines = [];

    lines.push('# FlightForge PID Recommendations');
    lines.push('# Target: Betaflight ' + ver);
    if (header.craftName) lines.push('# Craft: ' + (header.craftName || 'Unknown'));
    if (header.firmware || header.firmwareVersion) {
      lines.push('# Firmware: ' + (header.firmware || '') + ' ' + (header.firmwareVersion || ''));
    }
    lines.push('');
    lines.push('# === PID Values ===');

    var axes = ['roll', 'pitch', 'yaw'];
    var pidParams = ['p', 'i', 'd', 'f'];

    for (var a = 0; a < axes.length; a++) {
      var axis = axes[a];
      var axisRec = rec[axis];
      if (!axisRec) continue;

      for (var p = 0; p < pidParams.length; p++) {
        var param = pidParams[p];
        if (axisRec[param] != null) {
          lines.push('set ' + param + '_' + axis + ' = ' + axisRec[param]);
        }
      }

      // D_Max — version-mapped
      if (axisRec.dMax != null) {
        var dMaxName = mapParam('d_max_' + axis, ver);
        if (dMaxName !== null) {
          lines.push('set ' + dMaxName + ' = ' + axisRec.dMax);
        }
      }
    }

    // D_Max skip note for BF 4.5+
    if (mapParam('d_max_roll', ver) === null) {
      lines.push('');
      lines.push('# Note: D_Max is not a separate CLI parameter in BF 4.5+ (managed via Simplified Tuning)');
    }

    lines.push('');
    lines.push('# === Filter Settings ===');

    var gyroName = mapParam('gyro_lowpass_hz', ver);
    if (gyroName !== null && filters && filters.gyro_lowpass_hz != null) {
      lines.push('set ' + gyroName + ' = ' + filters.gyro_lowpass_hz);
    }

    var dtermName = mapParam('dterm_lowpass_hz', ver);
    if (dtermName !== null && filters && filters.dterm_lowpass_hz != null) {
      lines.push('set ' + dtermName + ' = ' + filters.dterm_lowpass_hz);
    }

    lines.push('');
    lines.push('save');

    return lines.join('\n');
  }

  /**
   * Generate diff-only CLI export — only includes set commands where
   * the recommended value differs from the current (original) value.
   * Returns empty string if no changes are recommended.
   */
  function generateDiffCLI(data, bfVersion) {
    var rec = data.recommended;
    var cur = data.current || {};
    var filters = data.filters || {};
    var header = data.header || {};
    var ver = bfVersion || '4.3';
    var setLines = [];

    var axes = ['roll', 'pitch', 'yaw'];
    var pidParams = ['p', 'i', 'd', 'f'];

    for (var a = 0; a < axes.length; a++) {
      var axis = axes[a];
      var axisRec = rec[axis];
      var axisCur = cur[axis] || {};
      if (!axisRec) continue;

      for (var p = 0; p < pidParams.length; p++) {
        var param = pidParams[p];
        if (axisRec[param] == null) continue;
        // For 'd', compare against dMin if available (BF 4.3+ header)
        var curVal = param === 'd'
          ? (axisCur.dMin != null ? axisCur.dMin : axisCur.d)
          : axisCur[param];
        if (curVal != null && axisRec[param] === curVal) continue;
        setLines.push('set ' + param + '_' + axis + ' = ' + axisRec[param]);
      }

      // D_Max — version-mapped
      if (axisRec.dMax != null) {
        var dMaxName = mapParam('d_max_' + axis, ver);
        if (dMaxName !== null) {
          var curDMax = axisCur.dMax;
          if (curDMax == null || axisRec.dMax !== curDMax) {
            setLines.push('set ' + dMaxName + ' = ' + axisRec.dMax);
          }
        }
      }
    }

    // Filter diffs
    var gyroName = mapParam('gyro_lowpass_hz', ver);
    if (gyroName !== null && filters.gyro_lowpass_hz != null) {
      var curGyro = filters.currentGyro && filters.currentGyro.lowpass;
      if (curGyro == null || filters.gyro_lowpass_hz !== curGyro) {
        setLines.push('set ' + gyroName + ' = ' + filters.gyro_lowpass_hz);
      }
    }
    var dtermName = mapParam('dterm_lowpass_hz', ver);
    if (dtermName !== null && filters.dterm_lowpass_hz != null) {
      var curDterm = filters.currentDterm && filters.currentDterm.lowpass;
      if (curDterm == null || filters.dterm_lowpass_hz !== curDterm) {
        setLines.push('set ' + dtermName + ' = ' + filters.dterm_lowpass_hz);
      }
    }

    if (setLines.length === 0) return '';

    var lines = [];
    lines.push('# FlightForge — Changes Only');
    lines.push('# Betaflight ' + ver);
    if (header.craftName && header.craftName !== 'Unknown') {
      lines.push('# Craft: ' + header.craftName);
    }
    lines.push('');
    lines = lines.concat(setLines);
    lines.push('');
    lines.push('save');
    return lines.join('\n');
  }

  return {
    BF_VERSIONS: BF_VERSIONS,
    PARAM_MAP: PARAM_MAP,
    mapParam: mapParam,
    detectBfVersion: detectBfVersion,
    generateCLIFromAnalysis: generateCLIFromAnalysis,
    generateDiffCLI: generateDiffCLI,
  };
});
