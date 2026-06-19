/**
 * WebLLM Engine Manager — browser-side LLM for PID tuning advice.
 * Owns: WebGPU detection, model loading/caching, chat completion, state management.
 * Does NOT own: UI rendering, PID data gathering (see advisor-chat.js).
 *
 * Model source: modelscope.cn (China-accessible, CORS-enabled, no proxy needed).
 */

(function () {
  'use strict';

  if (window.WebLLMEngine) return;

  // --- State ---
  var engine = null;
  var state = 'idle'; // idle | checking | downloading | loading | ready | generating | error | recovering
  var stateListeners = [];
  var progressInfo = { text: '', progress: 0 };
  var errorMsg = '';
  var engineHealthy = false;
  var engineCreationPromise = null;
  var MAX_RECOVERY_RETRIES = 2;

  // --- Backend tiers (tried in order during init) ---
  var BACKENDS = [
    {
      id: 'webgpu',
      label: 'WebGPU',
      modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
      modelUrl: 'https://modelscope.cn/models/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
      wasmUrl: '/wasm/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm'
    },
    {
      id: 'webgpu-lowprec',
      label: 'WebGPU (低精度)',
      modelId: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
      modelUrl: 'https://modelscope.cn/models/mlc-ai/Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
      wasmUrl: '/wasm/Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm'
    }
  ];
  var activeBackend = null;

  // --- State Management ---
  function setState(newState, info) {
    state = newState;
    if (info) {
      if (info.text !== undefined) progressInfo.text = info.text;
      if (info.progress !== undefined) progressInfo.progress = info.progress;
      if (info.error !== undefined) errorMsg = info.error;
    }
    for (var i = 0; i < stateListeners.length; i++) {
      try { stateListeners[i](state, progressInfo, errorMsg); } catch (_) {}
    }
  }

  function onStateChange(cb) {
    stateListeners.push(cb);
    return function () {
      stateListeners = stateListeners.filter(function (fn) { return fn !== cb; });
    };
  }

  // --- WebGPU Detection ---
  function checkWebGPU() {
    if (!navigator.gpu) return false;
    return true;
  }

  async function hasWebGPUAdapter() {
    if (!navigator.gpu) return false;
    try {
      var adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch (_) {
      return false;
    }
  }

  function isWebGPUFatalError(err) {
    if (!err || !err.message) return false;
    var msg = err.message;
    return msg.includes('mapAsync') ||
      msg.includes('GPUBuffer') ||
      msg.includes('GPUDevice') ||
      msg.includes('device was lost') ||
      msg.includes('Device is lost') ||
      msg.includes('disposed') ||
      msg.includes('model not loaded');
  }

  function makeProgressCallback(cached) {
    return function (report) {
      var pct = report.progress || 0;
      var text = report.text || '';

      if (text.includes('Fetching') || text.includes('Loading') || pct < 0.95) {
        setState('downloading', {
          text: pct > 0.9
            ? '加载模型到 GPU...'
            : cached
              ? '从缓存加载模型 (' + Math.round(pct * 100) + '%)...'
              : '正在下载 AI 模型 (' + Math.round(pct * 100) + '%)...',
          progress: pct
        });
      }
      if (pct >= 0.95) {
        setState('loading', { text: '加载模型到 GPU...', progress: pct });
      }
    };
  }

  function buildAppConfig(backend) {
    var modelRecord = {
      model_id: backend.modelId,
      model: backend.modelUrl,
      model_lib: backend.wasmUrl,
      vram_required_MB: 1629.75,
      overrides: { context_window_size: 4096 }
    };
    console.log('[WebLLM] Loading model (' + backend.label + ')');
    console.log('[WebLLM] appConfig — model:', backend.modelUrl);
    console.log('[WebLLM] appConfig — wasm:', backend.wasmUrl);
    return { model_list: [modelRecord] };
  }

  // --- Engine Cleanup ---
  function cleanupEngine() {
    if (engine) {
      try { engine.unload(); } catch (_) {}
      engine = null;
    }
    engineHealthy = false;
  }

  // --- Engine Creation (shared by init + reload) ---
  async function createEngine(backend) {
    if (engineCreationPromise) return engineCreationPromise;

    engineCreationPromise = (async function () {
      var webllm = await import('https://esm.run/@mlc-ai/web-llm@0.2.84');

      var cached = false;
      try {
        var cacheKeys = await caches.keys();
        cached = cacheKeys.some(function (k) { return k.indexOf('webllm') !== -1 || k.indexOf('mlc') !== -1; });
      } catch (_) {}

      setState('downloading', {
        text: cached
          ? '从缓存加载 AI 模型...'
          : '正在从 modelscope.cn 下载 AI 模型 (~1GB, 首次加载)...',
        progress: 0
      });

      var appConfig = buildAppConfig(backend);
      engine = await webllm.CreateMLCEngine(backend.modelId, {
        appConfig: appConfig,
        initProgressCallback: makeProgressCallback(cached)
      });

      activeBackend = backend;
      engineHealthy = true;
      setState('ready', { text: 'AI 顾问就绪 (' + backend.label + ')', progress: 1 });
      return engine;
    })().finally(function () {
      engineCreationPromise = null;
    });

    return engineCreationPromise;
  }

  // --- Engine Init (cascading fallback through BACKENDS) ---
  async function initEngine() {
    if (engine && engineHealthy) { setState('ready'); return engine; }
    if (state === 'downloading' || state === 'loading') return null;

    if (engine && !engineHealthy) {
      cleanupEngine();
    }

    setState('checking', { text: '检查浏览器兼容性...', progress: 0 });

    var gpuOk = await hasWebGPUAdapter();
    if (!gpuOk) {
      setState('error', { error: '需要 WebGPU 支持。请使用最新版 Chrome (113+) 或 Edge 浏览器。' });
      return null;
    }

    for (var i = 0; i < BACKENDS.length; i++) {
      var backend = BACKENDS[i];
      try {
        return await createEngine(backend);
      } catch (err) {
        console.error('[WebLLM] Failed with backend ' + backend.id + ':', err);
        cleanupEngine();
        if (i < BACKENDS.length - 1) {
          setState('checking', { text: '切换到 ' + BACKENDS[i + 1].label + '...', progress: 0 });
          continue;
        }
        var msg = 'GPU 加载失败: ' + (err.message || '未知错误') + '。请刷新页面重试，如持续失败请尝试关闭其他 GPU 应用。';
        setState('error', { error: msg });
        return null;
      }
    }
  }

  // --- Engine Reload (after crash) — cascades through all backends ---
  async function reloadEngine() {
    setState('recovering', { text: '正在恢复，请稍候…', progress: 0 });

    // First, try reloading the current engine instance if it still exists
    if (engine && activeBackend) {
      try {
        var cached = false;
        try {
          var cacheKeys = await caches.keys();
          cached = cacheKeys.some(function (k) { return k.indexOf('webllm') !== -1 || k.indexOf('mlc') !== -1; });
        } catch (_) {}
        var appConfig = buildAppConfig(activeBackend);
        await engine.reload(activeBackend.modelId, {
          appConfig: appConfig,
          initProgressCallback: makeProgressCallback(cached)
        });
        engineHealthy = true;
        setState('ready', { text: 'AI 顾问就绪 (' + activeBackend.label + ')', progress: 1 });
        return true;
      } catch (reloadErr) {
        console.warn('[WebLLM] reload() failed on existing engine:', reloadErr);
        cleanupEngine();
      }
    } else {
      cleanupEngine();
    }

    // Cascade through ALL backends (skip the one that was active since it just failed)
    var failedId = activeBackend ? activeBackend.id : null;
    for (var i = 0; i < BACKENDS.length; i++) {
      if (BACKENDS[i].id === failedId) continue; // skip the backend that just crashed
      try {
        setState('recovering', { text: '尝试 ' + BACKENDS[i].label + '...', progress: 0 });
        await createEngine(BACKENDS[i]);
        return true;
      } catch (err) {
        console.warn('[WebLLM] Recovery with ' + BACKENDS[i].id + ' failed:', err);
        cleanupEngine();
      }
    }

    // All backends exhausted — also retry the failed one as a last resort
    if (failedId) {
      var failedBackend = BACKENDS.find(function (b) { return b.id === failedId; });
      if (failedBackend) {
        try {
          setState('recovering', { text: '最后尝试 ' + failedBackend.label + '...', progress: 0 });
          await createEngine(failedBackend);
          return true;
        } catch (err) {
          console.error('[WebLLM] Final recovery attempt failed:', err);
          cleanupEngine();
        }
      }
    }

    setState('error', { error: 'GPU 上下文无法恢复。请关闭其他使用 GPU 的标签页，然后点击"重新加载"重试。' });
    return false;
  }

  // --- Full Reinit (for use after unrecoverable errors) ---
  // Clears ALL state and starts the full init cascade from scratch.
  async function reinitEngine() {
    cleanupEngine();
    activeBackend = null;
    engineCreationPromise = null;
    return initEngine();
  }

  // --- Chat Completion (streaming) ---
  async function chat(messages, onChunk, onDone, _retryCount) {
    var retryCount = _retryCount || 0;

    if (!engine) {
      if (onDone) onDone('模型未加载，请先等待模型初始化完成。');
      return;
    }

    setState('generating');
    var fullText = '';

    try {
      var reply;
      try {
        reply = await engine.chat.completions.create({
          messages: messages,
          temperature: 0.7,
          max_tokens: 1024,
          stream: true
        });

        for await (var chunk of reply) {
          var delta = chunk.choices[0].delta.content || '';
          if (delta) {
            fullText += delta;
            if (onChunk) onChunk(delta, fullText);
          }
        }
      } catch (innerErr) {
        if (isWebGPUFatalError(innerErr) ||
            (innerErr.message && (innerErr.message.includes('disposed') || innerErr.message.includes('mapAsync')))) {
          console.error('[WebLLM] GPU error during inference:', innerErr);
          throw innerErr;
        }
        throw innerErr;
      }

      setState('ready');
      if (onDone) onDone(null, fullText);

    } catch (err) {
      console.error('[WebLLM] Chat error:', err);

      if (isWebGPUFatalError(err) && retryCount < MAX_RECOVERY_RETRIES) {
        setState('error', { error: '推理出错，正在自动恢复…' });
        cleanupEngine();
        var ok = await reloadEngine();
        if (ok) {
          chat(messages, onChunk, onDone, retryCount + 1);
          return;
        }
        // Recovery failed — let user retry via reinit (not a dead end)
        if (onDone) onDone('GPU_RECOVERABLE:GPU 上下文丢失，点击重试将重新初始化模型');
      } else if (isWebGPUFatalError(err)) {
        cleanupEngine();
        setState('error', { error: 'GPU 上下文无法恢复。请关闭其他使用 GPU 的标签页，然后点击"重新加载"重试。' });
        if (onDone) onDone('GPU_RECOVERABLE:GPU 上下文丢失，点击重试将重新初始化模型');
      } else {
        setState('ready');
        if (onDone) onDone('生成回复时出错: ' + (err.message || '未知错误'));
      }
    }
  }

  // --- Reset ---
  function resetEngine() {
    if (engine && engine.resetChat) {
      engine.resetChat();
    }
  }

  function getState() { return state; }
  function getProgress() { return progressInfo; }
  function getError() { return errorMsg; }
  function isReady() { return state === 'ready'; }

  // --- Fallback State Exposure ---
  // localFailed: set true when GPU inference fails irrecoverably (all recovery attempts exhausted)
  var localFailed = false;

  /**
   * Whether local engine is available for inference attempts.
   * True when: engine loaded and healthy, OR engine is loading/recovering (not yet failed).
   * False when: localFailed flag set, or no WebGPU support detected.
   */
  function isAvailable() {
    if (localFailed) return false;
    if (state === 'ready' || state === 'generating') return true;
    // Still loading — not available yet but not failed
    if (state === 'downloading' || state === 'loading' || state === 'recovering' || state === 'checking') return false;
    // idle or error — check if WebGPU exists at all
    return false;
  }

  /** Whether the local engine has permanently failed for this session */
  function isFailed() { return localFailed; }

  /** Mark local engine as permanently failed (called by advisor-chat when all retries exhausted) */
  function markFailed() { localFailed = true; }

  /** Reset the failed flag (e.g. on successful reinit) */
  function clearFailed() { localFailed = false; }

  // --- Public API ---
  window.WebLLMEngine = {
    init: initEngine,
    reinit: reinitEngine,
    chat: chat,
    reset: resetEngine,
    reload: reloadEngine,
    getState: getState,
    getProgress: getProgress,
    getError: getError,
    isReady: isReady,
    isAvailable: isAvailable,
    isFailed: isFailed,
    markFailed: markFailed,
    clearFailed: clearFailed,
    checkWebGPU: checkWebGPU,
    hasWebGPUAdapter: hasWebGPUAdapter,
    onStateChange: onStateChange
  };
})();
