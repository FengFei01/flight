/**
 * Analysis routes — file upload and PID recommendation display.
 * Owns: /analyze upload page, POST /analyze file processing, GET /analyze/results.
 * Does NOT own: BBL parsing or PID logic (delegated to services/).
 */
const express = require('express');
const multer = require('multer');
const { parseBBL } = require('../services/bbl-parser');
const { analyzePIDs, generateCLICommands, generateDiffCLICommands, generateTuningNotes, applyStyleToAnalysis, computeFlightScore, STYLE_PROFILES } = require('../services/pid-analyzer');
const { detectBfVersion } = require('../public/js/bf-version-map');
const { SpectrumAnalyzer } = require('../public/js/spectrum-analyzer');
const { analyzeMotorHealth } = require('../lib/motor-health');
const { recordUsage } = require('../db/usage');

const router = express.Router();

// Store uploaded files in memory (BBL files are typically 1-10MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    if (ext.endsWith('.bbl') || ext.endsWith('.bfl')) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .BBL 和 .BFL 格式的 Blackbox 日志文件'));
    }
  },
});

// Upload page with drag-and-drop
router.get('/', (_req, res) => {
  res.render('analyze', { error: null });
});

// Log all incoming POST requests so we can detect proxy-level 403 blocks
// (if the request never appears here, the 403 is from the CDN/proxy, not Express)
router.post('/', (req, res, next) => {
  console.log('[analyze] POST /analyze received — content-type:', req.headers['content-type'], 'content-length:', req.headers['content-length']);
  next();
}, upload.single('bblFile'), (req, res) => {
  const wantsJSON = req.headers.accept && req.headers.accept.includes('application/json');

  if (!req.file) {
    const msg = '请选择一个 .BBL 文件上传。';
    return wantsJSON ? res.status(400).json({ error: msg }) : res.render('analyze', { error: msg });
  }

  // Empty file check
  if (req.file.size === 0) {
    const msg = '文件为空，请上传有效的 Blackbox 日志文件。';
    return wantsJSON ? res.status(400).json({ error: msg }) : res.render('analyze', { error: msg });
  }

  // BBL header signature check — valid Betaflight Blackbox logs start with "H " header lines
  // containing field definitions like "H Product:", "H Firmware", "H Field I name:", etc.
  const headerSnippet = req.file.buffer.slice(0, Math.min(512, req.file.buffer.length)).toString('latin1');
  const hasBBLHeader = /^H .+:/m.test(headerSnippet);
  if (!hasBBLHeader) {
    const msg = '文件不是有效的 Blackbox 日志。未检测到 Betaflight 日志头 (H 标记)，请确认文件来源。';
    return wantsJSON ? res.status(400).json({ error: msg }) : res.render('analyze', { error: msg });
  }

  // Run analysis in a timeout wrapper so it can't hang forever
  const TIMEOUT_MS = 45000;
  let finished = false;

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    console.error('[analyze] Analysis timed out after 45s for', req.file.originalname);
    const msg = 'Analysis timed out. The file may be too large or corrupted — please try a smaller log.';
    return wantsJSON ? res.status(504).json({ error: msg }) : res.render('analyze', { error: msg });
  }, TIMEOUT_MS);

  try {
    const parsed = parseBBL(req.file.buffer);
    const analysis = analyzePIDs(parsed);
    const detectedBfVersion = detectBfVersion(analysis.header.firmwareVersion);
    const cliCommands = generateCLICommands(analysis, detectedBfVersion);
    const tuningNotes = generateTuningNotes(analysis.current, analysis.recommended);

    if (finished) return; // timeout already fired
    finished = true;
    clearTimeout(timer);

    const ipHash = req.ip;
    const countryCode = (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || '').toUpperCase() || null;
    recordUsage(ipHash, countryCode).catch(err => console.error('[analyze] Stats record error:', err.message));

    // Gyro frame data for client-side FFT analysis
    const gyroFrames = parsed.frames.gyro || { roll: [], pitch: [], yaw: [] };
    // Effective sample rate accounts for the parser's sub-sampling of the binary
    const effectiveSampleRate = parsed.frames.effectiveSampleRate || 0;

    // Server-side motor health analysis (free, no usage tracking)
    let motorHealth = null;
    try {
      const throttleData = SpectrumAnalyzer.buildThrottleSeries(
        parsed.frames.motor, parsed.header.motorOutput
      );
      const throttleAnalysis = SpectrumAnalyzer.analyzeThrottleRanges(
        gyroFrames, throttleData.series,
        parsed.header.looptime, effectiveSampleRate,
        { windowSize: 1024, minSamples: 1024 }
      );
      motorHealth = analyzeMotorHealth(throttleAnalysis);
    } catch (_e) { /* motor health is best-effort */ }

    // Apply default flight style (freestyle) and compute flight score
    const defaultStyle = 'freestyle';
    const styledAnalysis = applyStyleToAnalysis(analysis, defaultStyle);
    const styledCliCommands = generateCLICommands(styledAnalysis, detectedBfVersion);
    const styledTuningNotes = generateTuningNotes(styledAnalysis.current, styledAnalysis.recommended);
    const flightScore = computeFlightScore(styledAnalysis, motorHealth, defaultStyle);
    const cliExport = generateDiffCLICommands(styledAnalysis, detectedBfVersion);

    if (wantsJSON) {
      return res.json({ ok: true, analysis: styledAnalysis, cliCommands: styledCliCommands, cliExport, tuningNotes: styledTuningNotes, gyroFrames, effectiveSampleRate, detectedBfVersion, motorHealth, flightScore, flightStyle: defaultStyle, fileName: req.file.originalname, fileSize: (req.file.size / 1024).toFixed(1) });
    }
    res.render('results', {
      analysis: styledAnalysis,
      baseAnalysis: analysis,
      cliCommands: styledCliCommands,
      cliExport,
      tuningNotes: styledTuningNotes,
      gyroFrames,
      effectiveSampleRate,
      detectedBfVersion,
      motorHealth,
      flightScore,
      flightStyle: defaultStyle,
      styleProfiles: STYLE_PROFILES,
      fileName: req.file.originalname,
      fileSize: (req.file.size / 1024).toFixed(1),
    });
  } catch (err) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    console.error('[analyze] Error processing BBL file:', err.message);
    const msg = `Failed to parse file: ${err.message}`;
    return wantsJSON ? res.status(500).json({ error: msg }) : res.render('analyze', { error: msg });
  }
});

// Recalculate PID recommendations for a different flight style (client-side switch)
router.post('/restyle', express.json(), (req, res) => {
  const { baseAnalysis, motorHealth, style, bfVersion } = req.body;
  if (!baseAnalysis || !style || !STYLE_PROFILES[style]) {
    return res.status(400).json({ error: 'Invalid style or missing analysis data' });
  }
  const styled = applyStyleToAnalysis(baseAnalysis, style);
  const cliCommands = generateCLICommands(styled, bfVersion || '4.3');
  const cliExport = generateDiffCLICommands(styled, bfVersion || '4.3');
  const tuningNotes = generateTuningNotes(styled.current, styled.recommended);
  const flightScore = computeFlightScore(styled, motorHealth || null, style);
  res.json({ ok: true, analysis: styled, cliCommands, cliExport, tuningNotes, flightScore });
});

// Multer error handler — returns proper HTTP status codes so the XHR client
// can detect errors instead of getting a 200 with an error page
router.use((err, req, res, _next) => {
  const wantsJSON = req.headers.accept && req.headers.accept.includes('application/json');
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? '文件太大，最大支持 50MB。'
      : `上传错误: ${err.message}`;
    console.error('[analyze] Multer error:', err.code, err.message);
    return wantsJSON
      ? res.status(status).json({ error: msg })
      : res.status(status).render('analyze', { error: msg });
  }
  if (err) {
    console.error('[analyze] Upload error:', err.message);
    return wantsJSON
      ? res.status(400).json({ error: err.message })
      : res.status(400).render('analyze', { error: err.message });
  }
});

module.exports = router;
