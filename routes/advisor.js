/**
 * Advisor routes — AI PID tuning advisor page + server-side chat API + analytics events.
 * Owns: /advisor page rendering, POST /chat inference, POST /events analytics ingestion.
 * Does NOT own: LLM engine logic (services/advisor-inference.js), client-side WebLLM.
 */
const express = require('express');
const router = express.Router();
const advisorInference = require('../services/advisor-inference');
const { recordEvent } = require('../db/advisor-events');

router.get('/', (_req, res) => {
  res.render('advisor');
});

/**
 * POST /chat — server-side LLM inference for PID advice.
 * Input:  { messages: [{ role, content }], advisorContext: { pids, fftPeaks, ... } }
 * Output: { reply: string, model: string, backend: "server"|"server-fallback" }
 */
router.post('/chat', async (req, res) => {
  try {
    const { messages, advisorContext } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Validate at least one user message exists
    const hasUser = messages.some(m => m.role === 'user' && m.content);
    if (!hasUser) {
      return res.status(400).json({ error: 'At least one user message is required' });
    }

    const result = await advisorInference.chat(messages, advisorContext);
    res.json(result);
  } catch (err) {
    console.error('[advisor/chat] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /events — analytics event ingestion for advisor tracking.
 * Input:  { sessionId, eventType, eventData }
 * Output: { ok: true }
 * Fire-and-forget from client — always returns 200 to avoid blocking UX.
 */
router.post('/events', async (req, res) => {
  const { sessionId, eventType, eventData } = req.body || {};
  if (!sessionId || !eventType) {
    return res.status(200).json({ ok: true }); // swallow bad payloads silently
  }
  // WHY async without await: event recording is best-effort, don't delay response
  recordEvent(sessionId, eventType, eventData).catch(() => {});
  res.status(200).json({ ok: true });
});

module.exports = router;
