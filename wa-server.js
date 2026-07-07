
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
  const { version } = await fetchLatestBaileysVersion()
  console.log(`[${sessionId.slice(0,8)}] Starting session with WA version ${version.join('.')}`)

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'warn' }),
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    qrTimeout: 40000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 2000,
    markOnlineOnConnect: false,
  })
  session.socket = sock

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(`[${sessionId.slice(0,8)}] QR generated!`)
      session.qrBase64 = await QRCode.toDataURL(qr)
      session.status = 'qr'
    }
    if (connection === 'open') {
      console.log(`[${sessionId.slice(0,8)}] Connected!`)
      session.status = 'connected'
      session.qrBase64 = null
      session.retries = 0
    }
    if (connection === 'close') {
      const err = lastDisconnect?.error
      const code = err?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      console.log(`[${sessionId.slice(0,8)}] Closed | code: ${code} | loggedOut: ${loggedOut} | msg: ${err?.message || ''}`)
      session.status = loggedOut ? 'disconnected' : 'connecting'
      session.socket = null
      if (!loggedOut && session.retries < 10) {
        const delay = Math.min(3000 * (session.retries + 1), 30000)
        session.retries++
        console.log(`[${sessionId.slice(0,8)}] Retry #${session.retries} in ${delay}ms`)
        setTimeout(() => startSession(sessionId, session), delay)
      }
    }
  })
}

function formatPhone(phone) {
  let p = (phone || '').replace(/\D/g, '')
  if (p.startsWith('0')) p = p.slice(1)
  if (!p.startsWith('54')) p = '54' + p
  return p + '@s.whatsapp.net'
}

app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }))

app.get('/qr', async (req, res) => {
  const sessionId = req.query.session
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const session = await getOrCreateSession(sessionId)
  if (session.status === 'connected') return res.json({ status: 'connected' })
  if (session.qrBase64) return res.json({ status: 'qr', qr: session.qrBase64 })
  res.json({ status: session.status })
})

app.get('/status', async (req, res) => {
  const sessionId = req.query.session
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const s = sessions.get(sessionId)
  res.json({ status: s ? s.status : 'disconnected' })
})

app.post('/send-message', async (req, res) => {
  const { session: sessionId, phone, message } = req.body
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const s = sessions.get(sessionId)
  if (!s || s.status !== 'connected') return res.status(503).json({ error: 'WhatsApp no conectado' })
  try {
    await s.socket.sendMessage(formatPhone(phone), { text: message })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/send-campaign', async (req, res) => {
  const { session: sessionId, recipients, message } = req.body
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const s = sessions.get(sessionId)
  if (!s || s.status !== 'connected') return res.status(503).json({ error: 'WhatsApp no conectado' })
  const results = []
  for (const r of recipients) {
    try {
      await s.socket.sendMessage(formatPhone(r.phone), { text: message.replace('{nombre}', r.nombre || '') })
      results.push({ phone: r.phone, ok: true })
    } catch (e) { results.push({ phone: r.phone, ok: false, error: e.message }) }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  res.json({ results })
})

app.post('/logout', async (req, res) => {
  const sessionId = req.query.session || req.body?.session
  if (!sessionId) return res.status(400).json({ error: 'session requerida' })
  const s = sessions.get(sessionId)
  if (s?.socket) { try { await s.socket.logout() } catch(e) {} }
  sessions.delete(sessionId)
  fs.rmSync(path.join('wa_auth', sessionId), { recursive: true, force: true })
  res.json({ ok: true })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('FidelizApp WA Server on port', PORT))
