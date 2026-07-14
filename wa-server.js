const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const express = require('express')
const cors = require('cors')
const QRCode = require('qrcode')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())

const sessions = new Map()
const AUTH_DIR = 'wa_auth'

// ── Auto-reconectar sesiones existentes al arrancar ───────────────────────────
async function loadExistingSessions() {
  if (!fs.existsSync(AUTH_DIR)) return
  const dirs = fs.readdirSync(AUTH_DIR).filter(d =>
    fs.statSync(path.join(AUTH_DIR, d)).isDirectory()
  )
  for (const sessionId of dirs) {
    console.log(`[boot] Reconectando sesión guardada: ${sessionId.slice(0,8)}...`)
    const session = { socket: null, status: 'connecting', qrBase64: null, retries: 0 }
    sessions.set(sessionId, session)
    startSession(sessionId, session).catch(e =>
      console.error(`[boot] Error reconectando ${sessionId.slice(0,8)}:`, e.message)
    )
  }
}

async function getOrCreateSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId)
  const session = { socket: null, status: 'connecting', qrBase64: null, retries: 0 }
  sessions.set(sessionId, session)
  startSession(sessionId, session).catch(e =>
    console.error(`[${sessionId.slice(0,8)}] startSession error:`, e.message)
  )
  return session
}

async function startSession(sessionId, session) {
  const authDir = path.join(AUTH_DIR, sessionId)
  fs.mkdirSync(authDir, { recursive: true })

  let state, saveCreds
  try {
    const auth = await useMultiFileAuthState(authDir)
    state = auth.state
    saveCreds = auth.saveCreds
  } catch (e) {
    console.error(`[${sessionId.slice(0,8)}] Error cargando auth:`, e.message)
    session.status = 'error'
    return
  }

  let version
  try {
    const v = await fetchLatestBaileysVersion()
    version = v.version
  } catch (e) {
    version = [2, 3000, 1023333755]
  }
  console.log(`[${sessionId.slice(0,8)}] Iniciando con WA v${version.join('.')}`)

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 90000,
    qrTimeout: 120000,        // 2 minutos para escanear el QR
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    retryRequestDelayMs: 3000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })
  session.socket = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`[${sessionId.slice(0,8)}] ✅ QR generado`)
      try {
        session.qrBase64 = await QRCode.toDataURL(qr)
        session.qrTimestamp = Date.now()
        session.status = 'qr'
      } catch (e) {
        console.error(`[${sessionId.slice(0,8)}] Error generando QR:`, e.message)
      }
    }

    if (connection === 'open') {
      console.log(`[${sessionId.slice(0,8)}] ✅ Conectado a WhatsApp`)
      session.status = 'connected'
      session.qrBase64 = null
      session.retries = 0
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error
      const code = err?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      const reason = err?.message || `código ${code}`
      console.log(`[${sessionId.slice(0,8)}] Desconectado | ${reason} | logout: ${loggedOut}`)

      session.socket = null

      if (loggedOut) {
        // Borrar auth y marcar como desconectado
        session.status = 'disconnected'
        try { fs.rmSync(authDir, { recursive: true, force: true }) } catch(e) {}
        sessions.delete(sessionId)
        console.log(`[${sessionId.slice(0,8)}] Sesión cerrada por logout`)
        return
      }

      // Reconectar con backoff exponencial (max 60s)
      if (session.retries < 20) {
        session.status = 'connecting'
        const delay = Math.min(5000 * Math.pow(1.5, session.retries), 60000)
        session.retries++
        console.log(`[${sessionId.slice(0,8)}] Reintento #${session.retries} en ${Math.round(delay/1000)}s`)
        setTimeout(() => startSession(sessionId, session), delay)
      } else {
        session.status = 'error'
        console.log(`[${sessionId.slice(0,8)}] Máximo de reintentos alcanzado`)
      }
    }
  })
}

function formatPhone(phone) {
  let p = (phone || '').replace(/\D/g, '')
  if (p.startsWith('0')) p = p.slice(1)
  if (!p.startsWith('54')) p = '54' + p
  if (p.length === 12 && p.startsWith('549')) return p + '@s.whatsapp.net'
  // Argentina: agregar 9 si falta (549XXXXXXXXXX)
  if (p.startsWith('54') && p.length === 12) return p + '@s.whatsapp.net'
  if (p.startsWith('54') && p.length === 11) return '549' + p.slice(2) + '@s.whatsapp.net'
  return p + '@s.whatsapp.net'
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const info = {}
  sessions.forEach((s, id) => { info[id.slice(0,8)] = s.status })
  res.json({ ok: true, sessions: sessions.size, status: info, uptime: Math.round(process.uptime()) })
})

app.get('/qr', async (req, res) => {
  const sessionId = req.query.session
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const session = await getOrCreateSession(sessionId)

  if (session.status === 'connected') return res.json({ status: 'connected' })

  // Si el QR tiene menos de 90 segundos, devolverlo aunque ya no sea el último
  if (session.qrBase64) {
    const age = Date.now() - (session.qrTimestamp || 0)
    if (age < 90000) return res.json({ status: 'qr', qr: session.qrBase64 })
  }

  res.json({ status: session.status })
})

app.get('/status', async (req, res) => {
  const sessionId = req.query.session
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const s = sessions.get(sessionId)
  res.json({
    status: s ? s.status : 'disconnected',
    retries: s ? s.retries : 0,
    hasQR: !!(s && s.qrBase64),
  })
})

app.post('/send-message', async (req, res) => {
  const { session: sessionId, phone, message } = req.body
  if (!sessionId || !phone || !message)
    return res.status(400).json({ error: 'Faltan campos: session, phone, message' })
  const s = sessions.get(sessionId)
  if (!s || s.status !== 'connected')
    return res.status(503).json({ error: 'WhatsApp no conectado. Escaneá el QR primero.' })
  try {
    const jid = formatPhone(phone)
    await s.socket.sendMessage(jid, { text: message })
    console.log(`[${sessionId.slice(0,8)}] Mensaje enviado a ${phone}`)
    res.json({ ok: true, success: true })
  } catch (e) {
    console.error(`[${sessionId.slice(0,8)}] Error enviando:`, e.message)
    res.status(500).json({ error: e.message, success: false })
  }
})

app.post('/send-campaign', async (req, res) => {
  const { session: sessionId, recipients, message } = req.body
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const s = sessions.get(sessionId)
  if (!s || s.status !== 'connected')
    return res.status(503).json({ error: 'WhatsApp no conectado' })
  const results = []
  for (const r of (recipients || [])) {
    try {
      const msg = message.replace(/\{nombre\}/g, r.nombre || r.name || '')
      await s.socket.sendMessage(formatPhone(r.phone), { text: msg })
      results.push({ phone: r.phone, ok: true })
    } catch (e) {
      results.push({ phone: r.phone, ok: false, error: e.message })
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  res.json({ results, sent: results.filter(r => r.ok).length, total: results.length })
})

app.post('/logout', async (req, res) => {
  const sessionId = req.query.session || req.body?.session
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const s = sessions.get(sessionId)
  if (s?.socket) { try { await s.socket.logout() } catch(e) {} }
  sessions.delete(sessionId)
  try { fs.rmSync(path.join(AUTH_DIR, sessionId), { recursive: true, force: true }) } catch(e) {}
  res.json({ ok: true })
})

// ── Auto keep-alive: ping propio cada 4 min para no dormir en Render free ─────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || ''
if (SELF_URL) {
  setInterval(() => {
    const https = require('https')
    const http = require('http')
    const lib = SELF_URL.startsWith('https') ? https : http
    lib.get(SELF_URL + '/health', () => {}).on('error', () => {})
    console.log('[keep-alive] ping →', SELF_URL + '/health')
  }, 4 * 60 * 1000)
}

const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log('FidelizApp WA Server on port', PORT)
  await loadExistingSessions()
})
