/**
 * Canvas 2D flight replay renderer.
 * Owns: quad attitude top-down view, motor visualisation, gyro/throttle curves, playback controls.
 * Does NOT own: BBL parsing (worker) or hero demo mode (hero-replay-demo.js).
 */
/* global window, document, requestAnimationFrame, cancelAnimationFrame */
(function (exports) {
  'use strict';

  // --- colour palette (neon dark) ---
  var C = {
    bg: '#0d0d0f',
    grid: 'rgba(0,212,255,0.06)',
    accent: '#00d4ff',
    accent2: '#ff6b35',
    green: '#a8ff3e',
    red: '#ff6b6b',
    yellow: '#ffd93d',
    text: '#e8edf2',
    dim: '#556677',
    motorColors: ['#00d4ff', '#ff6b35', '#a8ff3e', '#ffd93d']
  };

  /* ======== FlightReplay class ======== */
  function FlightReplay(opts) {
    this.quadCanvas = opts.quadCanvas;   // <canvas> for attitude + motors
    this.curveCanvas = opts.curveCanvas; // <canvas> for gyro/throttle curves
    this.quadCtx = null;
    this.curveCtx = this.curveCanvas.getContext('2d');
    this.data = null;
    this.frame = 0;
    this.playing = false;
    this.speed = 1;
    this.rafId = null;
    this.lastTs = 0;
    this.framesPerSec = 60;
    this.onFrameChange = opts.onFrameChange || null;
    this.motion = null;
    this.trace = null;
    this.kinematics = null;
    this.scene3D = null;

    if (!(typeof window !== 'undefined' && window.THREE)) {
      this.quadCtx = this.quadCanvas.getContext('2d');
    }

    // Curve window — show 300 frames at a time
    this.curveWindow = 300;
  }

  FlightReplay.prototype.loadData = function (parsedData) {
    this.data = parsedData;
    this.motion = buildDisplayMotion(parsedData);
    this.trace = buildDisplayTrace(parsedData, this.motion);
    this.kinematics = buildReplayKinematics(parsedData, this.motion);
    this.ensureScene3D();
    this.syncScene3D();
    this.frame = 0;
    this.framesPerSec = parsedData.count / Math.max(parsedData.durationSec, 0.1);
    if (this.framesPerSec > 500) this.framesPerSec = 60;
    if (this.framesPerSec < 1) this.framesPerSec = 60;
    this.resizeCanvases();
    this.renderFrame();
  };

  FlightReplay.prototype.resizeCanvases = function () {
    var dpr = window.devicePixelRatio || 1;
    if (this.scene3D) resizeSceneCanvas(this.quadCanvas, this.scene3D.renderer, this.scene3D.camera, dpr);
    else if (this.quadCtx) resizeCanvas(this.quadCanvas, this.quadCtx, dpr);
    resizeCanvas(this.curveCanvas, this.curveCtx, dpr);
  };

  FlightReplay.prototype.play = function () {
    if (this.playing || !this.data) return;
    this.playing = true;
    this.lastTs = performance.now();
    this._tick = this._tick.bind(this);
    this.rafId = requestAnimationFrame(this._tick);
  };

  FlightReplay.prototype.pause = function () {
    this.playing = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
  };

  FlightReplay.prototype.togglePlay = function () {
    this.playing ? this.pause() : this.play();
  };

  FlightReplay.prototype.setSpeed = function (s) {
    this.speed = s;
  };

  FlightReplay.prototype.seek = function (fraction) {
    if (!this.data) return;
    this.frame = Math.floor(fraction * (this.data.count - 1));
    this.renderFrame();
  };

  FlightReplay.prototype.seekFrame = function (f) {
    if (!this.data) return;
    this.frame = Math.max(0, Math.min(f, this.data.count - 1));
    this.renderFrame();
  };

  FlightReplay.prototype._tick = function (ts) {
    if (!this.playing) return;
    var dt = (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    var advance = Math.round(dt * this.framesPerSec * this.speed);
    this.frame += Math.max(1, advance);
    if (this.frame >= this.data.count) this.frame = 0; // loop
    this.renderFrame();
    this.rafId = requestAnimationFrame(this._tick);
  };

  FlightReplay.prototype.renderFrame = function () {
    this.renderQuad();
    this.renderCurves();
    if (this.onFrameChange) {
      this.onFrameChange(this.frame, this.data.count, this.data.durationSec);
    }
  };

  /* ---- Quad attitude + motor viz ---- */
  FlightReplay.prototype.renderQuad = function () {
    if (this.scene3D) {
      this.renderScene3D();
      return;
    }

    var ctx = this.quadCtx;
    var w = this.quadCanvas.width;
    var h = this.quadCanvas.height;
    var cx = w / 2;
    var cy = h / 2;
    var d = this.data;
    var f = this.frame;

    ctx.clearRect(0, 0, w, h);

    var motion = this.motion || buildDisplayMotion(d);
    var trace = this.trace || buildDisplayTrace(d, motion);
    var rollDeg = motion.roll[f] || 0;
    var pitchDeg = motion.pitch[f] || 0;
    var yawRad = (motion.yaw[f] || 0) * Math.PI / 180;
    var maxTiltDeg = motion.maxTiltDeg || 45;

    // Draw concentric reference rings
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (var r = 1; r <= 3; r++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * Math.min(cx, cy) * 0.28, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw crosshair
    ctx.strokeStyle = 'rgba(0,212,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.moveTo(0, cy); ctx.lineTo(w, cy);
    ctx.stroke();

    var quadPos = drawTrace(ctx, trace, f, cx, cy, Math.min(cx, cy) * 0.58);

    // Quad body — top-down heading cue. Roll/pitch are shown on the bars below.
    ctx.save();
    ctx.translate(quadPos.x, quadPos.y);
    ctx.rotate(yawRad);

    // Arms
    var armLen = Math.min(cx, cy) * 0.22;
    var angles = [-Math.PI / 4, Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4];
    var motorVals = [];
    for (var i = 0; i < 4; i++) {
      motorVals[i] = (d.motor[i][f] - 1000) / 1000; // normalize 0..1
      if (isNaN(motorVals[i]) || motorVals[i] < 0) motorVals[i] = 0;
      if (motorVals[i] > 1) motorVals[i] = 1;
    }

    // Draw arms
    ctx.strokeStyle = 'rgba(232,237,242,0.3)';
    ctx.lineWidth = 2;
    for (var j = 0; j < 4; j++) {
      var ax = Math.cos(angles[j]) * armLen;
      var ay = Math.sin(angles[j]) * armLen;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(ax, ay);
      ctx.stroke();
    }

    // Motor circles — size and glow proportional to throttle
    for (var k = 0; k < 4; k++) {
      var mx = Math.cos(angles[k]) * armLen;
      var my = Math.sin(angles[k]) * armLen;
      var mSize = 8 + motorVals[k] * 18;
      var color = C.motorColors[k];

      // Glow
      var grad = ctx.createRadialGradient(mx, my, 0, mx, my, mSize * 2);
      grad.addColorStop(0, color.replace(')', ',0.4)').replace('rgb', 'rgba'));
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(mx, my, mSize * 2, 0, Math.PI * 2);
      ctx.fill();

      // Motor circle
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.3 + motorVals[k] * 0.7;
      ctx.beginPath();
      ctx.arc(mx, my, mSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Motor label
      ctx.fillStyle = C.dim;
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('M' + (k + 1), mx, my + mSize + 14);
    }

    // Center body
    ctx.fillStyle = 'rgba(0,212,255,0.15)';
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Direction arrow (front)
    ctx.fillStyle = C.accent;
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(-5, -10);
    ctx.lineTo(5, -10);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // Pitch indicator bar on right edge
    var pitchBarH = h * 0.6;
    var pitchY = cy - clamp(pitchDeg / maxTiltDeg, -1, 1) * (pitchBarH / 2);
    ctx.fillStyle = 'rgba(0,212,255,0.08)';
    ctx.fillRect(w - 24, cy - pitchBarH / 2, 8, pitchBarH);
    ctx.fillStyle = C.accent;
    ctx.fillRect(w - 24, pitchY - 3, 8, 6);

    // Roll indicator bar on bottom edge
    var rollBarW = w * 0.48;
    var rollBarX = cx - rollBarW / 2;
    var rollBarY = h - 24;
    var rollX = cx + clamp(rollDeg / maxTiltDeg, -1, 1) * (rollBarW / 2);
    ctx.fillStyle = 'rgba(0,212,255,0.08)';
    ctx.fillRect(rollBarX, rollBarY, rollBarW, 8);
    ctx.fillStyle = C.accent;
    ctx.fillRect(rollX - 3, rollBarY, 6, 8);

    // Gyro readouts
    ctx.fillStyle = C.dim;
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('R: ' + (d.gyroRoll[f] || 0).toFixed(0) + '\u00b0/s', 10, 20);
    ctx.fillText('P: ' + (d.gyroPitch[f] || 0).toFixed(0) + '\u00b0/s', 10, 34);
    ctx.fillText('Y: ' + (d.gyroYaw[f] || 0).toFixed(0) + '\u00b0/s', 10, 48);
  };

  FlightReplay.prototype.ensureScene3D = function () {
    if (this.scene3D || !(typeof window !== 'undefined' && window.THREE)) return;

    var THREE = window.THREE;
    var renderer = new THREE.WebGLRenderer({
      canvas: this.quadCanvas,
      antialias: true,
      alpha: false
    });
    renderer.setClearColor(0x0d0d0f, 1);
    if (renderer.outputColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

    var scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0d0d0f, 0.045);

    var camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);

    var hemi = new THREE.HemisphereLight(0xdff8ff, 0x102030, 1.6);
    hemi.position.set(0, 12, 0);
    scene.add(hemi);

    var key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(8, 12, 6);
    scene.add(key);

    var rim = new THREE.DirectionalLight(0x00d4ff, 0.6);
    rim.position.set(-6, 4, -10);
    scene.add(rim);

    var grid = new THREE.GridHelper(18, 18, 0x27485a, 0x16242d);
    scene.add(grid);

    var drone = buildDroneModel3D(THREE);
    scene.add(drone);

    var pathGroup = new THREE.Group();
    scene.add(pathGroup);

    this.scene3D = {
      THREE: THREE,
      renderer: renderer,
      scene: scene,
      camera: camera,
      drone: drone,
      grid: grid,
      pathGroup: pathGroup,
      fullLine: null,
      playedLine: null,
      ghostPoints: null,
      radius: 6,
      lookAt: new THREE.Vector3(),
      cameraPos: new THREE.Vector3(),
      initialized: false
    };
  };

  FlightReplay.prototype.syncScene3D = function () {
    if (!this.scene3D || !this.kinematics) return;

    clearThreeGroup(this.scene3D.pathGroup);
    this.scene3D.fullLine = null;
    this.scene3D.playedLine = null;
    this.scene3D.ghostPoints = null;

    var THREE = this.scene3D.THREE;
    var positions = flattenPathPositions(this.kinematics);
    if (positions.length < 6) return;

    var fullGeometry = new THREE.BufferGeometry();
    fullGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    var fullMaterial = new THREE.LineBasicMaterial({
      color: 0x355261,
      transparent: true,
      opacity: 0.35
    });
    var fullLine = new THREE.Line(fullGeometry, fullMaterial);
    this.scene3D.pathGroup.add(fullLine);

    var playedGeometry = new THREE.BufferGeometry();
    playedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions.slice(), 3));
    var playedMaterial = new THREE.LineBasicMaterial({
      color: 0x00d4ff,
      transparent: true,
      opacity: 0.95
    });
    var playedLine = new THREE.Line(playedGeometry, playedMaterial);
    playedGeometry.setDrawRange(0, 2);
    this.scene3D.pathGroup.add(playedLine);

    var ghostGeometry = new THREE.BufferGeometry();
    ghostGeometry.setAttribute('position', new THREE.Float32BufferAttribute(samplePathPositions(this.kinematics, 24), 3));
    var ghostMaterial = new THREE.PointsMaterial({
      color: 0xff6b35,
      size: 0.09,
      transparent: true,
      opacity: 0.55
    });
    var ghostPoints = new THREE.Points(ghostGeometry, ghostMaterial);
    this.scene3D.pathGroup.add(ghostPoints);

    this.scene3D.fullLine = fullLine;
    this.scene3D.playedLine = playedLine;
    this.scene3D.ghostPoints = ghostPoints;
    this.scene3D.radius = this.kinematics.radius || 6;
    this.scene3D.grid.scale.setScalar(Math.max(0.7, this.scene3D.radius / 6));
    this.scene3D.grid.position.y = -this.scene3D.radius * 0.35;
    this.scene3D.initialized = false;
  };

  FlightReplay.prototype.renderScene3D = function () {
    if (!this.scene3D || !this.motion || !this.kinematics || !this.data) return;

    var frame = this.frame;
    var scene3D = this.scene3D;
    var THREE = scene3D.THREE;
    var radius = scene3D.radius || 6;
    var pos = new THREE.Vector3(
      this.kinematics.x[frame] || 0,
      this.kinematics.y[frame] || 0,
      this.kinematics.z[frame] || 0
    );
    var yaw = (this.motion.yaw[frame] || 0) * Math.PI / 180;
    var pitch = (this.motion.pitch[frame] || 0) * Math.PI / 180;
    var roll = (this.motion.roll[frame] || 0) * Math.PI / 180;

    scene3D.drone.position.copy(pos);
    scene3D.drone.rotation.order = 'YXZ';
    scene3D.drone.rotation.y = yaw;
    scene3D.drone.rotation.x = pitch;
    scene3D.drone.rotation.z = -roll;

    if (scene3D.playedLine) {
      scene3D.playedLine.geometry.setDrawRange(0, Math.max(2, frame + 1));
    }

    var orbit = yaw * 0.16 + frame * 0.004;
    var desiredCamera = new THREE.Vector3(
      pos.x + Math.cos(orbit) * radius * 1.35,
      pos.y + radius * 0.72,
      pos.z + Math.sin(orbit) * radius * 1.35
    );
    var desiredLookAt = new THREE.Vector3(pos.x, pos.y + radius * 0.08, pos.z);

    if (!scene3D.initialized) {
      scene3D.camera.position.copy(desiredCamera);
      scene3D.lookAt.copy(desiredLookAt);
      scene3D.initialized = true;
    } else {
      scene3D.camera.position.lerp(desiredCamera, 0.08);
      scene3D.lookAt.lerp(desiredLookAt, 0.12);
    }

    scene3D.camera.lookAt(scene3D.lookAt);
    scene3D.renderer.render(scene3D.scene, scene3D.camera);
  };

  /* ---- Gyro + throttle curves ---- */
  FlightReplay.prototype.renderCurves = function () {
    var ctx = this.curveCtx;
    var w = this.curveCanvas.width;
    var h = this.curveCanvas.height;
    var d = this.data;
    var f = this.frame;
    var win = this.curveWindow;

    ctx.clearRect(0, 0, w, h);

    var start = Math.max(0, f - Math.floor(win / 2));
    var end = Math.min(d.count, start + win);
    if (end - start < win && start > 0) start = Math.max(0, end - win);

    var gyroH = h * 0.65;
    var thrH = h * 0.25;
    var gap = h * 0.1;

    // --- Gyro section ---
    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, w, gyroH);

    // Zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, gyroH / 2);
    ctx.lineTo(w, gyroH / 2);
    ctx.stroke();

    // Find max gyro for scaling
    var maxGyro = 1;
    for (var s = start; s < end; s++) {
      maxGyro = Math.max(maxGyro, Math.abs(d.gyroRoll[s] || 0), Math.abs(d.gyroPitch[s] || 0), Math.abs(d.gyroYaw[s] || 0));
    }
    maxGyro *= 1.2;

    // Draw gyro traces
    var traces = [
      { data: d.gyroRoll, color: C.accent, label: 'Roll' },
      { data: d.gyroPitch, color: C.accent2, label: 'Pitch' },
      { data: d.gyroYaw, color: C.green, label: 'Yaw' }
    ];

    for (var t = 0; t < traces.length; t++) {
      ctx.strokeStyle = traces[t].color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (var i = start; i < end; i++) {
        var x = ((i - start) / (end - start)) * w;
        var y = gyroH / 2 - ((traces[t].data[i] || 0) / maxGyro) * (gyroH / 2);
        if (i === start) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Playhead
    var phX = ((f - start) / (end - start)) * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(phX, 0);
    ctx.lineTo(phX, gyroH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Legend
    ctx.font = '10px monospace';
    for (var l = 0; l < traces.length; l++) {
      ctx.fillStyle = traces[l].color;
      ctx.fillRect(10 + l * 70, 8, 12, 3);
      ctx.fillStyle = C.dim;
      ctx.fillText(traces[l].label, 26 + l * 70, 14);
    }

    // Section label
    ctx.fillStyle = C.dim;
    ctx.textAlign = 'right';
    ctx.fillText('GYRO (\u00b0/s)', w - 8, 14);
    ctx.textAlign = 'left';

    // --- Throttle section ---
    var thrTop = gyroH + gap;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, thrTop, w, thrH);

    ctx.strokeStyle = C.yellow;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    for (var ti = start; ti < end; ti++) {
      var tx = ((ti - start) / (end - start)) * w;
      var ty = thrTop + thrH - (d.throttle[ti] || 0) * thrH;
      if (ti === start) ctx.moveTo(tx, ty);
      else ctx.lineTo(tx, ty);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Throttle playhead
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(phX, thrTop);
    ctx.lineTo(phX, thrTop + thrH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Throttle label
    ctx.fillStyle = C.dim;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('THROTTLE', w - 8, thrTop + 14);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.yellow;
    ctx.fillRect(10, thrTop + 8, 12, 3);
    ctx.fillStyle = C.dim;
    ctx.fillText('Thr', 26, thrTop + 14);
  };

  FlightReplay.prototype.destroy = function () {
    this.pause();
    this.disposeScene3D();
    this.data = null;
  };

  FlightReplay.prototype.disposeScene3D = function () {
    if (!this.scene3D) return;

    clearThreeGroup(this.scene3D.pathGroup);
    disposeDroneModel3D(this.scene3D.drone);
    this.scene3D.renderer.dispose();
    this.scene3D = null;
  };

  /* ---- helpers ---- */
  function resizeCanvas(canvas, ctx, dpr) {
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Reset the CSS-level dimensions so the canvas is crisp
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }

  function resizeSceneCanvas(canvas, renderer, camera, dpr) {
    var rect = canvas.getBoundingClientRect();
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    renderer.setPixelRatio(dpr);
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  }

  function buildDisplayMotion(data) {
    var count = Math.max(0, data && data.count ? data.count : 0);
    var roll = new Array(count);
    var pitch = new Array(count);
    var yaw = new Array(count);
    var maxTiltDeg = 45;

    if (!data || count === 0) {
      return { roll: [], pitch: [], yaw: [], maxTiltDeg: maxTiltDeg };
    }

    var sampleRate = data.sampleRateHz || (count / Math.max(data.durationSec || 0, 0.1));
    if (!isFinite(sampleRate) || sampleRate < 1 || sampleRate > 500) sampleRate = 60;
    var dt = 1 / sampleRate;

    var rollAngle = 0;
    var pitchAngle = 0;
    var yawAngle = 0;
    var rollRate = 0;
    var pitchRate = 0;
    var yawRate = 0;
    var alpha = clamp(dt * 8, 0.04, 0.18);
    var levelDecay = Math.exp(-dt / 1.8);

    for (var i = 0; i < count; i++) {
      rollRate += (sanitizeRate(data.gyroRoll[i]) - rollRate) * alpha;
      pitchRate += (sanitizeRate(data.gyroPitch[i]) - pitchRate) * alpha;
      yawRate += (sanitizeRate(data.gyroYaw[i]) - yawRate) * alpha;

      // This is a display stabilizer, not absolute AHRS. Integrate gently and
      // leak roll/pitch back toward level so parser spikes cannot spin the quad.
      rollAngle = clamp((rollAngle + rollRate * dt * 0.22) * levelDecay, -maxTiltDeg, maxTiltDeg);
      pitchAngle = clamp((pitchAngle + pitchRate * dt * 0.22) * levelDecay, -maxTiltDeg, maxTiltDeg);
      yawAngle = wrapDeg(yawAngle + yawRate * dt * 0.08);

      roll[i] = rollAngle;
      pitch[i] = pitchAngle;
      yaw[i] = yawAngle;
    }

    return { roll: roll, pitch: pitch, yaw: yaw, maxTiltDeg: maxTiltDeg };
  }

  function buildDisplayTrace(data, motion) {
    var count = Math.max(0, data && data.count ? data.count : 0);
    var x = new Array(count);
    var y = new Array(count);

    if (!data || !motion || count === 0) {
      return { x: [], y: [] };
    }

    var maxTiltDeg = motion.maxTiltDeg || 45;
    for (var i = 0; i < count; i++) {
      x[i] = clamp((motion.roll[i] || 0) / maxTiltDeg, -1, 1) * 0.92;
      y[i] = clamp(-(motion.pitch[i] || 0) / maxTiltDeg, -1, 1) * 0.92;
    }

    return { x: x, y: y };
  }

  function buildReplayKinematics(data, motion) {
    var count = Math.max(0, data && data.count ? data.count : 0);
    var x = new Array(count);
    var y = new Array(count);
    var z = new Array(count);

    if (!data || !motion || count === 0) {
      return { x: [], y: [], z: [], radius: 0 };
    }

    var sampleRate = data.sampleRateHz || (count / Math.max(data.durationSec || 0, 0.1));
    if (!isFinite(sampleRate) || sampleRate < 1 || sampleRate > 500) sampleRate = 60;
    var dt = 1 / sampleRate;
    var maxTiltDeg = motion.maxTiltDeg || 45;
    var posX = 0;
    var posY = 0;
    var posZ = 0;
    var speed = 0;
    var strafe = 0;
    var climb = 0;
    var minX = 0, maxX = 0, minY = 0, maxY = 0, minZ = 0, maxZ = 0;

    for (var i = 0; i < count; i++) {
      var throttle = clamp(Number(data.throttle && data.throttle[i]) || 0, 0, 1);
      var thrust = Math.max(0, throttle - 0.08);
      var pitchNorm = clamp((motion.pitch[i] || 0) / maxTiltDeg, -1, 1);
      var rollNorm = clamp((motion.roll[i] || 0) / maxTiltDeg, -1, 1);
      var yaw = (motion.yaw[i] || 0) * Math.PI / 180;

      speed = speed * 0.965 + thrust * (0.55 - pitchNorm * 0.28);
      strafe = strafe * 0.9 + thrust * rollNorm * 0.18;
      climb = climb * 0.93 + thrust * pitchNorm * 0.24 + Math.max(0, thrust - 0.45) * 0.06;

      posX += (Math.sin(yaw) * speed + Math.cos(yaw) * strafe) * dt * 8;
      posZ += (-Math.cos(yaw) * speed + Math.sin(yaw) * strafe) * dt * 8;
      posY += climb * dt * 5;

      x[i] = posX;
      y[i] = posY;
      z[i] = posZ;
      if (posX < minX) minX = posX;
      if (posX > maxX) maxX = posX;
      if (posY < minY) minY = posY;
      if (posY > maxY) maxY = posY;
      if (posZ < minZ) minZ = posZ;
      if (posZ > maxZ) maxZ = posZ;
    }

    var centerX = (minX + maxX) / 2;
    var centerY = (minY + maxY) / 2;
    var centerZ = (minZ + maxZ) / 2;
    var span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    var scale = 10 / span;

    for (var j = 0; j < count; j++) {
      x[j] = (x[j] - centerX) * scale;
      y[j] = (y[j] - centerY) * scale;
      z[j] = (z[j] - centerZ) * scale;
    }

    return {
      x: x,
      y: y,
      z: z,
      radius: Math.max(4, span * scale * 0.72)
    };
  }

  function drawTrace(ctx, trace, frame, cx, cy, radius) {
    if (!trace || !trace.x || !trace.x.length) {
      return { x: cx, y: cy };
    }

    var currentX = cx + (trace.x[frame] || 0) * radius;
    var currentY = cy + (trace.y[frame] || 0) * radius;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    drawTraceSegment(ctx, trace, 0, trace.x.length - 1, cx, cy, radius, 'rgba(136,153,170,0.20)', 1.2);
    drawTraceSegment(ctx, trace, frame, Math.min(trace.x.length - 1, frame + 120), cx, cy, radius, 'rgba(255,107,53,0.18)', 1.4);
    drawTraceSegment(ctx, trace, Math.max(0, frame - 220), frame, cx, cy, radius, 'rgba(0,212,255,0.72)', 2.4);

    var glow = ctx.createRadialGradient(currentX, currentY, 0, currentX, currentY, 18);
    glow.addColorStop(0, 'rgba(0,212,255,0.5)');
    glow.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(currentX, currentY, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = C.accent;
    ctx.beginPath();
    ctx.arc(currentX, currentY, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    return { x: currentX, y: currentY };
  }

  function drawTraceSegment(ctx, trace, start, end, cx, cy, radius, color, width) {
    if (end <= start) return;

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (var i = start; i <= end; i++) {
      var px = cx + (trace.x[i] || 0) * radius;
      var py = cy + (trace.y[i] || 0) * radius;
      if (i === start) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  function flattenPathPositions(path) {
    var flat = [];
    if (!path || !path.x) return flat;
    for (var i = 0; i < path.x.length; i++) {
      flat.push(path.x[i] || 0, path.y[i] || 0, path.z[i] || 0);
    }
    return flat;
  }

  function samplePathPositions(path, stride) {
    var flat = [];
    if (!path || !path.x) return flat;
    var step = Math.max(1, stride || 24);
    for (var i = 0; i < path.x.length; i += step) {
      flat.push(path.x[i] || 0, path.y[i] || 0, path.z[i] || 0);
    }
    var last = path.x.length - 1;
    if (last >= 0 && (last % step !== 0)) {
      flat.push(path.x[last] || 0, path.y[last] || 0, path.z[last] || 0);
    }
    return flat;
  }

  function buildDroneModel3D(THREE) {
    var drone = new THREE.Group();
    var armMat = new THREE.MeshStandardMaterial({
      color: 0xe8edf2,
      roughness: 0.45,
      metalness: 0.25
    });
    var accentMat = new THREE.MeshStandardMaterial({
      color: 0x00d4ff,
      emissive: 0x00d4ff,
      emissiveIntensity: 0.25,
      roughness: 0.3
    });

    var armGeo = new THREE.BoxGeometry(1.35, 0.05, 0.08);
    var armA = new THREE.Mesh(armGeo, armMat);
    armA.rotation.y = Math.PI / 4;
    drone.add(armA);

    var armB = new THREE.Mesh(armGeo, armMat);
    armB.rotation.y = -Math.PI / 4;
    drone.add(armB);

    var body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.11, 0.34), accentMat);
    drone.add(body);

    var front = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 12), accentMat);
    front.rotation.x = Math.PI / 2;
    front.position.set(0, 0.02, -0.26);
    drone.add(front);

    var motorGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.05, 18);
    var motorOffsets = [
      [0.46, 0.02, 0.46],
      [-0.46, 0.02, 0.46],
      [0.46, 0.02, -0.46],
      [-0.46, 0.02, -0.46]
    ];
    for (var i = 0; i < motorOffsets.length; i++) {
      var motor = new THREE.Mesh(motorGeo, armMat);
      motor.rotation.x = Math.PI / 2;
      motor.position.set(motorOffsets[i][0], motorOffsets[i][1], motorOffsets[i][2]);
      drone.add(motor);
    }

    return drone;
  }

  function clearThreeGroup(group) {
    if (!group) return;
    while (group.children.length) {
      disposeThreeObject(group.children.pop());
    }
  }

  function disposeDroneModel3D(drone) {
    if (!drone) return;
    while (drone.children.length) {
      disposeThreeObject(drone.children.pop());
    }
  }

  function disposeThreeObject(obj) {
    if (!obj) return;
    if (obj.parent) obj.parent.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        for (var i = 0; i < obj.material.length; i++) obj.material[i].dispose();
      } else {
        obj.material.dispose();
      }
    }
  }

  function sanitizeRate(value) {
    if (!isFinite(value)) return 0;
    if (Math.abs(value) < 2) return 0;
    return clamp(value, -2000, 2000);
  }

  function wrapDeg(value) {
    while (value > 180) value -= 360;
    while (value < -180) value += 360;
    return value;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  exports.FlightReplay = FlightReplay;
  exports.buildDisplayMotion = buildDisplayMotion;
  exports.buildDisplayTrace = buildDisplayTrace;
  exports.buildReplayKinematics = buildReplayKinematics;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})(typeof window !== 'undefined' ? window : {});
