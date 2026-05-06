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
    openai_key: process.env.OPENAI_API_KEY || '',
    bitrix_url: process.env.BITRIX_WEBHOOK_URL || '',
    admin_user: process.env.ADMIN_USER || 'admin',
    admin_pass: process.env.ADMIN_PASS || 'admin123'
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

app.get('/admin/config', adminAuth, (req, res) => {
  const cfg = getConfig();
  res.json({ openai_key: cfg.openai_key ? '***' + cfg.openai_key.slice(-6) : '', bitrix_url: cfg.bitrix_url || '', admin_user: cfg.admin_user });
});
app.post('/admin/config', adminAuth, (req, res) => {
  const cfg = getConfig();
  const { openai_key, bitrix_url, admin_user, new_pass } = req.body;
  if (openai_key && !openai_key.startsWith('***')) cfg.openai_key = openai_key;
  if (bitrix_url !== undefined) cfg.bitrix_url = bitrix_url;
  if (admin_user) cfg.admin_user = admin_user;
  if (new_pass) cfg.admin_pass = new_pass;
  saveConfig(cfg);
  res.json({ success: true });
});
app.delete('/admin/config/:key', adminAuth, (req, res) => {
  const cfg = getConfig();
  if (req.params.key === 'openai_key') cfg.openai_key = '';
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

// Kaynak listesini Bitrix24'ten çek
app.get('/api/sources', async (req, res) => {
  try {
    const cfg = getConfig();
    const BITRIX = cfg.bitrix_url.replace(/\/$/, '');
    if (!BITRIX) return res.json({ sources: [] });
    const r = await fetch(`${BITRIX}/crm.status.list.json?FILTER[ENTITY_ID]=SOURCE`, {
      method: 'GET'
    });
    const data = await r.json();
    if (data.result) {
      res.json({ sources: data.result });
    } else {
      res.json({ sources: [] });
    }
  } catch(e) {
    res.json({ sources: [] });
  }
});

// OCR
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
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: 'Bu vizit kartındaki tüm bilgileri JSON olarak çıkar. SADECE JSON döndür, başka hiçbir şey yazma. Format: {"name":"","title":"","company":"","phone":"","email":"","website":"","address":""}' }
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

// Deal + Contact + Company
app.post('/api/deal', async (req, res) => {
  try {
    const cfg = getConfig();
    const { name, title, company, phone, email, website, address, dealTitle, customerType, source } = req.body;
    const BITRIX = cfg.bitrix_url.replace(/\/$/, '');
    if (!BITRIX) return res.status(400).json({ error: 'Bitrix24 Webhook URL admin panelinde tanımlı değil.' });
    const domain = BITRIX.split('/rest/')[0];

    async function bx(method, fields) {
      const r = await fetch(`${BITRIX}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      return r.json();
    }

    // 1. Company
    let companyId = null;
    if (company) {
      const compFields = {
        TITLE: company,
        COMPANY_TYPE: 'CUSTOMER',
        ...(website && { WEB: [{ VALUE: website, VALUE_TYPE: 'WORK' }] }),
        ...(customerType && { UfCrm68344cf6d8fa1: customerType }),
        ...(address && { ADDRESS: address }),
        ...(source && { SOURCE_ID: source })
      };
      const compRes = await bx('crm.company.add', compFields);
      if (compRes.result) companyId = compRes.result;
    }

    // 2. Contact
    let contactId = null;
    const nameParts = (name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    const contFields = {
      NAME: firstName,
      LAST_NAME: lastName,
      POST: title || '',
      ...(phone && { PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] }),
      ...(email && { EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }] }),
      ...(website && { WEB: [{ VALUE: website, VALUE_TYPE: 'WORK' }] }),
        ...(customerType && { UfCrm68344cf6d8fa1: customerType }),
      ...(address && { ADDRESS: address }),
      ...(source && { SOURCE_ID: source }),
      ...(customerType && { UfCrm6836b469670fa: customerType }),
      ...(companyId && { COMPANY_ID: companyId })
    };
    const contRes = await bx('crm.contact.add', contFields);
    if (contRes.result) contactId = contRes.result;

    // 3. Deal - Yeni Müşteri Adayı + custom müşteri türü alanı
    const dealFields = {
      TITLE: dealTitle || [name, company].filter(Boolean).join(' - ') || 'Yeni Deal',
      STAGE_ID: 'C1:NEW',
      COMMENTS: [title, address, website].filter(Boolean).join(' | '),
      ...(source && { SOURCE_ID: source }),
      ...(customerType && { UfCrm682498877deb3: customerType }),
      ...(contactId && { CONTACT_ID: contactId }),
      ...(customerType && { UfCrm6836b469670fa: customerType }),
      ...(companyId && { COMPANY_ID: companyId })
    };
    const dealRes = await bx('crm.deal.add', dealFields);

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
