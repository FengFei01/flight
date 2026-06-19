/**
 * Usage tracker — user ID management for analytics.
 * Owns: user ID management, usage badge display.
 * Does NOT own: payment processing, BBL parsing, or server-side usage recording.
 * NOTE: FlightForge is fully free — no paywall, no credits, no subscriptions.
 */
(function () {
  'use strict';

  // Stable user ID persisted in localStorage
  function getUserId() {
    var uid = localStorage.getItem('ff_user_id');
    if (!uid) {
      uid = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 8);
      localStorage.setItem('ff_user_id', uid);
    }
    return uid;
  }

  // Expose for other scripts that need the user ID
  window.ffGetUserId = getUserId;

  /**
   * Check usage status from API. Always returns canAnalyze: true (all features free).
   */
  async function checkUsage() {
    return { canAnalyze: true, reason: 'free' };
  }

  /**
   * Show usage badge — displays "免费 Free" since all features are free.
   */
  function renderUsageBadge(status) {
    var badge = document.getElementById('usageBadge');
    if (!badge) return;
    badge.innerHTML = '<span class="usage-badge usage-badge-free">免费 · Free</span>';
    badge.style.display = '';
  }

  /**
   * No-op — paywall removed. FlightForge is fully free.
   */
  function showPaywall() {
    // All features are free — no paywall
  }

  // Auto-init on results page: show usage badge
  if (document.getElementById('usageBadge') || document.querySelector('.results-container')) {
    checkUsage().then(function (status) {
      renderUsageBadge(status);
    });
  }

  // Expose globally for compatibility
  window.ffUsageTracker = { checkUsage: checkUsage, showPaywall: showPaywall, getUserId: getUserId, renderUsageBadge: renderUsageBadge };
})();
