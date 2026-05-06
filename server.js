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
  res.json({
    google_vision_key: cfg.google_vision_key ? '***' + cfg.google_vision_key.slice(-6) : '',
    bitrix_url: cfg.bitrix_url || '',
    admin_user: cfg.admin_user
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

// OCR - Google Vision
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    const cfg = getConfig();
    const visionKey = cfg.google_vision_key || process.env.GOOGLE_VISION_KEY;
    if (!visionKey) return res.status(400).json({ error: 'Google Vision API key tanımlı değil. Admin panelinden ekleyin.' });

    const base64 = req.file.buffer.toString('base64');

    const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
        }]
      })
    });

    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = data.responses?.[0]?.fullTextAnnotation?.text || '';
    if (!text) return res.status(400).json({ error: 'Kartta metin bulunamadı' });

    // Metinden bilgileri çıkar
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
    const phoneMatch = text.match(/(\+?[\d\s\-().]{7,20})/);
    const websiteMatch = text.match(/(www\.[^\s]+|[a-z0-9-]+\.(com\.tr|com|net|org|tr|io|app|grup|group)[^\s/]*)/i);
    const addressKeywords = /sokak|cadde|bulvar|mah\.|apt\.|no:|kat\s|ankara|istanbul|izmir|bursa|cad\.|sok\.|blok/i;

    const addressLines = lines.filter(l => addressKeywords.test(l));
    const usedLines = new Set();

    // İsim: büyük harfli, en az 2 kelime, rakam yok
    const nameLine = lines.find(l =>
      /^[A-ZÇĞİÖŞÜ][a-zA-ZçğışöüÇĞİÖŞÜ\s]+$/.test(l) &&
      l.split(' ').length >= 2 &&
      l.length > 4
    );
    if (nameLine) usedLines.add(nameLine);

    // Ünvan: ikinci anlamlı satır
    const titleLine = lines.find(l => l !== nameLine && !emailMatch?.[0]?.includes(l) && !phoneMatch?.[0]?.includes(l) && l.length > 3 && !usedLines.has(l) && !/^www|http/i.test(l));
    if (titleLine) usedLines.add(titleLine);

    // Firma: başka bir satır
    const companyLine = lines.find(l => !usedLines.has(l) && l.length > 2 && !emailMatch?.[0]?.includes(l) && !addressKeywords.test(l) && !/^\+?[\d\s\-()]+$/.test(l));

    res.json({
      name: nameLine || lines[0] || '',
      title: titleLine || '',
      company: companyLine || '',
      phone: phoneMatch?.[0]?.trim() || '',
      email: emailMatch?.[0] || '',
      website: websiteMatch?.[0] || '',
      address: addressLines.join(', ') || ''
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deal + Contact + Company
app.post('/api/deal', async (req, res) => {
  try {
    const cfg = getConfig();
    const { name, title, company, phone, email, website, address, dealTitle, customerType, source, assignedBy, note } = req.body;
    const [dealTypeId, contactTypeId] = (customerType || "").split("|");
    const BITRIX = cfg.bitrix_url.replace(/\/$/, '');
    if (!BITRIX) return res.status(400).json({ error: 'Bitrix24 Webhook URL admin panelinde tanımlı değil.' });
    const domain = BITRIX.split('/rest/')[0];

    async function bx(method, fields) {
      const r = await fetch(`${BITRIX}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      const d = await r.json();
      console.log(method, JSON.stringify(d));
      return d;
    }

    // 1. Company
    let companyId = null;
    if (company) {
      const compRes = await bx('crm.company.add', {
        TITLE: company,
        COMPANY_TYPE: 'CUSTOMER',
        ...(website && { WEB: [{ VALUE: website, VALUE_TYPE: 'WORK' }] }),
        ...(address && { ADDRESS: address }),
        ...(source && { SOURCE_ID: source })
      });
      if (compRes.result) companyId = compRes.result;
    }

    // 2. Contact - TYPE_ID müşteri türü
    let contactId = null;
    const nameParts = (name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const contRes = await bx('crm.contact.add', {
      NAME: firstName,
      LAST_NAME: lastName,
      POST: title || '',
      ...(contactTypeId && { UF_CRM_6836B469670FA: contactTypeId }),
      ...(phone && { PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] }),
      ...(email && { EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }] }),
      ...(website && { WEB: [{ VALUE: website, VALUE_TYPE: 'WORK' }] }),
      ...(address && { ADDRESS: address }),
      ...(source && { SOURCE_ID: source }),
      ...(companyId && { COMPANY_ID: companyId })
    });
    if (contRes.result) contactId = contRes.result;

    // 3. Deal
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

    // Not varsa timeline'a ekle
    if (dealRes.result && note) {
      await bx('crm.timeline.comment.add', {
        ENTITY_TYPE: 'deal',
        ENTITY_ID: dealRes.result,
        COMMENT: note
      });
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

// Kullanıcı listesi
app.get('/api/users', async (req, res) => {
  try {
    const cfg = getConfig();
    const BITRIX = cfg.bitrix_url.replace(/\/$/, '');
    if (!BITRIX) return res.json({ users: [] });
    const r = await fetch(`${BITRIX}/user.get.json?FILTER[ACTIVE]=true&select[]=ID&select[]=NAME&select[]=LAST_NAME&select[]=PERSONAL_PHOTO`, {
      method: 'GET'
    });
    const data = await r.json();
    res.json({ users: data.result || [] });
  } catch(e) {
    res.json({ users: [] });
  }
});
