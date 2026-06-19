/**
 * Advisor Analytics — client-side event tracking for AI Advisor.
 * Owns: session ID generation, event batching, sending events to /api/advisor/events.
 * Does NOT own: advisor chat logic, WebLLM engine, or server-side event persistence.
 */
(function () {
  'use strict';

  // Generate per-page-load session ID
  var sessionId = 'adv_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  var turnCount = 0;
  var pageLoadTime = Date.now();

  // Fire-and-forget event sender
  function trackEvent(eventType, data) {
    var payload = {
      sessionId: sessionId,
      eventType: eventType,
      eventData: data || {}
    };
    try {
      // WHY navigator.sendBeacon: survives page unload, no response needed
      var sent = navigator.sendBeacon && navigator.sendBeacon(
        '/api/advisor/events',
        new Blob([JSON.stringify(payload)], { type: 'application/json' })
      );
      if (!sent) {
        fetch('/api/advisor/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(function () {});
      }
    } catch (_) {}
  }

  // --- Page Visit ---
  trackEvent('page_visit', {
    referrer: document.referrer || 'direct',
    hasContext: !!window._ffAdvisorContext
  });

  // --- Model Load Tracking ---
  // Hook into WebLLMEngine state changes to track model load events
  var modelLoadStart = null;
  var modelLoadTracked = false;

  function hookModelTracking() {
    if (!window.WebLLMEngine || !window.WebLLMEngine.onStateChange) return;

    window.WebLLMEngine.onStateChange(function (state, progress, error) {
      if (state === 'checking' || state === 'downloading') {
        if (!modelLoadStart) modelLoadStart = Date.now();
      }

      if (state === 'ready' && !modelLoadTracked) {
        modelLoadTracked = true;
        var durationMs = modelLoadStart ? Date.now() - modelLoadStart : null;
        trackEvent('model_load', {
          status: 'success',
          durationMs: durationMs,
          tier: 'browser_webllm_gpu'
        });
      }

      if (state === 'error' && modelLoadStart && !modelLoadTracked) {
        modelLoadTracked = true;
        trackEvent('model_load', {
          status: 'failure',
          durationMs: Date.now() - modelLoadStart,
          error: (error || '').substring(0, 200),
          tier: 'browser_webllm_gpu'
        });
      }
    });
  }

  // --- Inference Mode Tracking ---
  // Patch into advisor-chat.js sendMessage flow via a MutationObserver on chat messages
  var lastUserMsgTime = null;

  function observeChat() {
    var chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (!node.classList) continue;

          // User message sent
          if (node.classList.contains('chat-user')) {
            turnCount++;
            lastUserMsgTime = Date.now();
            trackEvent('message_sent', {
              turnNumber: turnCount,
              sessionDepth: turnCount
            });
          }

          // Assistant reply arrived (or updated)
          if (node.classList.contains('chat-assistant') && node.id && node.id.startsWith('reply-')) {
            var latencyMs = lastUserMsgTime ? Date.now() - lastUserMsgTime : null;
            // Determine inference tier from backend indicator
            var tier = detectInferenceTier();
            trackEvent('response_received', {
              turnNumber: turnCount,
              latencyMs: latencyMs,
              tier: tier
            });
          }

          // Error message
          if (node.classList.contains('chat-error')) {
            var errorText = node.textContent ? node.textContent.substring(0, 200) : '';
            trackEvent('inference_error', {
              turnNumber: turnCount,
              errorType: classifyError(errorText),
              tier: detectInferenceTier()
            });
          }
        }
      }
    });

    observer.observe(chatMessages, { childList: true });
  }

  function detectInferenceTier() {
    var indicator = document.getElementById('backendIndicator');
    if (!indicator) return 'unknown';
    var text = indicator.textContent || '';
    if (text.indexOf('本地') !== -1) return 'browser_webllm_gpu';
    if (text.indexOf('云端') !== -1 || text.indexOf('☁️') !== -1) return 'server_cpu_fallback';
    // Check if WebLLM is in rule-based fallback mode
    if (text.indexOf('规则') !== -1) return 'rule_based_fallback';
    return 'unknown';
  }

  function classifyError(text) {
    if (text.indexOf('GPU') !== -1 || text.indexOf('WebGPU') !== -1) return 'gpu_error';
    if (text.indexOf('繁忙') !== -1 || text.indexOf('busy') !== -1) return 'server_busy';
    if (text.indexOf('超时') !== -1 || text.indexOf('timeout') !== -1) return 'timeout';
    if (text.indexOf('网络') !== -1 || text.indexOf('network') !== -1) return 'network';
    return 'other';
  }

  // --- Session Depth on Unload ---
  window.addEventListener('beforeunload', function () {
    if (turnCount > 0) {
      trackEvent('session_end', {
        totalTurns: turnCount,
        sessionDurationMs: Date.now() - pageLoadTime
      });
    }
  });

  // --- Init ---
  function init() {
    hookModelTracking();
    observeChat();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging
  window._advisorAnalytics = { trackEvent: trackEvent, getSessionId: function () { return sessionId; } };
})();
