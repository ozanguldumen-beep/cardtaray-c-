const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const sharp = require('sharp');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static('public'));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_BITRIX = process.env.BITRIX_WEBHOOK_URL || '';

// Kart OCR
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    // HEIC/HEIF dahil tüm formatları JPEG'e çevir
    const jpegBuffer = await sharp(req.file.buffer).jpeg({ quality: 90 }).toBuffer();
    const base64 = jpegBuffer.toString('base64');

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
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

// Bitrix24 Deal oluştur
app.post('/api/deal', async (req, res) => {
  try {
    const { name, title, company, phone, email, website, dealTitle, bitrixUrl } = req.body;

    const BITRIX_URL = (bitrixUrl || DEFAULT_BITRIX).replace(/\/$/, '');
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
