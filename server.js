const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());
app.use(express.static('public'));

const CONFIG_FILE = './config.json';

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch(e) {}
  return {
    google_vision_key: process.env.GOOGLE_VISION_KEY || '',
    bitrix_url: process.env.BITRIX_WEBHOOK_URL || '',
    admin_user: process.env.ADMIN_USER || 'admin',
    admin_pass: process.env.ADMIN_PASS || 'admin123',
    sales_users: []
  };
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

function adminAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) return res.status(401).json({ error: 'Yetkisiz' });
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  const cfg = getConfig();
  if (user === cfg.admin_user && pass === cfg.admin_pass) return next();
  res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
}

// Admin endpoints
app.get('/admin/config', adminAuth, (req, res) => {
  const cfg = getConfig();
  res.json({
    google_vision_key: cfg.google_vision_key ? '***' + cfg.google_vision_key.slice(-6) : '',
    bitrix_url: cfg.bitrix_url || '',
    admin_user: cfg.admin_user,
    sales_users: (cfg.sales_users || []).map(u => ({ id: u.id, name: u.name, bitrix_id: u.bitrix_id }))
  });
});

app.post('/admin/config', adminAuth, (req, res) => {
  const cfg = getConfig();
  const { google_vision_key, bitrix_url, admin_user, new_pass } = req.body;
  if (google_vision_key && !google_vision_key.startsWith('***')) cfg.google_vision_key = google_vision_key;
  if (bitrix_url !== undefined) cfg.bitrix_url = bitrix_url;
  if (admin_user) cfg.admin_user = admin_user;
  if (new_pass) cfg.admin_pass = new_pass;
  saveConfig(cfg);
  res.json({ success: true });
});

app.delete('/admin/config/:key', adminAuth, (req, res) => {
  const cfg = getConfig();
  if (req.params.key === 'google_vision_key') cfg.google_vision_key = '';
  if (req.params.key === 'bitrix_url') cfg.bitrix_url = '';
  saveConfig(cfg);
  res.json({ success: true });
});

app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body;
  const cfg = getConfig();
  if (user === cfg.admin_user && pass === cfg.admin_pass) {
    res.json({ success: true, token: Buffer.from(`${user}:${pass}`).toString('base64') });
  } else {
    res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  }
});

// Satışçı ekle/güncelle
app.post('/admin/sales-user', adminAuth, (req, res) => {
  const { id, name, username, password, bitrix_id } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Ad, kullanıcı adı ve şifre zorunlu' });
  const cfg = getConfig();
  if (!cfg.sales_users) cfg.sales_users = [];
  const userId = id || Date.now().toString();
  const idx = cfg.sales_users.findIndex(u => u.id === userId);
  const user = { id: userId, name, username, password, bitrix_id: bitrix_id || '' };
  if (idx >= 0) cfg.sales_users[idx] = user;
  else cfg.sales_users.push(user);
  saveConfig(cfg);
  res.json({ success: true, id: userId });
});

// Satışçı sil
app.delete('/admin/sales-user/:id', adminAuth, (req, res) => {
  const cfg = getConfig();
  cfg.sales_users = (cfg.sales_users || []).filter(u => u.id !== req.params.id);
  saveConfig(cfg);
  res.json({ success: true });
});

// Bitrix24 kullanıcı listesi (admin için)
app.get('/admin/bitrix-users', adminAuth, async (req, res) => {
  try {
    const cfg = getConfig();
    const BITRIX = cfg.bitrix_url.replace(/\/$/, '');
    if (!BITRIX) return res.json({ users: [] });
    const r = await fetch(`${BITRIX}/user.get.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { ACTIVE: true }, select: ['ID', 'NAME', 'LAST_NAME'] })
    });
    const data = await r.json();
    res.json({ users: (data.result || []).map(u => ({
      id: u.ID,
      name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ')
    }))});
  } catch(e) {
    res.json({ users: [] });
  }
});

// Kullanıcı girişi
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const cfg = getConfig();
  const user = (cfg.sales_users || []).find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  const token = Buffer.from(`${user.id}:${user.password}`).toString('base64');
  res.json({ success: true, token, name: user.name, bitrix_id: user.bitrix_id });
});

// Token doğrula
function getUserByToken(token) {
  try {
    const [userId, password] = Buffer.from(token, 'base64').toString().split(':');
    const cfg = getConfig();
    return (cfg.sales_users || []).find(u => u.id === userId && u.password === password) || null;
  } catch(e) { return null; }
}

// OCR
app.post('/api/scan', upload.single('image'), async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token || !getUserByToken(token)) return res.status(401).json({ error: 'Giriş yapmanız gerekiyor' });

  try {
    const cfg = getConfig();
    const visionKey = cfg.google_vision_key || process.env.GOOGLE_VISION_KEY;
    if (!visionKey) return res.status(400).json({ error: 'Google Vision API key tanımlı değil.' });

    const base64 = req.file.buffer.toString('base64');
    const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: base64 }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }]
      })
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const text = data.responses?.[0]?.fullTextAnnotation?.text || '';
    if (!text) return res.status(400).json({ error: 'Kartta metin bulunamadı' });

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
    const phoneMatch = text.match(/(\+?[\d\s\-().]{7,20})/);
    const websiteMatch = text.match(/(www\.[^\s]+|[a-z0-9-]+\.(com\.tr|com|net|org|tr|io|app|grup|group)[^\s/]*)/i);
    const addressKeywords = /sokak|cadde|bulvar|mah\.|no:|ankara|istanbul|izmir|bursa|cad\.|sok\./i;
    const addressLines = lines.filter(l => addressKeywords.test(l));
    const usedLines = new Set();
    const nameLine = lines.find(l => /^[A-ZÇĞİÖŞÜ][a-zA-ZçğışöüÇĞİÖŞÜ\s]+$/.test(l) && l.split(' ').length >= 2 && l.length > 4 && !addressKeywords.test(l));
    if (nameLine) usedLines.add(nameLine);
    const titleLine = lines.find(l => !usedLines.has(l) && l.length > 3 && !emailMatch?.[0]?.includes(l) && !/^\+?[\d\s\-()]+$/.test(l) && !addressKeywords.test(l));
    if (titleLine) usedLines.add(titleLine);
    const companyLine = lines.find(l => !usedLines.has(l) && l.length > 2 && !emailMatch?.[0]?.includes(l) && !addressKeywords.test(l) && !/^\+?[\d\s\-()]+$/.test(l));

    res.json({ name: nameLine || lines[0] || '', title: titleLine || '', company: companyLine || '', phone: phoneMatch?.[0]?.trim() || '', email: emailMatch?.[0] || '', website: websiteMatch?.[0] || '', address: addressLines.join(', ') || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deal
app.post('/api/deal', async (req, res) => {
  const token = req.headers['x-auth-token'];
  const user = token ? getUserByToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Giriş yapmanız gerekiyor' });

  try {
    const cfg = getConfig();
    const { name, title, company, phone, email, website, address, dealTitle, customerType, source, note } = req.body;
    const BITRIX = cfg.bitrix_url.replace(/\/$/, '');
    if (!BITRIX) return res.status(400).json({ error: 'Bitrix24 Webhook URL tanımlı değil.' });
    const domain = BITRIX.split('/rest/')[0];
    const [dealTypeId, contactTypeId] = (customerType || '').split('|');
    const assignedBy = user.bitrix_id || '';

    async function bx(method, fields) {
      const r = await fetch(`${BITRIX}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      return r.json();
    }

    let companyId = null;
    if (company) {
      const compRes = await bx('crm.company.add', {
        TITLE: company, COMPANY_TYPE: 'CUSTOMER',
        ...(website && { WEB: [{ VALUE: website, VALUE_TYPE: 'WORK' }] }),
        ...(address && { ADDRESS: address }),
        ...(source && { SOURCE_ID: source }),
        ...(assignedBy && { ASSIGNED_BY_ID: assignedBy })
      });
      if (compRes.result) companyId = compRes.result;
    }

    let contactId = null;
    const nameParts = (name || '').trim().split(' ');
    const contRes = await bx('crm.contact.add', {
      NAME: nameParts[0] || '', LAST_NAME: nameParts.slice(1).join(' ') || '',
      POST: title || '',
      ...(contactTypeId && { UF_CRM_6836B469670FA: contactTypeId }),
      ...(phone && { PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] }),
      ...(email && { EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }] }),
      ...(website && { WEB: [{ VALUE: website, VALUE_TYPE: 'WORK' }] }),
      ...(address && { ADDRESS: address }),
      ...(source && { SOURCE_ID: source }),
      ...(assignedBy && { ASSIGNED_BY_ID: assignedBy }),
      ...(companyId && { COMPANY_ID: companyId })
    });
    if (contRes.result) contactId = contRes.result;

    const dealRes = await bx('crm.deal.add', {
      TITLE: dealTitle || [name, company].filter(Boolean).join(' - ') || 'Yeni Deal',
      STAGE_ID: 'C1:NEW',
      COMMENTS: [title, address, website].filter(Boolean).join(' | '),
      ...(source && { SOURCE_ID: source }),
      ...(dealTypeId && { UF_CRM_682498877DEB3: dealTypeId }),
      ...(assignedBy && { ASSIGNED_BY_ID: assignedBy }),
      ...(contactId && { CONTACT_ID: contactId }),
      ...(companyId && { COMPANY_ID: companyId })
    });

    if (dealRes.result && note) {
      await bx('crm.timeline.comment.add', { ENTITY_TYPE: 'deal', ENTITY_ID: dealRes.result, COMMENT: note });
    }

    if (dealRes.result) {
      res.json({ success: true, dealId: dealRes.result, url: `${domain}/crm/deal/details/${dealRes.result}/` });
    } else {
      res.status(500).json({ error: dealRes.error_description || JSON.stringify(dealRes) });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Çalışıyor!'));

// Şifre değiştir
app.post('/api/change-password', (req, res) => {
  const token = req.headers['x-auth-token'];
  const user = token ? getUserByToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Giriş yapmanız gerekiyor' });

  const { oldPassword, newPassword } = req.body;
  if (user.password !== oldPassword) return res.status(401).json({ error: 'Mevcut şifre hatalı' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Yeni şifre en az 4 karakter olmalı' });

  const cfg = getConfig();
  const idx = cfg.sales_users.findIndex(u => u.id === user.id);
  cfg.sales_users[idx].password = newPassword;
  saveConfig(cfg);

  const newToken = Buffer.from(`${user.id}:${newPassword}`).toString('base64');
  res.json({ success: true, token: newToken });
});
