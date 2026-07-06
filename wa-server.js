const express = require('express');
const cors    = require('cors');
const qrcode  = require('qrcode');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs   = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Estado global ───────────────────────────────────────────
let sock         = null;
let qrBase64     = null;
let waStatus     = 'disconnected'; // 'disconnected' | 'qr' | 'connected'
let waPhone      = '';
let reconnecting = false;

// ─── Iniciar WhatsApp ─────────────────────────────────────────
async function conectarWA() {
  const authDir = path.join(__dirname, 'wa_auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: false,
    browser: ['FidelizApp', 'Chrome', '120.0.0']
  });

  // QR generado
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waStatus = 'qr';
      qrBase64 = await qrcode.toDataURL(qr);
      console.log('[WA] QR generado — esperando escaneo...');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[WA] Desconectado. Reconectar:', shouldReconnect, '| código:', code);
      waStatus = 'disconnected';
      qrBase64 = null;
      waPhone  = '';
      if (shouldReconnect && !reconnecting) {
        reconnecting = true;
        setTimeout(() => { reconnecting = false; conectarWA(); }, 5000);
      }
    }

    if (connection === 'open') {
      waStatus = 'connected';
      qrBase64 = null;
      waPhone  = sock.user?.id?.split(':')[0] || '';
      console.log('[WA] ✅ Conectado como', waPhone);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ─── Endpoints ────────────────────────────────────────────────

// Estado y QR
app.get('/status', (req, res) => {
  res.json({ status: waStatus, phone: waPhone, hasQR: !!qrBase64 });
});

app.get('/qr', (req, res) => {
  if (!qrBase64) {
    return res.json({ qr: null, status: waStatus });
  }
  res.json({ qr: qrBase64, status: waStatus });
});

// Cerrar sesión (para forzar nuevo QR)
app.post('/logout', async (req, res) => {
  try {
    if (sock) await sock.logout();
    const authDir = path.join(__dirname, 'wa_auth');
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true });
    waStatus = 'disconnected'; qrBase64 = null; waPhone = '';
    setTimeout(() => conectarWA(), 2000);
    res.json({ ok: true, message: 'Sesión cerrada. Nuevo QR en camino...' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Enviar mensaje individual
app.post('/send-message', async (req, res) => {
  const { to, message, nombre } = req.body;
  if (!to || !message) return res.status(400).json({ success: false, error: 'Faltan: to y message' });
  if (waStatus !== 'connected') return res.status(503).json({ success: false, error: 'WhatsApp no conectado' });

  // Formatear número: +549XXXXXXXXXX → 549XXXXXXXXXX@s.whatsapp.net
  let numero = to.replace(/\D/g, '');
  if (numero.startsWith('0')) numero = numero.slice(1);
  const jid = numero + '@s.whatsapp.net';

  const texto = (message || '')
    .replace(/{nombre}/gi, nombre || '')
    .replace(/{name}/gi, nombre || '');

  try {
    await sock.sendMessage(jid, { text: texto });
    console.log('[WA] Mensaje enviado a', to);
    res.json({ success: true, to, jid });
  } catch (e) {
    console.error('[WA] Error enviando a', to, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Campaña masiva
app.post('/send-campaign', async (req, res) => {
  const { recipients, message } = req.body;
  if (!recipients || !Array.isArray(recipients) || !message)
    return res.status(400).json({ success: false, error: 'Faltan: recipients (array) y message' });
  if (waStatus !== 'connected')
    return res.status(503).json({ success: false, error: 'WhatsApp no conectado' });

  const batch   = recipients.slice(0, 100);
  const results = [];

  for (const r of batch) {
    const texto = (message || '')
      .replace(/{nombre}/gi, r.nombre || r.name || '')
      .replace(/{name}/gi, r.nombre || r.name || '');

    let numero = (r.to || '').replace(/\D/g, '');
    if (numero.startsWith('0')) numero = numero.slice(1);
    const jid = numero + '@s.whatsapp.net';

    try {
      await sock.sendMessage(jid, { text: texto });
      results.push({ to: r.to, success: true });
    } catch (e) {
      results.push({ to: r.to, success: false, error: e.message });
    }

    // Rate limiting: 1 mensaje cada 1.5s para evitar bans
    await new Promise(res => setTimeout(res, 1500));
  }

  const enviados = results.filter(r => r.success).length;
  res.json({ success: true, total: batch.length, enviados, fallidos: batch.length - enviados, results });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'FidelizApp WA Server', waStatus, ts: new Date().toISOString() });
});

// ─── Iniciar ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] FidelizApp WA Server corriendo en puerto ${PORT}`);
  conectarWA();
});
