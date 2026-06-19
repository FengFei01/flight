/**
 * Radix-2 Cooley-Tukey FFT — browser-side, no dependencies.
 * Owns: forward FFT transform, Hann windowing, magnitude spectrum.
 * Does NOT own: peak detection or chart rendering.
 */

/* global window */
(function (exports) {
  'use strict';

  /**
   * Forward FFT on a real-valued input signal.
   * @param {number[]} signal — time-domain samples (length will be padded to next power-of-2)
   * @returns {{ magnitudes: Float64Array, frequencies: Float64Array, binCount: number }}
   */
  function fft(signal, sampleRate) {
    var N = nextPow2(signal.length);
    var re = new Float64Array(N);
    var im = new Float64Array(N);

    // Apply Hann window and copy into real part
    for (var i = 0; i < signal.length; i++) {
      var w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (signal.length - 1)));
      re[i] = signal[i] * w;
    }

    // Bit-reversal permutation
    bitReverse(re, im, N);

    // Cooley-Tukey butterfly
    for (var size = 2; size <= N; size *= 2) {
      var half = size / 2;
      var angle = -2 * Math.PI / size;
      var wRe = Math.cos(angle);
      var wIm = Math.sin(angle);

      for (var j = 0; j < N; j += size) {
        var curRe = 1, curIm = 0;
        for (var k = 0; k < half; k++) {
          var evenIdx = j + k;
          var oddIdx = j + k + half;

          var tRe = curRe * re[oddIdx] - curIm * im[oddIdx];
          var tIm = curRe * im[oddIdx] + curIm * re[oddIdx];

          re[oddIdx] = re[evenIdx] - tRe;
          im[oddIdx] = im[evenIdx] - tIm;
          re[evenIdx] = re[evenIdx] + tRe;
          im[evenIdx] = im[evenIdx] + tIm;

          var nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
        }
      }
    }

    // Compute magnitude spectrum (only first half — Nyquist)
    var binCount = N / 2;
    var magnitudes = new Float64Array(binCount);
    var frequencies = new Float64Array(binCount);
    var freqStep = sampleRate / N;

    for (var m = 0; m < binCount; m++) {
      magnitudes[m] = Math.sqrt(re[m] * re[m] + im[m] * im[m]) / N;
      frequencies[m] = m * freqStep;
    }

    return { magnitudes: magnitudes, frequencies: frequencies, binCount: binCount };
  }

  /**
   * Convert magnitude spectrum to dB scale.
   * @param {Float64Array} magnitudes
   * @returns {Float64Array} dB values (0 dB = max magnitude)
   */
  function toDecibels(magnitudes) {
    var maxMag = 0;
    for (var i = 0; i < magnitudes.length; i++) {
      if (magnitudes[i] > maxMag) maxMag = magnitudes[i];
    }
    if (maxMag === 0) maxMag = 1; // avoid log(0)

    var db = new Float64Array(magnitudes.length);
    for (var j = 0; j < magnitudes.length; j++) {
      db[j] = 20 * Math.log10(magnitudes[j] / maxMag + 1e-12);
    }
    return db;
  }

  /** Bit-reversal permutation in-place */
  function bitReverse(re, im, N) {
    var bits = Math.log2(N);
    for (var i = 0; i < N; i++) {
      var rev = 0;
      for (var b = 0; b < bits; b++) {
        rev = (rev << 1) | ((i >> b) & 1);
      }
      if (rev > i) {
        var tmpR = re[i]; re[i] = re[rev]; re[rev] = tmpR;
        var tmpI = im[i]; im[i] = im[rev]; im[rev] = tmpI;
      }
    }
  }

  /** Next power of 2 >= n */
  function nextPow2(n) {
    var p = 1;
    while (p < n) p *= 2;
    return p;
  }

  exports.FFT = { fft: fft, toDecibels: toDecibels };
})(typeof window !== 'undefined' ? window : module.exports);
