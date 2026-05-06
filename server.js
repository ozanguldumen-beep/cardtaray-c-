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
    openai_key: cfg.openai_key ? '***' + cfg.openai_key.slice(-6) : '',
    google_vision_key: cfg.google_vision_key ? '***' + cfg.google_vision_key.slice(-6) : '',
    bitrix_url: cfg.bitrix_url || '',
    admin_user: cfg.admin_user
  });
});
app.post('/admin/config', adminAuth, (req, res) => {
  const cfg = getConfig();
  const { openai_key, google_vision_key, bitrix_url, admin_user, new_pass } = req.body;
  if (openai_key && !openai_key.startsWith('***')) cfg.openai_key = openai_key;
  if (google_vision_key && !google_vision_key.startsWith('***')) cfg.google_vision_key = google_vision_key;
  if (bitrix_url !== undefined) cfg.bitrix_url = bitrix_url;
  if (admin_user) cfg.admin_user = admin_user;
  if (new_pass) cfg.admin_pass = new_pass;
  saveConfig(cfg);
  res.json({ success: true });
});
app.delete('/admin/config/:key', adminAuth, (req, res) => {
  const cfg = getConfig();
  if (req.params.key === 'openai_key') cfg.openai_key = '';
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

// Google Vision ile OCR yapıp Claude ile parse et
async function ocrWithGoogleVision(base64, visionKey) {
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
  if (data.error) throw new Error(data.error.message);
  const text = data.responses?.[0]?.fullTextAnnotation?.text || '';
  if (!text) throw new Error('Kartta metin bulunamadı');

  // OpenAI ile parse et (varsa) yoksa regex ile
  return text;
}

// Metinden kart bilgilerini çıkar
function parseCardText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phoneMatch = text.match(/(\+?[\d\s\-().]{7,20})/);
  const websiteMatch = text.match(/(www\.[^\s]+|https?:\/\/[^\s]+|[a-z0-9-]+\.(com|net|org|tr|io|app|group|grup)[^\s]*)/i);

  // İsim genellikle ilk satırda büyük harfle
  const nameLine = lines.find(l => /^[A-ZÇĞİÖŞÜa-zçğışöü\s]{3,}$/.test(l) && l.split(' ').length >= 2 && !l.match(/\d/));

  return {
    name: nameLine || lines[0] || '',
    title: lines[1] || '',
    company: lines.find(l => l !== nameLine && l !== lines[1] && !emailMatch?.[0]?.includes(l) && l.length > 3) || '',
    phone: phoneMatch?.[0]?.trim() || '',
    email: emailMatch?.[0] || '',
    website: websiteMatch?.[0] || '',
    address: lines.filter(l => /sokak|cadde|bulvar|mah\.|apt\.|no:|kat|ankara|istanbul|izmir|\d{5}/i.test(l)).join(', ') || ''
  };
}

// OCR endpoint
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    const cfg = getConfig();
    const visionKey = cfg.google_vision_key || process.env.GOOGLE_VISION_KEY;
    const openaiKey = cfg.openai_key || process.env.OPENAI_API_KEY;

    if (!visionKey && !openaiKey) {
      return res.status(400).json({ error: 'API key tanımlı değil. Admin panelinden Google Vision veya OpenAI key ekleyin.' });
    }

    const base64 = req.file.buffer.toString('base64');

    // Google Vision varsa önce onu kullan
    if (visionKey) {
      try {
        const rawText = await ocrWithGoogleVision(base64, visionKey);

        // OpenAI de varsa metni parse etmesi için gönder
        if (openaiKey) {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
            body: JSON.stringify({
              model: 'gpt-4o',
              max_tokens: 400,
              messages: [{
                role: 'user',
                content: `Aşağıdaki vizit kartı metninden bilgileri JSON olarak çıkar. SADECE JSON döndür:\n\n${rawText}\n\nFormat: {"name":"","title":"","company":"","phone":"","email":"","website":"","address":""}`
              }]
            })
          });
          const data = await r.json();
          if (!data.error) {
            const raw = data.choices[0].message.content.replace(/```json|```/g, '').trim();
            return res.json(JSON.parse(raw));
          }
        }

        // OpenAI yoksa basit parse
        return res.json(parseCardText(rawText));
      } catch(e) {
        // Vision hata verdiyse OpenAI'ye geç
        if (!openaiKey) return res.status(500).json({ error: e.message });
      }
    }

    // OpenAI Vision ile direkt görsel gönder
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: 'Bu vizit kartındaki tüm bilgileri JSON olarak çıkar. SADECE JSON döndür. Format: {"name":"","title":"","company":"","phone":"","email":"","website":"","address":""}' }
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
      const compRes = await bx('crm.company.add', {
        TITLE: company,
        COMPANY_TYPE: 'CUSTOMER',
        ...(website && { WEB: [{ VALUE: website, VALUE_TYPE: 'WORK' }] }),
        ...(address && { ADDRESS: address }),
        ...(source && { SOURCE_ID: source })
      });
      if (compRes.result) companyId = compRes.result;
    }

    // 2. Contact
    let contactId = null;
    const nameParts = (name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const contRes = await bx('crm.contact.add', {
      NAME: firstName,
      LAST_NAME: lastName,
      POST: title || '',
      TYPE_ID: customerType || '',
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
      ...(customerType && { UfCrm682498877deb3: customerType }),
      ...(contactId && { CONTACT_ID: contactId }),
      ...(companyId && { COMPANY_ID: companyId })
    });

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
