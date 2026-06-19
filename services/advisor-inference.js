/**
 * Server-side PID advisor inference — OpenAI-compatible proxy to Qwen/equivalent model.
 * Owns: system prompt, inference call, concurrency/timeout guards, rule-based fallback.
 * Does NOT own: route handling (see routes/advisor.js), client-side LLM (see public/js/webllm-engine.js).
 *
 * WHY proxy instead of self-hosted: Render instances have 512MB RAM — a q4 1.5B model
 * needs ~1GB for weights alone. The Polsia AI proxy provides the same model quality
 * with zero memory overhead.
 */
const OpenAI = require('openai');

// --- Concurrency control ---
let activeRequests = 0;
const MAX_CONCURRENT = 2;
const INFERENCE_TIMEOUT_MS = 30000;
const MAX_MESSAGES = 5; // last N turns of conversation
const MAX_CONTEXT_CHARS = 4000; // ~2000 tokens rough estimate

// System prompt — mirrors public/js/pid-knowledge.js SYSTEM_PROMPT exactly
const SYSTEM_PROMPT = [
  '你是 FlightForge AI 调参顾问，专精 Betaflight FPV 无人机 PID 调参。',
  '用中文回答。简洁实用，给出具体参数调整建议。',
  '',
  '## PID 参数含义',
  '- P (Proportional): 比例增益。控制对误差的即时响应速度。P 越高响应越快，但过高会导致高频振荡。',
  '- I (Integral): 积分增益。消除持续偏差和漂移。I 越高锁定目标越稳，但过高导致低频摆动。',
  '- D (Derivative): 微分增益。阻尼振荡，预测变化趋势。D 越高阻尼越强，但过高产生电机发热和噪声放大。',
  '- FF (Feedforward): 前馈。直接响应摇杆输入，不等误差产生。FF 越高响应越直接，适合竞速。',
  '- D_Max: D 项上限。运动时 D 可动态升到 D_Max，静止时回落到 D 值。提升了积极飞行的阻尼而不影响悬停噪声。',
  '',
  '## 常见症状 → 参数映射',
  '| 症状 | 主要调整 | 次要调整 |',
  '|------|---------|---------|',
  '| 高频抖动/电机烫 | 降低 D, 降低 D_Max | 检查滤波器, 降低 P |',
  '| 刹车过冲 (overshoot) | 降低 P | 提高 D, 检查 FF |',
  '| 响应迟钝/棉花感 | 提高 P, 提高 FF | 适当提高 D_Max |',
  '| 悬停漂移/不稳 | 提高 I | 检查 P 是否过低 |',
  '| 转弯后弹回 | 降低 I | 提高 D |',
  '| Yaw 不稳/摆头 | 降低 Yaw P | 提高 Yaw I, 检查机械问题 |',
  '| 油门快速变化时抖 | 降低 D, 调整 TPA | 检查电调协议和更新频率 |',
  '| 直线飞行偏移 | 提高 I | 检查重心, 机臂弯曲 |',
  '',
  '## 安全边界 (5寸机典型)',
  '- P: Roll/Pitch 30-70, 常用 40-55. 超过 70 高风险',
  '- I: Roll/Pitch 50-120, 常用 70-100',
  '- D: Roll/Pitch 20-45, 常用 25-40. 超过 50 电机发热风险',
  '- FF: Roll/Pitch 0-200, 竞速常用 100-150',
  '- D_Max: 通常 D + 10~25, 如 D=35 则 D_Max 45-60',
  '- Yaw P: 30-60, I: 50-120, D: 一般为 0',
  '',
  '## 机型参考值',
  '| 机型 | Roll P/I/D | Pitch P/I/D | 备注 |',
  '|------|-----------|-------------|------|',
  '| 5寸自由式 | 45/80/30 | 47/84/32 | 均衡舒适 |',
  '| 5寸竞速 | 55/90/35 | 58/95/38 | 高响应 FF=120+ |',
  '| 7寸长航时 | 35/65/25 | 38/68/28 | 低D减发热 |',
  '| 3寸 Toothpick | 50/85/35 | 52/88/38 | 轻载高P |',
  '| 10寸 X-Class | 25/50/18 | 28/55/20 | 保守安全 |',
  '',
  '## 滤波器建议原则',
  '- Gyro Lowpass: 默认 200-250Hz, 噪声大可降到 150Hz',
  '- D-term Lowpass: 默认 100-150Hz, 电机烫降到 80-100Hz',
  '- Dynamic Notch: 保持开启, 让 Betaflight 自动追踪电机谐振',
  '- 手动 Notch: 仅在 FFT 分析显示明确固定频率峰时使用',
  '',
  '## 回答格式要求',
  '1. 先简述问题诊断',
  '2. 给出具体参数调整建议（写明具体数值或调整方向和幅度）',
  '3. 如果合适，给出建议的 PID 参数表',
  '4. 提醒注意事项和下一步测试方法',
].join('\n');


/**
 * Rule-based PID advice — used when LLM is unavailable (busy/error).
 * Pattern-matches common Chinese FPV keywords and returns canned advice.
 */
function ruleBasedFallback(userMessage, advisorContext) {
  const msg = userMessage.toLowerCase();
  const pids = advisorContext?.pids || {};

  // Vibration / motor heat
  if (msg.includes('抖') || msg.includes('震') || msg.includes('烫') || msg.includes('发热') || msg.includes('vibrat')) {
    const rollD = pids.roll?.d || 30;
    const newD = Math.round(rollD * 0.80);
    return `**诊断：高频振荡 / 电机过热**\n\n` +
      `这是 D 项过高的典型表现。D 放大高频噪声导致电机持续微调。\n\n` +
      `**建议调整：**\n` +
      `- Roll/Pitch D: 降低 20%（例如 ${rollD} → ${newD}）\n` +
      `- D_Max: 同比降低\n` +
      `- 如果仍抖，再降 P 约 10%\n` +
      `- 检查桨叶平衡和电机轴承\n\n` +
      `*（服务繁忙，此为基于规则的快速建议。如需更详细的 AI 分析，请稍后重试。）*`;
  }

  // Overshoot
  if (msg.includes('过冲') || msg.includes('overshoot') || msg.includes('弹回') || msg.includes('回弹')) {
    const rollP = pids.roll?.p || 45;
    const newP = Math.round(rollP * 0.88);
    return `**诊断：刹车过冲**\n\n` +
      `P 项过高导致响应过度，松杆后惯性过冲。\n\n` +
      `**建议调整：**\n` +
      `- Roll/Pitch P: 降低约 12%（例如 ${rollP} → ${newP}）\n` +
      `- 适当提高 D 来增加阻尼\n` +
      `- 检查 FF 是否过高\n\n` +
      `*（服务繁忙，此为基于规则的快速建议。）*`;
  }

  // Sluggish response
  if (msg.includes('迟钝') || msg.includes('棉花') || msg.includes('慢') || msg.includes('响应') || msg.includes('sluggish')) {
    const rollP = pids.roll?.p || 45;
    const newP = Math.round(rollP * 1.12);
    return `**诊断：响应迟缓**\n\n` +
      `P 和 FF 不够导致操控延迟感。\n\n` +
      `**建议调整：**\n` +
      `- Roll/Pitch P: 提高约 10-15%（例如 ${rollP} → ${newP}）\n` +
      `- 提高 FF 到 120-150\n` +
      `- 适当提高 D_Max\n\n` +
      `*（服务繁忙，此为基于规则的快速建议。）*`;
  }

  // Hover drift
  if (msg.includes('漂移') || msg.includes('不稳') || msg.includes('drift') || msg.includes('悬停')) {
    return `**诊断：悬停不稳 / 漂移**\n\n` +
      `I 项不足导致无法消除持续偏差。\n\n` +
      `**建议调整：**\n` +
      `- Roll/Pitch I: 提高 10-15%（常用范围 70-100）\n` +
      `- 确认 P 不是过低\n` +
      `- 检查重心是否居中、机臂是否弯曲\n\n` +
      `*（服务繁忙，此为基于规则的快速建议。）*`;
  }

  // Yaw issues
  if (msg.includes('yaw') || msg.includes('摆头') || msg.includes('偏航')) {
    return `**诊断：Yaw 轴不稳**\n\n` +
      `Yaw P 过高或机械问题导致偏航振荡。\n\n` +
      `**建议调整：**\n` +
      `- Yaw P: 降低到 35-45 范围\n` +
      `- Yaw I: 适当提高到 80-100\n` +
      `- 检查电机座和机臂是否松动\n\n` +
      `*（服务繁忙，此为基于规则的快速建议。）*`;
  }

  // Generic PID recommendation
  if (msg.includes('pid') || msg.includes('推荐') || msg.includes('参数') || msg.includes('调参')) {
    return `**5 寸自由式基础 PID 参数推荐：**\n\n` +
      `| 轴 | P | I | D | FF | D_Max |\n` +
      `|---|---|---|---|---|---|\n` +
      `| Roll | 45 | 80 | 30 | 120 | 40 |\n` +
      `| Pitch | 47 | 84 | 32 | 125 | 42 |\n` +
      `| Yaw | 45 | 90 | 0 | 75 | 0 |\n\n` +
      `以此为起点，根据试飞感受微调。\n\n` +
      `*（服务繁忙，此为基于规则的快速建议。）*`;
  }

  // Fallback generic
  return `**PID 调参通用建议：**\n\n` +
    `1. 先确保机械状态良好（桨平衡、电机无异响、机臂无裂纹）\n` +
    `2. 从 Betaflight 默认值开始微调\n` +
    `3. 每次只调一个参数，幅度 10-15%\n` +
    `4. 先调 P（手感锐度），再调 D（抖动控制），最后调 I（悬停稳定性）\n\n` +
    `请描述具体问题（如"高频抖动"、"响应慢"等），我可以给更针对性的建议。\n\n` +
    `*（服务繁忙，此为基于规则的快速建议。如需 AI 详细分析，请稍后重试。）*`;
}


/**
 * Build a human-readable context string from advisorContext.
 * WHY not JSON: The LLM responds better to structured text than raw JSON dumps.
 */
function formatContext(advisorContext) {
  if (!advisorContext) return '';
  const parts = [];

  if (advisorContext.pids) {
    parts.push('## 当前 PID 值');
    const c = advisorContext.pids;
    for (const axis of ['roll', 'pitch', 'yaw']) {
      if (c[axis]) {
        parts.push(`${axis}: P=${c[axis].p} I=${c[axis].i} D=${c[axis].d} FF=${c[axis].f || 0} D_Max=${c[axis].dMax || 0}`);
      }
    }
  }

  if (advisorContext.recommendedPIDs) {
    parts.push('\n## AI 推荐 PID 值');
    const r = advisorContext.recommendedPIDs;
    for (const axis of ['roll', 'pitch', 'yaw']) {
      if (r[axis]) {
        parts.push(`${axis}: P=${r[axis].p} I=${r[axis].i} D=${r[axis].d} FF=${r[axis].f || 0} D_Max=${r[axis].dMax || 0}`);
      }
    }
  }

  if (advisorContext.filters) {
    parts.push(`\nGyro Lowpass: ${advisorContext.filters.gyro_lowpass_hz} Hz, D-term Lowpass: ${advisorContext.filters.dterm_lowpass_hz} Hz`);
  }

  if (advisorContext.flightScore) {
    const fs = advisorContext.flightScore;
    parts.push(`\n飞行评分: ${fs.score}/100 (${fs.tier})`);
    if (fs.breakdown) {
      parts.push(`PID响应: ${fs.breakdown.pidResponse} | 振动: ${fs.breakdown.vibration} | 电机: ${fs.breakdown.motorHealth} | 滤波: ${fs.breakdown.filterEffectiveness}`);
    }
  }

  if (advisorContext.motorHealth) {
    const mh = advisorContext.motorHealth;
    parts.push(`\n电机健康: ${mh.overall.score}/100 (${mh.overall.rating})`);
    if (mh.axes) {
      parts.push(`Roll: ${mh.axes.roll.score} | Pitch: ${mh.axes.pitch.score} | Yaw: ${mh.axes.yaw.score}`);
    }
    if (mh.issueCount > 0) parts.push(`异常数: ${mh.issueCount}`);
  }

  if (advisorContext.fftPeaks && advisorContext.fftPeaks.length > 0) {
    parts.push('\n## FFT 频谱峰值');
    for (const pk of advisorContext.fftPeaks.slice(0, 5)) {
      parts.push(`${pk.axis}: ${pk.freq}Hz (${pk.amplitude}dB, ${pk.type})`);
    }
  }

  if (advisorContext.flightStyle) {
    const styleLabels = { freestyle: 'Freestyle/花飞', racing: 'Racing/竞速', cinematic: 'Cinematic/航拍', longrange: 'Long Range/远航' };
    parts.push(`\n飞行风格: ${styleLabels[advisorContext.flightStyle] || advisorContext.flightStyle}`);
  }
  if (advisorContext.firmware) parts.push(`固件: ${advisorContext.firmware}`);
  if (advisorContext.craftName) parts.push(`机架名: ${advisorContext.craftName}`);

  const result = parts.join('\n');
  return result.length <= MAX_CONTEXT_CHARS ? result : result.slice(0, MAX_CONTEXT_CHARS);
}


/**
 * Build the messages array for the LLM call.
 */
function buildMessages(messages, advisorContext) {
  let systemContent = SYSTEM_PROMPT;
  const ctxStr = formatContext(advisorContext);
  if (ctxStr) {
    systemContent += '\n\n## 用户飞机数据\n' + ctxStr;
  }

  const result = [{ role: 'system', content: systemContent }];

  // Trim to last MAX_MESSAGES turns
  const recent = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES * 2) : [];
  for (const m of recent) {
    if (m.role === 'user' || m.role === 'assistant') {
      result.push({ role: m.role, content: String(m.content || '').slice(0, 2000) });
    }
  }
  return result;
}


/**
 * Run inference via OpenAI-compatible proxy.
 * Returns { reply, model, backend } on success.
 * Throws on timeout or API error.
 */
async function runInference(messages, advisorContext) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });

  const builtMessages = buildMessages(messages, advisorContext);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);

  try {
    const completion = await client.chat.completions.create({
      model: 'qwen-2.5-7b',
      messages: builtMessages,
      temperature: 0.7,
      max_tokens: 1024,
      // Polsia AI proxy routing hint
      task: 'pid-advisor-chat',
    }, { signal: controller.signal });

    const reply = completion.choices?.[0]?.message?.content || '';
    const model = completion.model || 'qwen-2.5';
    return { reply, model, backend: 'server' };
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Main entry — handles concurrency gating + fallback.
 * Returns { reply, model, backend, fallback? } always.
 */
async function chat(messages, advisorContext) {
  // Extract the latest user message for rule-based fallback
  const lastUserMsg = [...(messages || [])].reverse().find(m => m.role === 'user');
  const userText = lastUserMsg?.content || '';

  // Concurrency gate
  if (activeRequests >= MAX_CONCURRENT) {
    return {
      reply: ruleBasedFallback(userText, advisorContext),
      model: 'rule-based',
      backend: 'server-fallback',
      fallback: true,
    };
  }

  activeRequests++;
  try {
    return await runInference(messages, advisorContext);
  } catch (err) {
    console.error('[advisor-inference] LLM error:', err.message);
    // On any error (timeout, API failure), degrade to rules
    return {
      reply: ruleBasedFallback(userText, advisorContext),
      model: 'rule-based',
      backend: 'server-fallback',
      fallback: true,
    };
  } finally {
    activeRequests--;
  }
}

module.exports = { chat, ruleBasedFallback, buildMessages, SYSTEM_PROMPT };
