const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static('public'));

// Config dosyası (Railway'de environment variable, yoksa dosyadan)
const CONFIG_FILE = './config.json';

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch(e) {}
  return {
    openai_key: process.env.OPENAI_API_KEY || '',
    bitrix_url: process.env.BITRIX_WEBHOOK_URL || '',
    admin_user: process.env.ADMIN_USER || 'admin',
    admin_pass: process.env.ADMIN_PASS || 'admin123'
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Admin auth middleware
function adminAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) return res.status(401).json({ error: 'Yetkisiz' });
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  const cfg = getConfig();
  if (user === cfg.admin_user && pass === cfg.admin_pass) return next();
  res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
}

// Admin: config getir
app.get('/admin/config', adminAuth, (req, res) => {
  const cfg = getConfig();
  res.json({
    openai_key: cfg.openai_key ? '***' + cfg.openai_key.slice(-6) : '',
    bitrix_url: cfg.bitrix_url || '',
    admin_user: cfg.admin_user
  });
});

// Admin: config kaydet
app.post('/admin/config', adminAuth, (req, res) => {
  const cfg = getConfig();
  const { openai_key, bitrix_url, admin_user, admin_pass, new_pass } = req.body;
  if (openai_key && !openai_key.startsWith('***')) cfg.openai_key = openai_key;
  if (bitrix_url !== undefined) cfg.bitrix_url = bitrix_url;
  if (admin_user) cfg.admin_user = admin_user;
  if (new_pass) cfg.admin_pass = new_pass;
  saveConfig(cfg);
  res.json({ success: true });
});

// Admin: config sil
app.delete('/admin/config/:key', adminAuth, (req, res) => {
  const cfg = getConfig();
  if (req.params.key === 'openai_key') cfg.openai_key = '';
  if (req.params.key === 'bitrix_url') cfg.bitrix_url = '';
  saveConfig(cfg);
  res.json({ success: true });
});

// Admin login check
app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body;
  const cfg = getConfig();
  if (user === cfg.admin_user && pass === cfg.admin_pass) {
    res.json({ success: true, token: Buffer.from(`${user}:${pass}`).toString('base64') });
  } else {
    res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  }
});

// OCR - tarayıcıdan JPEG geliyor
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    const cfg = getConfig();
    const key = cfg.openai_key || process.env.OPENAI_API_KEY;
    if (!key) return res.status(400).json({ error: 'OpenAI API key tanımlı değil. Admin panelinden ekleyin.' });

    const base64 = req.file.buffer.toString('base64');

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: 'Bu vizit kartındaki bilgileri JSON olarak çıkar. SADECE JSON döndür, başka hiçbir şey yazma. Format: {"name":"","title":"","company":"","phone":"","email":"","website":""}' }
          ]
        }]
      })
    });

    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const raw = data.choices[0].message.content.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bitrix24 Deal
app.post('/api/deal', async (req, res) => {
  try {
    const cfg = getConfig();
    const { name, title, company, phone, email, website, dealTitle, bitrixUrl } = req.body;
    const BITRIX_URL = (bitrixUrl || cfg.bitrix_url || '').replace(/\/$/, '');
    if (!BITRIX_URL) return res.status(400).json({ error: 'Bitrix24 Webhook URL girilmedi' });

    const fields = {
      TITLE: dealTitle || [name, company].filter(Boolean).join(' - ') || 'Yeni Deal',
      STAGE_ID: 'NEW',
      COMMENTS: [title, website].filter(Boolean).join(' | '),
      ...(phone && { PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] }),
      ...(email && { EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }] })
    };

    const domain = BITRIX_URL.split('/rest/')[0];
    const r = await fetch(`${BITRIX_URL}/crm.deal.add.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });

    const data = await r.json();
    if (data.result) {
      res.json({ success: true, dealId: data.result, url: `${domain}/crm/deal/details/${data.result}/` });
    } else {
      res.status(500).json({ error: data.error_description || JSON.stringify(data) });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Çalışıyor!'));
