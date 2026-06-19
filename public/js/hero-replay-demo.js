/**
 * Lightweight hero background Canvas animation with hardcoded demo flight data.
 * Owns: auto-playing quad attitude + motor glow animation for the homepage hero.
 * Does NOT own: full replay page, BBL parsing, or playback controls.
 */
/* global window, document, requestAnimationFrame, cancelAnimationFrame */
(function () {
  'use strict';

  // ~12s loop of simulated freestyle flight data (720 frames at 60fps)
  var FRAMES = 720;
  var demoData = generateDemoData(FRAMES);

  var C = {
    grid: 'rgba(0,212,255,0.04)',
    accent: '#00d4ff',
    accent2: '#ff6b35',
    green: '#a8ff3e',
    yellow: '#ffd93d',
    dim: 'rgba(136,153,170,0.4)',
    motorColors: ['#00d4ff', '#ff6b35', '#a8ff3e', '#ffd93d']
  };

  function generateDemoData(n) {
    var d = {
      gyroRoll: new Float32Array(n),
      gyroPitch: new Float32Array(n),
      gyroYaw: new Float32Array(n),
      motor: [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)],
      throttle: new Float32Array(n)
    };
    // Simulate a freestyle flight: rolls, flips, throttle surges
    for (var i = 0; i < n; i++) {
      var t = i / 60; // time in seconds
      // Gentle oscillation + bursts simulating rolls/flips
      d.gyroRoll[i] = Math.sin(t * 1.8) * 80 + Math.sin(t * 5.2) * 40 + (Math.random() - 0.5) * 20;
      d.gyroPitch[i] = Math.cos(t * 1.3) * 60 + Math.sin(t * 4.1 + 1) * 30 + (Math.random() - 0.5) * 15;
      d.gyroYaw[i] = Math.sin(t * 0.7 + 2) * 40 + (Math.random() - 0.5) * 10;

      // Throttle: base cruise with surges
      var thrBase = 0.45 + Math.sin(t * 0.9) * 0.15;
      var surge = Math.max(0, Math.sin(t * 2.5) * 0.3);
      d.throttle[i] = Math.max(0.1, Math.min(1, thrBase + surge));

      // Motors — asymmetric based on attitude
      var rollBias = d.gyroRoll[i] / 300;
      var pitchBias = d.gyroPitch[i] / 300;
      d.motor[0][i] = clamp01(d.throttle[i] + rollBias * 0.15 - pitchBias * 0.1);
      d.motor[1][i] = clamp01(d.throttle[i] - rollBias * 0.15 - pitchBias * 0.1);
      d.motor[2][i] = clamp01(d.throttle[i] - rollBias * 0.15 + pitchBias * 0.1);
      d.motor[3][i] = clamp01(d.throttle[i] + rollBias * 0.15 + pitchBias * 0.1);
    }
    return d;
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function initHeroReplay() {
    var canvas = document.getElementById('heroReplayCanvas');
    if (!canvas) return;

    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var frame = 0;
    var rafId = null;
    var lastTs = 0;

    function resize() {
      var rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
    }

    resize();
    window.addEventListener('resize', resize);

    function tick(ts) {
      if (!lastTs) lastTs = ts;
      var dt = (ts - lastTs) / 1000;
      lastTs = ts;

      frame += Math.max(1, Math.round(dt * 60));
      if (frame >= FRAMES) frame = 0;

      render(ctx, canvas, frame);
      rafId = requestAnimationFrame(tick);
    }

    // Use IntersectionObserver to only animate when visible
    if (typeof IntersectionObserver !== 'undefined') {
      var observer = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          if (!rafId) { lastTs = 0; rafId = requestAnimationFrame(tick); }
        } else {
          if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        }
      }, { threshold: 0.1 });
      observer.observe(canvas);
    } else {
      rafId = requestAnimationFrame(tick);
    }
  }

  function render(ctx, canvas, frame) {
    var w = canvas.width;
    var h = canvas.height;
    var dpr = window.devicePixelRatio || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cw = w / dpr;
    var ch = h / dpr;

    ctx.clearRect(0, 0, cw, ch);

    // --- Left side: Quad attitude viz ---
    var quadCx = cw * 0.3;
    var quadCy = ch * 0.5;
    var armLen = Math.min(cw * 0.15, ch * 0.25);

    // Grid lines background
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (var gi = 1; gi <= 3; gi++) {
      ctx.beginPath();
      ctx.arc(quadCx, quadCy, gi * armLen * 0.4, 0, Math.PI * 2);
      ctx.stroke();
    }

    var roll = demoData.gyroRoll[frame] / 300;
    var angles = [-Math.PI / 4, Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4];

    ctx.save();
    ctx.translate(quadCx, quadCy);
    ctx.rotate(roll);

    // Arms
    ctx.strokeStyle = 'rgba(232,237,242,0.2)';
    ctx.lineWidth = 1.5;
    for (var a = 0; a < 4; a++) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angles[a]) * armLen, Math.sin(angles[a]) * armLen);
      ctx.stroke();
    }

    // Motors
    for (var m = 0; m < 4; m++) {
      var mx = Math.cos(angles[m]) * armLen;
      var my = Math.sin(angles[m]) * armLen;
      var mVal = demoData.motor[m][frame];
      var mSize = 5 + mVal * 12;
      var color = C.motorColors[m];

      // Glow
      var grad = ctx.createRadialGradient(mx, my, 0, mx, my, mSize * 2.5);
      grad.addColorStop(0, colorWithAlpha(color, 0.3));
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(mx, my, mSize * 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.3 + mVal * 0.7;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(mx, my, mSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Center
    ctx.fillStyle = 'rgba(0,212,255,0.12)';
    ctx.strokeStyle = 'rgba(0,212,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Front arrow
    ctx.fillStyle = 'rgba(0,212,255,0.5)';
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(-4, -7);
    ctx.lineTo(4, -7);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // --- Right side: Gyro curves ---
    var curveLeft = cw * 0.55;
    var curveW = cw * 0.4;
    var curveTop = ch * 0.15;
    var curveH = ch * 0.45;

    // Curve background
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    roundRect(ctx, curveLeft, curveTop, curveW, curveH, 6);
    ctx.fill();

    // Zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(curveLeft, curveTop + curveH / 2);
    ctx.lineTo(curveLeft + curveW, curveTop + curveH / 2);
    ctx.stroke();

    // Draw 200-frame window of gyro
    var winSize = 200;
    var start = Math.max(0, frame - winSize);
    var end = Math.min(FRAMES, start + winSize);
    var maxG = 180;

    var gyros = [
      { data: demoData.gyroRoll, color: C.accent },
      { data: demoData.gyroPitch, color: C.accent2 },
      { data: demoData.gyroYaw, color: C.green }
    ];

    for (var g = 0; g < gyros.length; g++) {
      ctx.strokeStyle = gyros[g].color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (var fi = start; fi < end; fi++) {
        var fx = curveLeft + ((fi - start) / (end - start)) * curveW;
        var fy = curveTop + curveH / 2 - (gyros[g].data[fi] / maxG) * (curveH / 2);
        if (fi === start) ctx.moveTo(fx, fy);
        else ctx.lineTo(fx, fy);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Playhead
    var phX = curveLeft + ((frame - start) / (end - start)) * curveW;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(phX, curveTop);
    ctx.lineTo(phX, curveTop + curveH);
    ctx.stroke();
    ctx.setLineDash([]);

    // --- Throttle bar ---
    var thrTop = curveTop + curveH + 12;
    var thrH = ch * 0.15;
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    roundRect(ctx, curveLeft, thrTop, curveW, thrH, 4);
    ctx.fill();

    ctx.strokeStyle = C.yellow;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    for (var ti = start; ti < end; ti++) {
      var tx = curveLeft + ((ti - start) / (end - start)) * curveW;
      var ty = thrTop + thrH - demoData.throttle[ti] * thrH;
      if (ti === start) ctx.moveTo(tx, ty);
      else ctx.lineTo(tx, ty);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Labels (subtle)
    ctx.fillStyle = C.dim;
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('GYRO', curveLeft + 6, curveTop + 12);
    ctx.fillText('THR', curveLeft + 6, thrTop + 12);
  }

  function colorWithAlpha(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHeroReplay);
  } else {
    initHeroReplay();
  }
})();
