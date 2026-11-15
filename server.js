/* =========================================================
   SISTEMA DE ENTRADA / SALIDA POR QR  —  con acceso oculto
   ========================================================= */
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const QRCode     = require('qrcode');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER     = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SECRET   = process.env.ADMIN_SECRET;

if (!ADMIN_USER || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16 ||
    !ADMIN_SECRET || ADMIN_SECRET.length < 32 ||
    ADMIN_PASSWORD.startsWith('replace-') || ADMIN_SECRET.startsWith('replace-')) {
  throw new Error(
    'Configura ADMIN_USER, ADMIN_PASSWORD (16+ caracteres) y ADMIN_SECRET (32+ caracteres) en .env.'
  );
}

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

/* ---------- Middlewares ---------- */
app.use(express.json({ limit: '5mb' }));

// 🚫 Bloquear archivos internos accesibles desde el navegador
app.use((req, res, next) => {
  const bloqueados = [
    '/server.js', '/package.json', '/package-lock.json',
    '/data', '/db.json', '/node_modules'
  ];
  if (bloqueados.some(b => req.path.startsWith(b))) {
    return res.status(403).send('Forbidden');
  }
  next();
});

// ✅ Servir HTML/CSS/JS desde la MISMA carpeta que server.js
app.use(express.static(__dirname));

/* ================= ALMACENAMIENTO ================= */
function dbPorDefecto() {
  return {
    contadorCarnet: 0,
    personas: [],
    registros: [],
    avisos: [],
    config: {
      modoSensor: false,
      cooldownSegundos: 20,
      emailAdmin: '',
      notificarEntrada: true,
      notificarSalida: true,
      smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' }
    }
  };
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const d = dbPorDefecto();
      fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
      return d;
    }
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.personas  = db.personas  || [];
    db.registros = db.registros || [];
    db.avisos    = db.avisos    || [];
    db.config    = Object.assign(dbPorDefecto().config, db.config || {});
    return db;
  } catch (e) {
    console.error('Error leyendo DB:', e);
    throw new Error('No se pudo leer la base de datos. Revisa data/db.json antes de continuar.');
  }
}

function saveDB(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ================= UTILIDADES ================= */
function fechaLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function horaLocal(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
function csvEscape(v) { return '"' + String(v ?? '').replace(/"/g, '""') + '"'; }

function configParaCliente(config) {
  const smtp = Object.assign({}, config.smtp);
  delete smtp.pass;
  return Object.assign({}, config, { smtp });
}

/* ================= SESIONES ADMIN ================= */
const sesiones = new Map();
const intentosLogin = new Map();
const DURACION_SESION_MS = 8 * 60 * 60 * 1000;
const MAX_INTENTOS_LOGIN = 5;
const BLOQUEO_LOGIN_MS = 15 * 60 * 1000;

/* 🚪 Login con USUARIO + CONTRASEÑA */
app.post('/api/login', (req, res) => {
  const ahora = Date.now();
  const ip = req.ip;
  const intentos = intentosLogin.get(ip);
  if (intentos && intentos.bloqueadoHasta > ahora) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos. Inténtalo más tarde.' });
  }

  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    sesiones.set(token, ahora + DURACION_SESION_MS);
    intentosLogin.delete(ip);
    return res.json({ ok: true, token });
  }
  const fallidos = intentos && intentos.bloqueadoHasta > 0 && intentos.bloqueadoHasta <= ahora
    ? 0
    : (intentos ? intentos.fallidos : 0);
  const totalFallidos = fallidos + 1;
  intentosLogin.set(ip, {
    fallidos: totalFallidos,
    bloqueadoHasta: totalFallidos >= MAX_INTENTOS_LOGIN ? ahora + BLOQUEO_LOGIN_MS : 0
  });
  res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
});

/* 🔓 Verificación de la URL secreta */
app.get('/api/acceso', (req, res) => {
  if (req.query.k && req.query.k === ADMIN_SECRET) {
    return res.json({ ok: true });
  }
  res.status(404).json({ ok: false });
});

function auth(req, res, next) {
  const t = req.headers['x-admin-token'];
  const expira = t && sesiones.get(t);
  if (expira && expira > Date.now()) return next();
  if (t) sesiones.delete(t);
  res.status(401).json({ ok: false, error: 'No autorizado' });
}

app.post('/api/admin/logout', auth, (req, res) => {
  sesiones.delete(req.headers['x-admin-token']);
  res.json({ ok: true });
});

/* ================= CONFIG PÚBLICA / MODO SENSOR ================= */
app.get('/api/config-publica', (req, res) => {
  const db = loadDB();
  res.json({
    modoSensor: !!db.config.modoSensor,
    cooldownSegundos: db.config.cooldownSegundos
  });
});

app.post('/api/modo-sensor', (req, res) => {
  const db = loadDB();
  db.config.modoSensor = !!req.body.activo;
  saveDB(db);
  res.json({ ok: true, modoSensor: db.config.modoSensor });
});

/* ================= PERSONAS / REGISTRO ================= */
app.post('/api/personas', async (req, res) => {
  try {
    const { nombre, apellido, documento, area, telefono } = req.body || {};
    if (!nombre || !apellido) {
      return res.status(400).json({ ok: false, error: 'Nombre y apellido son obligatorios' });
    }

    const db = loadDB();

    if (documento) {
      const dup = db.personas.find(p => p.documento === documento);
      if (dup) return res.status(409).json({ ok: false, error: 'Ya existe una persona con ese documento' });
    }

    db.contadorCarnet = (db.contadorCarnet || 0) + 1;
    const carnet = 'CAR-' + String(db.contadorCarnet).padStart(4, '0');

    const persona = {
      id: crypto.randomUUID(),
      carnet,
      nombre: String(nombre).trim(),
      apellido: String(apellido).trim(),
      documento: documento ? String(documento).trim() : '',
      area: area ? String(area).trim() : '',
      telefono: telefono ? String(telefono).trim() : '',
      activo: true,
      creado: new Date().toISOString()
    };

    db.personas.push(persona);
    saveDB(db);

    const qrDataUrl = await QRCode.toDataURL(carnet, { width: 400, margin: 1 });
    res.json({ ok: true, persona, qr: qrDataUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/personas/:id/qr.png', async (req, res) => {
  const db = loadDB();
  const p = db.personas.find(x => x.id === req.params.id);
  if (!p) return res.status(404).send('No encontrado');
  try {
    const buf = await QRCode.toBuffer(p.carnet, { width: 400, margin: 1 });
    res.type('png').send(buf);
  } catch (e) {
    res.status(500).send('Error generando QR');
  }
});

/* ================= ESCANEO ================= */
app.post('/api/scan', async (req, res) => {
  try {
    const codigo = String(req.body.codigo || '').trim().toUpperCase();
    const tipoForzado = req.body.tipo;
    if (!codigo) return res.status(400).json({ ok: false, error: 'Código vacío' });

    const db = loadDB();
    const persona = db.personas.find(p => p.carnet.toUpperCase() === codigo);

    if (!persona) return res.status(404).json({ ok: false, error: 'Carnet no registrado', codigo });
    if (!persona.activo) return res.status(403).json({ ok: false, error: 'Carnet inactivo', persona });

    const ahora = new Date();
    const fecha = fechaLocal(ahora);
    const hora  = horaLocal(ahora);

    const ultimo = db.registros
      .filter(r => r.personaId === persona.id)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

    const cooldownMs = Math.max(3, Number(db.config.cooldownSegundos) || 20) * 1000;
    if (ultimo && (ahora.getTime() - new Date(ultimo.timestamp).getTime()) < cooldownMs) {
      return res.json({
        ok: false, ignorado: true,
        mensaje: 'Lectura duplicada ignorada',
        persona, tipo: ultimo.tipo
      });
    }

    let tipo = tipoForzado;
    if (tipo !== 'entrada' && tipo !== 'salida') {
      tipo = (ultimo && ultimo.tipo === 'entrada') ? 'salida' : 'entrada';
    }

    const registro = {
      id: crypto.randomUUID(),
      personaId: persona.id,
      carnet: persona.carnet,
      nombre: `${persona.nombre} ${persona.apellido}`.trim(),
      tipo, fecha, hora,
      timestamp: ahora.toISOString(),
      modo: req.body.sensor ? 'sensor' : 'manual'
    };

    db.registros.push(registro);
    saveDB(db);

    enviarAviso(persona, tipo, fecha, hora).catch(err => console.error('Aviso:', err));

    res.json({ ok: true, persona, registro, tipo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================= CORREO / AVISOS ================= */
function crearTransporte(cfg) {
  if (!cfg.smtp || !cfg.smtp.host) return null;
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: Number(cfg.smtp.port) || 587,
    secure: !!cfg.smtp.secure,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined
  });
}

function actualizarAviso(id, estado, error) {
  const db = loadDB();
  const a = db.avisos.find(x => x.id === id);
  if (a) { a.estado = estado; a.error = error || null; saveDB(db); }
}

async function enviarAviso(persona, tipo, fecha, hora) {
  const db = loadDB();
  const cfg = db.config;

  if (!cfg.emailAdmin) return;
  if (tipo === 'entrada' && !cfg.notificarEntrada) return;
  if (tipo === 'salida'  && !cfg.notificarSalida)  return;

  const asunto = `[Asistencia] ${tipo === 'entrada' ? 'ENTRADA' : 'SALIDA'} · ${persona.nombre} ${persona.apellido}`;
  const texto = [
    `Se ha registrado una ${tipo.toUpperCase()} en el control de acceso.`,
    '',
    `Persona   : ${persona.nombre} ${persona.apellido}`,
    `Carnet    : ${persona.carnet}`,
    `Documento : ${persona.documento || '-'}`,
    `Área      : ${persona.area || '-'}`,
    `Fecha     : ${fecha}`,
    `Hora      : ${hora}`,
    '',
    'Aviso automático — Sistema QR de Entrada/Salida.'
  ].join('\n');

  const aviso = {
    id: crypto.randomUUID(),
    para: cfg.emailAdmin,
    asunto, cuerpo: texto,
    creado: new Date().toISOString(),
    estado: 'pendiente',
    error: null
  };
  db.avisos.push(aviso);
  saveDB(db);

  const transport = crearTransporte(cfg);
  if (!transport) {
    actualizarAviso(aviso.id, 'sin_smtp', 'SMTP no configurado (aviso guardado en el panel)');
    return;
  }
  try {
    await transport.sendMail({
      from: cfg.smtp.from || cfg.smtp.user || cfg.emailAdmin,
      to: cfg.emailAdmin,
      subject: asunto,
      text: texto
    });
    actualizarAviso(aviso.id, 'enviado', null);
  } catch (e) {
    actualizarAviso(aviso.id, 'error', e.message);
  }
}

/* ================= ADMINISTRACIÓN ================= */
app.get('/api/admin/config', auth, (req, res) => {
  const db = loadDB();
  res.json(configParaCliente(db.config));
});

app.put('/api/admin/config', auth, (req, res) => {
  const db = loadDB();
  const b = req.body || {};
  const c = db.config;

  if (typeof b.modoSensor === 'boolean') c.modoSensor = b.modoSensor;
  if (b.emailAdmin !== undefined) c.emailAdmin = String(b.emailAdmin).trim();
  if (typeof b.notificarEntrada === 'boolean') c.notificarEntrada = b.notificarEntrada;
  if (typeof b.notificarSalida === 'boolean')  c.notificarSalida  = b.notificarSalida;
  if (b.cooldownSegundos !== undefined) c.cooldownSegundos = Math.max(3, Number(b.cooldownSegundos) || 20);

  if (b.smtp && typeof b.smtp === 'object') {
    const smtpPassword = c.smtp.pass;
    c.smtp = Object.assign({}, c.smtp, b.smtp);
    c.smtp.port = Number(c.smtp.port) || 587;
    if (b.smtp.pass === '') {
      if (smtpPassword === undefined) delete c.smtp.pass;
      else c.smtp.pass = smtpPassword;
    }
  }

  saveDB(db);
  res.json({ ok: true, config: configParaCliente(c) });
});

app.get('/api/admin/personas', auth, (req, res) => {
  const db = loadDB();
  const q = String(req.query.q || '').toLowerCase().trim();
  let lista = db.personas;
  if (q) {
    lista = lista.filter(p =>
      `${p.nombre} ${p.apellido} ${p.carnet} ${p.documento} ${p.area}`.toLowerCase().includes(q)
    );
  }
  res.json(lista);
});

app.put('/api/admin/personas/:id', auth, (req, res) => {
  const db = loadDB();
  const p = db.personas.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'No encontrada' });
  ['nombre', 'apellido', 'documento', 'area', 'telefono'].forEach(k => {
    if (req.body[k] !== undefined) p[k] = String(req.body[k]).trim();
  });
  if (typeof req.body.activo === 'boolean') p.activo = req.body.activo;
  saveDB(db);
  res.json({ ok: true, persona: p });
});

app.delete('/api/admin/personas/:id', auth, (req, res) => {
  const db = loadDB();
  const idx = db.personas.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'No encontrada' });
  db.personas.splice(idx, 1);
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/admin/registros', auth, (req, res) => {
  const fecha = req.query.fecha || fechaLocal();
  const db = loadDB();
  const regs = db.registros
    .filter(r => r.fecha === fecha)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  res.json({ fecha, total: regs.length, registros: regs });
});

app.get('/api/admin/registros/export', auth, (req, res) => {
  const fecha = req.query.fecha || fechaLocal();
  const db = loadDB();
  const regs = db.registros
    .filter(r => r.fecha === fecha)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let csv = '\uFEFF' + 'Carnet,Nombre,Tipo,Fecha,Hora,Modo\n';
  for (const r of regs) {
    csv += [r.carnet, r.nombre, r.tipo, r.fecha, r.hora, r.modo].map(csvEscape).join(',') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="asistencia-${fecha}.csv"`);
  res.send(csv);
});

app.get('/api/admin/avisos', auth, (req, res) => {
  const db = loadDB();
  res.json(db.avisos.slice().reverse().slice(0, 200));
});

/* ================= INICIO ================= */
app.listen(PORT, () => {
  console.log(`✅ Sistema QR activo en http://localhost:${PORT}`);
  console.log('   Abre el panel desde el acceso oculto de la página principal.');
});