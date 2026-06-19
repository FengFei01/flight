const express = require('express');
const multer = require('multer');
const { insertFeedback } = require('../db/feedback');

const router = express.Router();

const ALLOWED_TYPES = ['问题反馈', '功能建议', '使用咨询', '其他'];

function escapeHtml(str) {
  if (!str) return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const EMAIL_API_BASE = process.env.POLSIA_API_BASE_URL;
const EMAIL_API_TOKEN = process.env.POLSIA_API_TOKEN || process.env.POLSIA_API_KEY;
const EMAIL_OWNER = process.env.POLSIA_OWNER_EMAIL;
if (!EMAIL_API_BASE || !EMAIL_API_TOKEN || !EMAIL_OWNER) {
  console.warn('[feedback] Email notification disabled: missing POLSIA_API_BASE_URL, POLSIA_API_TOKEN/POLSIA_API_KEY, or POLSIA_OWNER_EMAIL');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('仅支持图片文件'));
    }
  },
});

// Rate limiting: max 5 submissions per IP per hour
const rateMap = new Map();
const RATE_WINDOW = 60 * 60 * 1000;
const RATE_LIMIT = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = rateMap.get(ip) || [];
  const recent = timestamps.filter(t => now - t < RATE_WINDOW);
  rateMap.set(ip, recent);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  return true;
}

// Clean up stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateMap) {
    const recent = timestamps.filter(t => now - t < RATE_WINDOW);
    if (recent.length === 0) rateMap.delete(ip);
    else rateMap.set(ip, recent);
  }
}, 30 * 60 * 1000).unref();

router.post('/', upload.single('screenshot'), async (req, res) => {
  try {
    if (req.body.website) {
      return res.status(201).json({ ok: true });
    }

    const content = (req.body.content || '').trim();
    if (!content || content.length < 10) {
      return res.status(400).json({ error: '反馈内容至少需要10个字符' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ error: '反馈内容不能超过2000字' });
    }

    const type = (req.body.type || '').trim();
    if (!type || !ALLOWED_TYPES.includes(type)) {
      return res.status(400).json({ error: '请选择反馈类型' });
    }

    const ip = req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: '每小时最多提交5次，请稍后再试' });
    }

    let screenshotUrl = null;
    if (req.file) {
      screenshotUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    const contactInfo = (req.body.contact_info || '').trim() || null;
    if (contactInfo && contactInfo.length > 200) {
      return res.status(400).json({ error: '联系方式不能超过200字' });
    }

    const safeContent = escapeHtml(content);
    const safeContact = escapeHtml(contactInfo);

    const userAgent = req.headers['user-agent'] || null;
    const sourcePage = (req.body.source_page || req.headers.referer || '').slice(0, 255) || null;

    await insertFeedback(content, contactInfo, screenshotUrl, type, userAgent, sourcePage);

    const submittedAt = new Date().toISOString();
    if (EMAIL_API_BASE && EMAIL_API_TOKEN && EMAIL_OWNER) {
      const plainBody = `新反馈内容:\n\n类型: ${type}\n内容: ${content}\n\n联系方式: ${contactInfo || '未提供'}\n提交时间: ${submittedAt}`;
      const htmlBody = `<h3>FlightForge 新反馈</h3><p><strong>类型:</strong> ${escapeHtml(type)}</p><p><strong>内容:</strong></p><p>${safeContent.replace(/\n/g, '<br>')}</p><p><strong>联系方式:</strong> ${safeContact || '未提供'}</p><p><strong>提交时间:</strong> ${submittedAt}</p>${screenshotUrl ? '<p><em>附带截图</em></p>' : ''}`;

      fetch(`${EMAIL_API_BASE}/api/proxy/email/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${EMAIL_API_TOKEN}`,
        },
        body: JSON.stringify({
          to: EMAIL_OWNER,
          subject: `FlightForge 新反馈`,
          body: plainBody,
          html: htmlBody,
        }),
      })
        .then(r => { if (!r.ok) console.error('[feedback] Email API returned status', r.status); })
        .catch(err => { console.error('[feedback] Email notification failed:', err.message); });
    } else {
      console.warn('[feedback] Email skipped: missing env vars');
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[feedback] Error saving feedback:', err.message);
    return res.status(500).json({ error: '提交失败，请稍后重试' });
  }
});

// Multer error handler
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '截图文件不能超过5MB' });
    }
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
