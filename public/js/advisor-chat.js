/**
 * Advisor Chat UI — local-first with server fallback state machine.
 * Owns: Chat rendering, user input, fallback logic (local WebLLM → server API), status display.
 * Does NOT own: LLM engine (webllm-engine.js), PID knowledge (pid-knowledge.js), server inference (routes/advisor.js).
 */

(function () {
  'use strict';

  // DOM refs
  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var sendBtn = document.getElementById('sendBtn');
  var presetWrap = document.getElementById('presetBtns');
  var statusBar = document.getElementById('engineStatus');
  var statusText = document.getElementById('engineStatusText');
  var statusProgress = document.getElementById('engineProgress');
  var statusProgressFill = document.getElementById('engineProgressFill');
  var initBtn = document.getElementById('initEngineBtn');
  var backendIndicator = document.getElementById('backendIndicator');
  var backendDetail = document.getElementById('backendDetail');

  if (!chatMessages || !chatInput) return; // not on advisor page

  var history = []; // conversation history for context
  var isGenerating = false;

  // --- Inference Backend State ---
  // 'local'  = WebLLM ready and working
  // 'server' = using POST /api/advisor/chat
  // 'none'   = neither available yet (initial state, or loading)
  var inferenceBackend = 'none';
  // WHY track webgpuSupported separately: hasWebGPUAdapter is async, we cache the result
  var webgpuSupported = null; // null = unknown, true/false after check

  // --- Render Helpers ---
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Simple markdown: **bold**, `code`, ```block```, newlines */
  function renderMarkdown(text) {
    text = text.replace(/```([\s\S]*?)```/g, function (_, code) {
      return '<pre class="chat-code-block"><code>' + escapeHtml(code.trim()) + '</code></pre>';
    });
    text = text.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/((?:^\|.*\|$\n?)+)/gm, function (table) {
      var rows = table.trim().split('\n');
      var html = '<div class="chat-table-wrap"><table class="chat-table">';
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.match(/^\|[\s-:|]+\|$/)) continue;
        var cells = row.split('|').filter(function (c, idx, arr) { return idx > 0 && idx < arr.length - 1; });
        var tag = i === 0 ? 'th' : 'td';
        html += '<tr>';
        for (var j = 0; j < cells.length; j++) {
          html += '<' + tag + '>' + cells[j].trim() + '</' + tag + '>';
        }
        html += '</tr>';
      }
      html += '</table></div>';
      return html;
    });
    text = text.replace(/\n/g, '<br>');
    text = text.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/g, function (m, attrs, inner) {
      return '<pre' + attrs + '>' + inner.replace(/<br>/g, '\n') + '</pre>';
    });
    return text;
  }

  function addMessage(role, content, id) {
    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-' + role;
    if (id) bubble.id = id;

    var avatar = document.createElement('div');
    avatar.className = 'chat-avatar chat-avatar-' + role;
    avatar.textContent = role === 'user' ? '🧑‍✈️' : '🤖';

    var body = document.createElement('div');
    body.className = 'chat-body';
    body.innerHTML = renderMarkdown(content);

    bubble.appendChild(avatar);
    bubble.appendChild(body);
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return bubble;
  }

  function updateMessage(id, content) {
    var el = document.getElementById(id);
    if (!el) return;
    var body = el.querySelector('.chat-body');
    if (body) body.innerHTML = renderMarkdown(content);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addSystemMessage(text) {
    var div = document.createElement('div');
    div.className = 'chat-system';
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addErrorMessage(text, onRetry) {
    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-error';

    var avatar = document.createElement('div');
    avatar.className = 'chat-avatar chat-avatar-error';
    avatar.textContent = '⚠️';

    var body = document.createElement('div');
    body.className = 'chat-body chat-body-error';

    var msg = document.createElement('div');
    msg.textContent = text;
    body.appendChild(msg);

    if (onRetry) {
      var retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'chat-retry-btn';
      retryBtn.textContent = '🔄 重试';
      retryBtn.addEventListener('click', function () {
        bubble.remove();
        onRetry();
      });
      body.appendChild(retryBtn);
    }

    bubble.appendChild(avatar);
    bubble.appendChild(body);
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // --- Backend Indicator ---
  function setBackendIndicator(mode) {
    inferenceBackend = mode;
    if (!backendIndicator) return;

    if (mode === 'local') {
      backendIndicator.textContent = '🖥️ 本地推理 · 离线可用';
      backendIndicator.className = 'backend-indicator backend-local';
      if (backendDetail) backendDetail.style.display = 'none';
    } else if (mode === 'server') {
      backendIndicator.textContent = '☁️ 已切换到云端兼容模式';
      backendIndicator.className = 'backend-indicator backend-server';
      if (backendDetail) {
        backendDetail.textContent = '您的设备暂不支持本地推理，已自动切换到云端服务。响应可能需要几秒到十几秒。';
        backendDetail.style.display = 'block';
      }
    } else if (mode === 'busy') {
      backendIndicator.textContent = '⏳ 云端服务繁忙，请稍后重试';
      backendIndicator.className = 'backend-indicator backend-busy';
      if (backendDetail) backendDetail.style.display = 'none';
    } else {
      backendIndicator.textContent = '';
      backendIndicator.className = 'backend-indicator';
      if (backendDetail) backendDetail.style.display = 'none';
    }
  }

  // --- Engine State Updates ---
  function updateEngineStatus(engineState, progress, error) {
    var icons = {
      idle: '⏸️', checking: '🔍', downloading: '⬇️', loading: '⚙️',
      ready: '✅', generating: '💭', error: '❌',
      recovering: '🔄'
    };
    var labels = {
      idle: '点击下方按钮初始化 AI 模型',
      checking: '检查 WebGPU 支持...',
      downloading: progress.text || '下载中...',
      loading: '加载模型到 GPU...',
      ready: 'AI 顾问就绪',
      generating: '正在思考...',
      error: error || '出错了',
      recovering: '正在恢复，请稍候…',
    };

    // When using server backend, override status display
    if (inferenceBackend === 'server' && engineState === 'error') {
      statusText.textContent = '☁️ 云端模式运行中';
    } else {
      statusText.textContent = (icons[engineState] || '') + ' ' + (labels[engineState] || engineState);
    }

    if (engineState === 'downloading' || engineState === 'loading' || engineState === 'recovering') {
      statusProgress.style.display = 'block';
      statusProgressFill.style.width = Math.round((progress.progress || 0) * 100) + '%';
    } else {
      statusProgress.style.display = 'none';
    }

    // Toggle init button — hide when using server fallback
    if (initBtn) {
      var showInit = (engineState === 'idle' || engineState === 'error') && inferenceBackend !== 'server';
      initBtn.style.display = showInit ? 'inline-flex' : 'none';
      if (engineState === 'error') {
        initBtn.textContent = '🔄 重新加载模型';
        initBtn._useReinit = true;
      } else {
        initBtn.textContent = '🧠 加载 AI 模型';
        initBtn._useReinit = false;
      }
    }

    // Toggle input area — enable when local ready OR server mode active
    var inputEnabled = (engineState === 'ready') || (inferenceBackend === 'server');
    chatInput.disabled = !inputEnabled || isGenerating;
    sendBtn.disabled = !inputEnabled || isGenerating;

    // Status bar color
    if (inferenceBackend === 'server' && engineState !== 'ready') {
      statusBar.className = 'engine-status engine-status-ready';
    } else {
      statusBar.className = 'engine-status engine-status-' + engineState;
    }

    // Update backend indicator when local engine becomes ready
    if (engineState === 'ready' && inferenceBackend !== 'server') {
      setBackendIndicator('local');
      // Clear failed flag on successful engine load
      if (window.WebLLMEngine && window.WebLLMEngine.clearFailed) {
        window.WebLLMEngine.clearFailed();
      }
    }
  }

  // --- Context Extraction for Server Requests ---
  // Extracts structured context from page state — no raw BBL or DOM
  function extractAdvisorContext() {
    var ctx = {};
    if (window._ffAdvisorContext) {
      var src = window._ffAdvisorContext;
      if (src.currentPIDs) ctx.pids = src.currentPIDs;
      if (src.recommendedPIDs) ctx.recommendedPIDs = src.recommendedPIDs;
      if (src.fftPeaks) ctx.fftPeaks = src.fftPeaks.slice(0, 5);
      if (src.firmware) ctx.firmware = src.firmware;
      if (src.craftName) ctx.craftName = src.craftName;
      if (src.filters) ctx.filters = src.filters;
      if (src.flightStyle) ctx.flightStyle = src.flightStyle;
      if (src.flightScore) ctx.flightScore = src.flightScore;
      if (src.motorHealth) ctx.motorHealth = src.motorHealth;
    }
    // Live FC data
    if (window.FcConnectionManager && window.FcConnectionManager.isConnected()) {
      var liveData = window.FcConnectionManager.getLastPIDData && window.FcConnectionManager.getLastPIDData();
      if (liveData) ctx.livePIDs = liveData;
    }
    return Object.keys(ctx).length > 0 ? ctx : null;
  }

  // --- Server-side Chat API ---
  async function sendToServer(text, replyId) {
    // Build messages: last 3-5 turns + current
    var recentHistory = history.slice(-6); // 3 turns = 6 messages
    var messages = recentHistory.concat([{ role: 'user', content: text }]);
    var advisorContext = extractAdvisorContext();

    try {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 35000);

      var response = await fetch('/api/advisor/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages, advisorContext: advisorContext }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 503 || response.status === 429) {
          return { error: 'busy' };
        }
        if (response.status === 408) {
          return { error: 'timeout' };
        }
        return { error: 'server-error', message: '服务器错误 (' + response.status + ')' };
      }

      var data = await response.json();
      return { reply: data.reply, model: data.model, backend: data.backend };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { error: 'timeout' };
      }
      return { error: 'network', message: err.message || '网络错误' };
    }
  }

  // --- Switch to Server Fallback ---
  function switchToServerMode(reason) {
    if (inferenceBackend === 'server') return; // already in server mode
    console.log('[advisor-chat] Switching to server mode:', reason);
    setBackendIndicator('server');
    addSystemMessage('☁️ 已切换到云端兼容模式 — ' + (reason || '本地推理不可用'));

    // Enable input since server is available
    chatInput.disabled = isGenerating;
    sendBtn.disabled = isGenerating;
  }

  // --- Send Message (core fallback state machine) ---
  async function sendMessage(text) {
    if (!text.trim() || isGenerating) return;

    // Determine if we can send at all
    var localReady = window.WebLLMEngine && window.WebLLMEngine.isReady();
    var localFailed = window.WebLLMEngine && window.WebLLMEngine.isFailed && window.WebLLMEngine.isFailed();
    var canUseLocal = localReady && !localFailed;
    var canUseServer = (inferenceBackend === 'server') || !canUseLocal;

    if (!canUseLocal && inferenceBackend !== 'server') {
      // Neither local ready nor server mode — check if we should auto-switch
      if (localFailed || webgpuSupported === false) {
        switchToServerMode(webgpuSupported === false ? '未检测到 WebGPU 支持' : '本地推理失败');
        canUseServer = true;
      } else {
        addSystemMessage('请先等待 AI 模型加载完成，或稍候自动切换到云端模式');
        return;
      }
    }

    isGenerating = true;
    sendBtn.disabled = true;
    chatInput.disabled = true;
    chatInput.value = '';

    // Hide presets after first message
    if (presetWrap) presetWrap.style.display = 'none';

    addMessage('user', text);
    var replyId = 'reply-' + Date.now();
    addMessage('assistant', '思考中...', replyId);

    // --- Try local first ---
    if (canUseLocal) {
      var localSuccess = await tryLocalInference(text, replyId);
      if (localSuccess) {
        finishGenerating();
        return;
      }
      // Local failed — fall through to server
      console.log('[advisor-chat] Local inference failed, falling through to server');
      window.WebLLMEngine.markFailed();
      switchToServerMode('本地推理出错，已自动切换');
    }

    // --- Server fallback ---
    var serverResult = await sendToServer(text, replyId);
    if (serverResult.error) {
      var placeholder = document.getElementById(replyId);
      if (placeholder) placeholder.remove();

      if (serverResult.error === 'busy' || serverResult.error === 'timeout') {
        setBackendIndicator('busy');
        addErrorMessage('云端服务繁忙，请稍后重试', function () {
          setBackendIndicator('server');
          sendMessage(text);
        });
      } else {
        addErrorMessage('服务暂时不可用: ' + (serverResult.message || '请稍后重试'), function () {
          sendMessage(text);
        });
      }
    } else {
      updateMessage(replyId, serverResult.reply);
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: serverResult.reply });
    }

    finishGenerating();
  }

  /** Attempt local WebLLM inference. Returns true on success, false on failure. */
  function tryLocalInference(text, replyId) {
    return new Promise(function (resolve) {
      var messages = window.PIDKnowledge.buildMessages(history, text);

      window.WebLLMEngine.chat(
        messages,
        function onChunk(delta, fullText) {
          updateMessage(replyId, fullText);
        },
        function onDone(err, fullText) {
          if (err) {
            // Remove failed placeholder — will be re-created by server path
            var placeholder = document.getElementById(replyId);
            if (placeholder) {
              // Reset placeholder text for server attempt
              updateMessage(replyId, '思考中... (正在切换到云端)');
            }
            resolve(false);
          } else {
            history.push({ role: 'user', content: text });
            history.push({ role: 'assistant', content: fullText });
            resolve(true);
          }
        }
      );
    });
  }

  function finishGenerating() {
    isGenerating = false;
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }

  // --- Init ---
  function init() {
    // Engine state listener
    window.WebLLMEngine.onStateChange(updateEngineStatus);
    updateEngineStatus('idle', { text: '', progress: 0 }, '');

    // Init button — uses reinit() on error, init() on first load
    if (initBtn) {
      initBtn.addEventListener('click', function () {
        if (initBtn._useReinit) {
          window.WebLLMEngine.reinit();
        } else {
          window.WebLLMEngine.init();
        }
      });
    }

    // Send button
    sendBtn.addEventListener('click', function () {
      sendMessage(chatInput.value);
    });

    // Enter to send
    chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(chatInput.value);
      }
    });

    // Preset buttons — now work in both local and server mode
    if (presetWrap && window.PIDKnowledge) {
      var presets = window.PIDKnowledge.PRESETS;
      for (var i = 0; i < presets.length; i++) {
        (function (preset) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'preset-btn';
          btn.textContent = preset.label;
          btn.addEventListener('click', function () {
            var canSend = window.WebLLMEngine.isReady() || inferenceBackend === 'server';
            if (canSend) {
              sendMessage(preset.msg);
            } else {
              addSystemMessage('请先加载 AI 模型，或等待系统检测完成');
            }
          });
          presetWrap.appendChild(btn);
        })(presets[i]);
      }
    }

    // Check context availability — show what was loaded
    if (window._ffAdvisorContext && window._ffAdvisorContext.currentPIDs) {
      var ctxParts = ['PID'];
      if (window._ffAdvisorContext.filters) ctxParts.push('滤波');
      if (window._ffAdvisorContext.flightScore) ctxParts.push('评分' + window._ffAdvisorContext.flightScore.score);
      if (window._ffAdvisorContext.motorHealth) ctxParts.push('电机健康');
      if (window._ffAdvisorContext.fftPeaks && window._ffAdvisorContext.fftPeaks.length > 0) ctxParts.push('FFT');
      addSystemMessage('📊 已加载分析数据 (' + ctxParts.join(' · ') + ')，AI 将基于你的实际飞行数据给出建议');
    }

    // Async WebGPU pre-check — determines initial backend
    window.WebLLMEngine.hasWebGPUAdapter().then(function (supported) {
      webgpuSupported = supported;
      if (supported) {
        addSystemMessage('检测到 WebGPU 支持。点击"加载 AI 模型"开始本地推理 (首次需下载 ~1GB)');
      } else {
        // No WebGPU — auto-switch to server mode
        window.WebLLMEngine.markFailed();
        switchToServerMode('未检测到 WebGPU 支持');
        addSystemMessage('您的浏览器不支持 WebGPU，已自动启用云端推理模式。可直接开始对话。');
      }
    });
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
