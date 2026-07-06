const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const express = require('express')
const cors = require('cors')
const QRCode = require('qrcode')
const pino = require('pino')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())

// Multi-session: each business gets its own WhatsApp session
// Key = negocioId (UUID from Supabase)
const sessions = new Map()

async function getOrCreateSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId)
  const session = { socket: null, status: 'connecting', qrBase64: null, retries: 0 }
  sessions.set(sessionId, session)
  await startSession(sessionId, session)
  return session
}

async function startSession(sessionId, session) {
  const authDir = path.join('wa_auth', sessionId)
  fs.mkdirSync(authDir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(authDir)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  })
  session.socket = sock

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      session.qrBase64 = await QRCode.toDataURL(qr)
      session.status = 'qr'
    }
    if (connection === 'open') {
      session.status = 'connected'
      session.qrBase64 = null
      session.retries = 0
      console.log('Session connected:', sessionId)
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      session.status = loggedOut ? 'disconnected' : 'connecting'
      session.socket = null
      if (!loggedOut && session.retries < 5) {
        session.retries++
        setTimeout(() => startSession(sessionId, session), 3000)
      }
      console.log('Session closed:', sessionId, '| loggedOut:', loggedOut)
    }
  })
}

function getSession(req, res) {
  const sessionId = req.query.session || req.body?.session
  if (!sessionId) { res.status(400).json({ error: 'session requerida' }); return null }
  return sessionId
}

function formatPhone(phone) {
  let p = (phone || '').replace(/\D/g, '')
  if (p.startsWith('0')) p = p.slice(1)
  if (!p.startsWith('54')) p = '54' + p
  return p + '@s.whatsapp.net'
}

// ─── Endpoints ───────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, sessions: sessions.size })
})

app.get('/qr', async (req, res) => {
  const sessionId = getSession(req, res)
  if (!sessionId) return
  const session = await getOrCreateSession(sessionId)
  if (session.status === 'connected') return res.json({ status: 'connected' })
  if (session.qrBase64) return res.json({ status: 'qr', qr: session.qrBase64 })
  res.json({ status: session.status })
})

app.get('/status', async (req, res) => {
  const sessionId = getSession(req, res)
  if (!sessionId) return
  const session = sessions.get(sessionId)
  res.json({ status: session ? session.status : 'disconnected' })
})

app.post('/send-message', async (req, res) => {
  const { session: sessionId, phone, message } = req.body
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const session = sessions.get(sessionId)
  if (!session || session.status !== 'connected') return res.status(503).json({ error: 'WhatsApp no conectado' })
  try {
    await session.socket.sendMessage(formatPhone(phone), { text: message })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/send-campaign', async (req, res) => {
  const { session: sessionId, recipients, message } = req.body
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const session = sessions.get(sessionId)
  if (!session || session.status !== 'connected') return res.status(503).json({ error: 'WhatsApp no conectado' })
  const results = []
  for (const r of recipients) {
    try {
      const msg = message.replace('{nombre}', r.nombre || '')
      await session.socket.sendMessage(formatPhone(r.phone), { text: msg })
      results.push({ phone: r.phone, ok: true })
    } catch (e) {
      results.push({ phone: r.phone, ok: false, error: e.message })
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  res.json({ results })
})

app.post('/logout', async (req, res) => {
  const sessionId = req.query.session || req.body?.session
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const session = sessions.get(sessionId)
  if (session?.socket) {
    try { await session.socket.logout() } catch(e) {}
  }
  sessions.delete(sessionId)
  const authDir = path.join('wa_auth', sessionId)
  fs.rmSync(authDir, { recursive: true, force: true })
  res.json({ ok: true })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('FidelizApp WA Server running on port', PORT))
