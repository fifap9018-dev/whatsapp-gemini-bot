// WhatsApp bot + Arabic control panel — Gemini edition
// IMPORTANT: whatsapp-web.js is an unofficial WhatsApp Web automation library.
// Use a test number; automation may violate WhatsApp terms and can lead to restrictions.
// Requires Node.js 20+.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QR = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY. Add it as a private environment variable.');
  process.exit(1);
}

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PANEL_PASS = process.env.PANEL_PASS || '';
const ALLOWED = (process.env.ALLOWED || '').split(',').map(s => s.trim()).filter(Boolean);
const PAUSE_MS = (Number(process.env.PAUSE_MIN) || 30) * 60 * 1000;

let persona = fs.existsSync('persona.txt')
  ? fs.readFileSync('persona.txt', 'utf8')
  : 'أنت مساعد ودود تتكلم بالعربية وبالدارجة المغربية البسيطة. أجب باختصار وبشكل طبيعي مثل محادثة واتساب، ولا تدّع أنك إنسان حقيقي.';

const chats = fs.existsSync('chats.json')
  ? JSON.parse(fs.readFileSync('chats.json', 'utf8'))
  : {};
const history = {};
const pausedUntil = {};
const lastBotSend = {};
const timers = {};
let enabled = true, ready = false, qrImage = null;

function saveChats() {
  fs.writeFileSync('chats.json', JSON.stringify(chats, null, 2));
}
function log(id, name, role, message) {
  const c = (chats[id] ||= { name: id.split('@')[0], msgs: [] });
  if (name) c.name = name;
  c.msgs.push({ role, text: message, t: Date.now() });
  if (c.msgs.length > 200) c.msgs.shift();
  saveChats();
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'main' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', async qr => {
  ready = false;
  qrImage = await QR.toDataURL(qr, { margin: 1, width: 300 });
  qrcodeTerminal.generate(qr, { small: true });
  console.log('Open your hosted panel to scan the QR code.');
});
client.on('ready', () => {
  ready = true;
  qrImage = null;
  console.log('WhatsApp connected.');
});
client.on('disconnected', () => {
  ready = false;
  console.log('WhatsApp disconnected.');
});

async function askGemini(chatId) {
  const msgs = (history[chatId] || []).slice(-16);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();

  const contents = msgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: persona }] },
        contents,
        generationConfig: { maxOutputTokens: 400, temperature: 0.8 }
      })
    }
  );

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `Gemini API error (${response.status})`;
    throw new Error(message);
  }
  return (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join('').trim();
}

async function reply(chatId) {
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();
    const answer = await askGemini(chatId);
    if (!answer) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(1200 + answer.length * 25, 5000)));
    if (Date.now() < (pausedUntil[chatId] || 0)) return;
    history[chatId].push({ role: 'assistant', content: answer });
    lastBotSend[chatId] = Date.now();
    await client.sendMessage(chatId, answer);
    log(chatId, null, 'assistant', answer);
    await chat.clearState();
  } catch (err) {
    console.error('Reply error:', err.message);
  }
}

client.on('message', async msg => {
  if (!enabled || msg.fromMe || msg.isStatus) return;
  const id = msg.from;
  if (!id.endsWith('@c.us') || msg.type !== 'chat' || !msg.body) return;
  if (ALLOWED.length && !ALLOWED.some(n => id.startsWith(n))) return;

  log(id, msg._data?.notifyName, 'user', msg.body);
  if (Date.now() < (pausedUntil[id] || 0)) return;
  (history[id] ||= []).push({ role: 'user', content: msg.body });
  clearTimeout(timers[id]);
  timers[id] = setTimeout(() => reply(id), 2500);
});

client.on('message_create', async msg => {
  if (!msg.fromMe) return;
  const selfId = client.info?.wid?._serialized;
  if (msg.to === selfId) {
    const cmd = (msg.body || '').trim().toLowerCase();
    if (cmd === '!stop') {
      enabled = false;
      await client.sendMessage(selfId, '⏸️ تم إيقاف البوت');
    } else if (cmd === '!start') {
      enabled = true;
      await client.sendMessage(selfId, '▶️ البوت يعمل');
    }
    return;
  }
  if (Date.now() - (lastBotSend[msg.to] || 0) > 8000) {
    pausedUntil[msg.to] = Date.now() + PAUSE_MS;
    clearTimeout(timers[msg.to]);
    if (msg.body) log(msg.to, null, 'me', msg.body);
  }
});

// Control panel API
const json = (res, obj, code = 200) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
};

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/' || url === '/panel') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    return res.end(fs.readFileSync(path.join(__dirname, 'panel.html')));
  }

  if (PANEL_PASS && req.headers['x-pass'] !== PANEL_PASS) {
    return json(res, { error: 'auth' }, 401);
  }

  if (url === '/api/state' && req.method === 'GET')
    return json(res, { ready, qr: qrImage, enabled, chats });

  if (url === '/api/persona' && req.method === 'GET')
    return json(res, { persona });

  if (url === '/api/persona' && req.method === 'POST') {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 20000) req.destroy();
    });
    return req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}');
        persona = String(body.persona || persona).slice(0, 10000);
        fs.writeFileSync('persona.txt', persona);
        json(res, { ok: true });
      } catch {
        json(res, { error: 'bad request' }, 400);
      }
    });
  }

  if (url === '/api/toggle' && req.method === 'POST') {
    enabled = !enabled;
    return json(res, { enabled });
  }

  return json(res, { error: 'not found' }, 404);
}).listen(PORT, HOST, () => console.log(`Panel listening on ${HOST}:${PORT}`));

client.initialize();
