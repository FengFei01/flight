/**
 * PID Knowledge Base — system prompt and context builder for the AI tuning advisor.
 * Owns: PID tuning knowledge, system prompt construction, context injection.
 * Does NOT own: LLM engine, chat UI, FC connection.
 */

(function () {
  'use strict';

  if (window.PIDKnowledge) return;

  var SYSTEM_PROMPT = [
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
    '',
    '## 示例对话',
    '用户: 我的飞机Roll轴高频抖动，电机飞完很烫',
    '助手: 这是 D 项过高导致的典型症状。D 放大高频噪声 → 电机不断微调 → 发热。',
    '',
    '建议调整:',
    '- Roll D: 从当前值降低 15-20% (例如 35→28)',
    '- Roll D_Max: 同比降低 (例如 50→40)',
    '- 如果仍然抖，再降 P 约 10%',
    '- 检查桨叶是否平衡，松动的桨也会引起高频振动',
    '',
    '调整后试飞注意:',
    '1. 先悬停 30 秒观察是否还抖',
    '2. 做几个快速翻滚确认响应没有明显变软',
    '3. 摸电机温度对比之前'
  ].join('\n');

  /**
   * Build context string from available flight data.
   * Reads from window globals set by results page or FC connection.
   */
  function buildContext() {
    var parts = [];

    // BBL analysis data (injected by results page)
    if (window._ffAdvisorContext) {
      var ctx = window._ffAdvisorContext;
      if (ctx.currentPIDs) {
        parts.push('## 当前飞控 PID 值 (来自 BBL 日志)');
        var c = ctx.currentPIDs;
        parts.push('Roll:  P=' + c.roll.p + ' I=' + c.roll.i + ' D=' + c.roll.d + ' FF=' + c.roll.f + ' D_Max=' + c.roll.dMax);
        parts.push('Pitch: P=' + c.pitch.p + ' I=' + c.pitch.i + ' D=' + c.pitch.d + ' FF=' + c.pitch.f + ' D_Max=' + c.pitch.dMax);
        parts.push('Yaw:   P=' + c.yaw.p + ' I=' + c.yaw.i + ' D=' + c.yaw.d + ' FF=' + c.yaw.f + ' D_Max=' + c.yaw.dMax);
      }
      if (ctx.recommendedPIDs) {
        parts.push('\n## AI 推荐 PID 值');
        var r = ctx.recommendedPIDs;
        parts.push('Roll:  P=' + r.roll.p + ' I=' + r.roll.i + ' D=' + r.roll.d + ' FF=' + r.roll.f + ' D_Max=' + r.roll.dMax);
        parts.push('Pitch: P=' + r.pitch.p + ' I=' + r.pitch.i + ' D=' + r.pitch.d + ' FF=' + r.pitch.f + ' D_Max=' + r.pitch.dMax);
        parts.push('Yaw:   P=' + r.yaw.p + ' I=' + r.yaw.i + ' D=' + r.yaw.d + ' FF=' + r.yaw.f + ' D_Max=' + r.yaw.dMax);
      }
      if (ctx.fftPeaks && ctx.fftPeaks.length > 0) {
        parts.push('\n## FFT 频谱分析结果');
        for (var i = 0; i < ctx.fftPeaks.length; i++) {
          var pk = ctx.fftPeaks[i];
          parts.push(pk.axis + ' 轴: ' + pk.freq + 'Hz (幅值 ' + pk.amplitude + 'dB, ' + pk.type + ')');
        }
      }
      if (ctx.filters) {
        parts.push('\n## 当前滤波器设置');
        parts.push('Gyro Lowpass: ' + ctx.filters.gyro_lowpass_hz + ' Hz');
        parts.push('D-term Lowpass: ' + ctx.filters.dterm_lowpass_hz + ' Hz');
      }
      if (ctx.flightScore) {
        parts.push('\n## 飞行评分 (Flight Score)');
        parts.push('综合评分: ' + ctx.flightScore.score + '/100 (' + ctx.flightScore.tier + ')');
        if (ctx.flightScore.breakdown) {
          var bd = ctx.flightScore.breakdown;
          parts.push('PID响应: ' + bd.pidResponse + ' | 振动: ' + bd.vibration + ' | 电机: ' + bd.motorHealth + ' | 滤波: ' + bd.filterEffectiveness);
        }
        if (ctx.flightScore.summary) parts.push('评价: ' + ctx.flightScore.summary);
      }
      if (ctx.motorHealth) {
        parts.push('\n## 电机健康');
        parts.push('Overall: ' + ctx.motorHealth.overall.score + '/100 (' + ctx.motorHealth.overall.rating + ')');
        var axes = ctx.motorHealth.axes;
        if (axes) {
          parts.push('Roll: ' + axes.roll.score + ' (' + axes.roll.rating + ') | Pitch: ' + axes.pitch.score + ' (' + axes.pitch.rating + ') | Yaw: ' + axes.yaw.score + ' (' + axes.yaw.rating + ')');
        }
        if (ctx.motorHealth.issueCount > 0) parts.push('检测到 ' + ctx.motorHealth.issueCount + ' 项异常');
      }
      if (ctx.flightStyle) {
        var styleLabels = { freestyle: 'Freestyle/花飞', racing: 'Racing/竞速', cinematic: 'Cinematic/航拍', longrange: 'Long Range/远航' };
        parts.push('\n飞行风格: ' + (styleLabels[ctx.flightStyle] || ctx.flightStyle));
      }
      if (ctx.firmware) {
        parts.push('固件: ' + ctx.firmware);
      }
      if (ctx.craftName) {
        parts.push('机架名: ' + ctx.craftName);
      }
    }

    // Live FC connection data
    if (window.FcConnectionManager && window.FcConnectionManager.isConnected()) {
      var liveData = window.FcConnectionManager.getLastPIDData && window.FcConnectionManager.getLastPIDData();
      if (liveData) {
        parts.push('\n## 实时飞控 PID 值 (BLE/USB 读取)');
        parts.push('Roll:  P=' + liveData.roll.p + ' I=' + liveData.roll.i + ' D=' + liveData.roll.d);
        parts.push('Pitch: P=' + liveData.pitch.p + ' I=' + liveData.pitch.i + ' D=' + liveData.pitch.d);
        parts.push('Yaw:   P=' + liveData.yaw.p + ' I=' + liveData.yaw.i + ' D=' + liveData.yaw.d);
      }
    }

    return parts.length > 0 ? '\n\n## 用户飞机数据\n' + parts.join('\n') : '';
  }

  /**
   * Build the full messages array for a chat request.
   * @param {Array} history - [{role:'user'|'assistant', content:'...'}, ...]
   * @param {string} userMsg - latest user message
   */
  function buildMessages(history, userMsg) {
    var contextStr = buildContext();
    var sysContent = SYSTEM_PROMPT;
    if (contextStr) {
      sysContent += contextStr;
    }

    var messages = [{ role: 'system', content: sysContent }];

    // Add conversation history (keep last 8 turns to stay within context)
    var recent = history.slice(-8);
    for (var i = 0; i < recent.length; i++) {
      messages.push(recent[i]);
    }

    messages.push({ role: 'user', content: userMsg });
    return messages;
  }

  // Preset quick questions
  var PRESETS = [
    { label: '飞机抖动严重', msg: '我的飞机飞行时高频抖动，电机很烫，该怎么调？' },
    { label: '刹车时过冲', msg: '快速打杆后松手，飞机会过冲再回来，怎么解决？' },
    { label: '悬停不稳', msg: '悬停时飞机会慢慢漂移，位置不稳，需要调什么参数？' },
    { label: '响应太慢', msg: '打杆感觉响应迟钝，像棉花一样，怎么让它更灵敏？' },
    { label: 'Yaw 轴摆头', msg: 'Yaw 轴经常自己摆动，不稳定，怎么调？' },
    { label: '帮我选PID', msg: '我是5寸自由式飞机，能帮我推荐一套基础 PID 参数吗？' }
  ];

  window.PIDKnowledge = {
    buildMessages: buildMessages,
    buildContext: buildContext,
    PRESETS: PRESETS
  };
})();
