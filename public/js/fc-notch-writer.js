/**
 * FC Notch Writer — reads/writes Notch filter config via MSP_FILTER_CONFIG.
 * Owns: MSP filter config read/write, rollback, verification, Notch write UI.
 * Does NOT own: peak detection (spectrum-analyzer.js), MSP protocol (msp-client.js),
 *               connection state (fc-connection-manager.js).
 */

/* global FcConnectionManager, MSP_CODES, SpectrumAnalyzer, document */

(function () {
  'use strict';

  var originalFilterConfig = null; // Backup of full MSP_FILTER_CONFIG payload before write
  var lastFilterPayload = null;    // Most recent MSP_FILTER_CONFIG read payload

  // DOM refs
  var applyNotchBtn, restoreNotchBtn, notchWriteStatusEl;

  /**
   * Parse MSP_FILTER_CONFIG response (cmd 92).
   * Betaflight layout (BF 4.x, ~28+ bytes):
   *   [0]    gyro_lowpass_hz (U8)
   *   [1-2]  dterm_lowpass_hz (U16 LE)
   *   [3-4]  yaw_lowpass_hz (U16 LE)
   *   [5-6]  gyro_notch_hz_1 (U16 LE)
   *   [7-8]  gyro_notch_cutoff_1 (U16 LE)
   *   [9-10] dterm_notch_hz (U16 LE)
   *   [11-12] dterm_notch_cutoff (U16 LE)
   *   [13-14] gyro_notch_hz_2 (U16 LE)
   *   [15-16] gyro_notch_cutoff_2 (U16 LE)
   *   (more fields follow but we only touch notch)
   */
  function parseFilterConfig(payload) {
    if (!payload || payload.length < 17) return null;

    return {
      gyro_lowpass_hz: payload[0],
      dterm_lowpass_hz: payload[1] | (payload[2] << 8),
      yaw_lowpass_hz: payload[3] | (payload[4] << 8),
      gyro_notch_hz_1: payload[5] | (payload[6] << 8),
      gyro_notch_cutoff_1: payload[7] | (payload[8] << 8),
      dterm_notch_hz: payload[9] | (payload[10] << 8),
      dterm_notch_cutoff: payload[11] | (payload[12] << 8),
      gyro_notch_hz_2: payload[13] | (payload[14] << 8),
      gyro_notch_cutoff_2: payload[15] | (payload[16] << 8),
    };
  }

  /**
   * Build MSP_SET_FILTER_CONFIG payload (cmd 29) via read-modify-write.
   * Patches only notch fields, keeps everything else unchanged.
   * @param {Array} basePayload — last-read full filter config payload
   * @param {Object} notch — { notch_hz_1, notch_cutoff_1, notch_hz_2, notch_cutoff_2 }
   * @returns {Array|null} payload to send, or null if base too short
   */
  function buildFilterPayload(basePayload, notch) {
    if (!basePayload || basePayload.length < 17) return null;
    var payload = basePayload.slice(); // Copy full payload

    // Patch gyro_notch_hz_1 (U16 LE at offset 5-6)
    var hz1 = notch.notch_hz_1 || 0;
    payload[5] = hz1 & 0xFF;
    payload[6] = (hz1 >> 8) & 0xFF;

    // Patch gyro_notch_cutoff_1 (U16 LE at offset 7-8)
    var cut1 = notch.notch_cutoff_1 || 0;
    payload[7] = cut1 & 0xFF;
    payload[8] = (cut1 >> 8) & 0xFF;

    // Patch gyro_notch_hz_2 (U16 LE at offset 13-14)
    var hz2 = notch.notch_hz_2 || 0;
    payload[13] = hz2 & 0xFF;
    payload[14] = (hz2 >> 8) & 0xFF;

    // Patch gyro_notch_cutoff_2 (U16 LE at offset 15-16)
    var cut2 = notch.notch_cutoff_2 || 0;
    payload[15] = cut2 & 0xFF;
    payload[16] = (cut2 >> 8) & 0xFF;

    return payload;
  }

  /** Set UI write status */
  function setNotchWriteStatus(msg, type) {
    if (!notchWriteStatusEl) return;
    notchWriteStatusEl.textContent = msg;
    notchWriteStatusEl.className = 'notch-write-status' + (type ? ' notch-write-' + type : '');
    notchWriteStatusEl.style.display = msg ? 'block' : 'none';
  }

  /** Get the best notch values from suggestions (top 2 across all axes) */
  function getNotchValuesFromSuggestions() {
    var container = document.getElementById('notchSuggestionsSection');
    if (!container) return null;

    var data = container.getAttribute('data-notch');
    if (!data) return null;

    var notchResult;
    try { notchResult = JSON.parse(data); } catch (_e) { return null; }

    var suggestions = notchResult.suggestions || [];
    if (suggestions.length === 0) return null;

    // Sort by prominence descending, take top 2
    suggestions.sort(function (a, b) { return b.prominence - a.prominence; });

    var result = {
      notch_hz_1: 0, notch_cutoff_1: 0,
      notch_hz_2: 0, notch_cutoff_2: 0
    };

    if (suggestions.length >= 1) {
      result.notch_hz_1 = suggestions[0].centerHz;
      result.notch_cutoff_1 = suggestions[0].cutoffHz;
    }
    if (suggestions.length >= 2) {
      result.notch_hz_2 = suggestions[1].centerHz;
      result.notch_cutoff_2 = suggestions[1].cutoffHz;
    }

    return result;
  }

  /** Read current filter config from FC */
  async function readFilterConfig() {
    var client = FcConnectionManager.getClient();
    if (!client || !client.isConnected()) return null;

    var resp = await client.sendCommand(MSP_CODES.MSP_FILTER_CONFIG);
    lastFilterPayload = resp.payload.slice();
    return parseFilterConfig(resp.payload);
  }

  /** Write notch params to FC, verify, and show result */
  async function writeNotchToFc() {
    var client = FcConnectionManager.getClient();
    if (!client || !client.isConnected()) {
      setNotchWriteStatus('请先连接飞控', 'error');
      return;
    }

    var notchVals = getNotchValuesFromSuggestions();
    if (!notchVals) {
      setNotchWriteStatus('无可用 Notch 参数', 'error');
      return;
    }

    if (applyNotchBtn) {
      applyNotchBtn.disabled = true;
      applyNotchBtn.innerHTML = '<span class="spinner"></span> 写入中...';
    }

    try {
      // 1. Read current filter config (backup)
      setNotchWriteStatus('读取当前滤波器配置...');
      var resp = await client.sendCommand(MSP_CODES.MSP_FILTER_CONFIG);
      lastFilterPayload = resp.payload.slice();

      // Save original for rollback (only first time)
      if (!originalFilterConfig) {
        originalFilterConfig = resp.payload.slice();
      }

      // 2. Build patched payload
      var payload = buildFilterPayload(lastFilterPayload, notchVals);
      if (!payload) {
        setNotchWriteStatus('滤波器配置数据不完整，无法写入', 'error');
        return;
      }

      // 3. Write MSP_SET_FILTER_CONFIG (cmd 29)
      setNotchWriteStatus('写入 Notch 滤波器参数...');
      await client.sendCommand(MSP_CODES.MSP_SET_FILTER_CONFIG, payload);

      // 4. Save to EEPROM
      setNotchWriteStatus('保存到 EEPROM...');
      await client.sendCommand(MSP_CODES.MSP_EEPROM_WRITE);

      // 5. Re-read to verify
      setNotchWriteStatus('校验中...');
      var verifyResp = await client.sendCommand(MSP_CODES.MSP_FILTER_CONFIG);
      lastFilterPayload = verifyResp.payload.slice();
      var verified = parseFilterConfig(verifyResp.payload);

      if (!verified) {
        setNotchWriteStatus('⚠️ 无法读取校验数据，建议重试', 'warning');
        return;
      }

      // Compare written vs read-back
      var mismatches = [];
      if (verified.gyro_notch_hz_1 !== notchVals.notch_hz_1) mismatches.push('Notch1_Hz: wrote=' + notchVals.notch_hz_1 + ' read=' + verified.gyro_notch_hz_1);
      if (verified.gyro_notch_cutoff_1 !== notchVals.notch_cutoff_1) mismatches.push('Notch1_Cut: wrote=' + notchVals.notch_cutoff_1 + ' read=' + verified.gyro_notch_cutoff_1);
      if (verified.gyro_notch_hz_2 !== notchVals.notch_hz_2) mismatches.push('Notch2_Hz: wrote=' + notchVals.notch_hz_2 + ' read=' + verified.gyro_notch_hz_2);
      if (verified.gyro_notch_cutoff_2 !== notchVals.notch_cutoff_2) mismatches.push('Notch2_Cut: wrote=' + notchVals.notch_cutoff_2 + ' read=' + verified.gyro_notch_cutoff_2);

      if (mismatches.length === 0) {
        setNotchWriteStatus('✅ 滤波器配置已写入飞控，建议试飞后检查飞行手感', 'success');
        if (restoreNotchBtn) restoreNotchBtn.style.display = 'inline-flex';
      } else {
        setNotchWriteStatus('⚠️ 写入校验失败，建议重试。不匹配: ' + mismatches.join(', '), 'warning');
      }
    } catch (err) {
      setNotchWriteStatus('写入失败: ' + err.message, 'error');
    } finally {
      if (applyNotchBtn) {
        applyNotchBtn.disabled = false;
        applyNotchBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg> 写入 Notch 到飞控';
      }
    }
  }

  /** Restore original filter config (rollback) */
  async function restoreOriginalFilter() {
    var client = FcConnectionManager.getClient();
    if (!client || !client.isConnected()) {
      setNotchWriteStatus('请先连接飞控', 'error');
      return;
    }

    if (!originalFilterConfig) {
      setNotchWriteStatus('无备份数据可恢复', 'error');
      return;
    }

    if (restoreNotchBtn) {
      restoreNotchBtn.disabled = true;
      restoreNotchBtn.innerHTML = '<span class="spinner"></span> 恢复中...';
    }

    try {
      setNotchWriteStatus('恢复原始滤波器配置...');
      await client.sendCommand(MSP_CODES.MSP_SET_FILTER_CONFIG, originalFilterConfig.slice());
      await client.sendCommand(MSP_CODES.MSP_EEPROM_WRITE);

      // Verify
      var verifyResp = await client.sendCommand(MSP_CODES.MSP_FILTER_CONFIG);
      lastFilterPayload = verifyResp.payload.slice();
      var restored = parseFilterConfig(verifyResp.payload);
      var original = parseFilterConfig(originalFilterConfig);

      if (restored && original &&
          restored.gyro_notch_hz_1 === original.gyro_notch_hz_1 &&
          restored.gyro_notch_cutoff_1 === original.gyro_notch_cutoff_1 &&
          restored.gyro_notch_hz_2 === original.gyro_notch_hz_2 &&
          restored.gyro_notch_cutoff_2 === original.gyro_notch_cutoff_2) {
        setNotchWriteStatus('✅ 已恢复原始滤波器配置', 'success');
      } else {
        setNotchWriteStatus('⚠️ 恢复校验不完全一致，建议检查配置', 'warning');
      }
    } catch (err) {
      setNotchWriteStatus('恢复失败: ' + err.message, 'error');
    } finally {
      if (restoreNotchBtn) {
        restoreNotchBtn.disabled = false;
        restoreNotchBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg> 恢复原始滤波器';
      }
    }
  }

  /** Initialize notch writer UI */
  function init() {
    applyNotchBtn = document.getElementById('applyNotchBtn');
    restoreNotchBtn = document.getElementById('restoreNotchBtn');
    notchWriteStatusEl = document.getElementById('notchWriteStatus');

    if (applyNotchBtn) {
      applyNotchBtn.addEventListener('click', writeNotchToFc);
    }
    if (restoreNotchBtn) {
      restoreNotchBtn.addEventListener('click', restoreOriginalFilter);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for testing
  if (typeof window !== 'undefined') {
    window.FcNotchWriter = {
      parseFilterConfig: parseFilterConfig,
      buildFilterPayload: buildFilterPayload,
    };
  }
})();
