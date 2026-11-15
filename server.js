/* =========================================================
   SISTEMA DE ENTRADA / SALIDA POR QR  —  con acceso oculto
   ========================================================= */
const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const QRCode     = require('qrcode');
const nodemailer = require('nodemailer');
const database   = require('./database');

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

/* ---------- Middlewares ---------- */
app.use(express.json({ limit: '5mb' }));

// 🚫 Bloquear archivos internos accesibles desde el navegador
app.use((req, res, next) => {
  const bloqueados = [
    '/server.js', '/database.js', '/package.json', '/package-lock.json',
    '/supabase', '/node_modules'
  ];
  if (bloqueados.some(b => req.path.startsWith(b))) {
    return res.status(403).send('Forbidden');
  }
  next();
});

// ✅ Servir HTML/CSS/JS desde la MISMA carpeta que server.js
app.use(express.static(__dirname));

const asyncHandler = handler => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

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
app.get('/api/config-publica', asyncHandler(async (req, res) => {
  res.json(await database.obtenerConfigPublica());
}));

app.post('/api/modo-sensor', asyncHandler(async (req, res) => {
  const config = await database.actualizarConfig(c => {
    c.modoSensor = !!req.body.activo;
  });
  res.json({ ok: true, modoSensor: config.modoSensor });
}));

/* ================= PERSONAS / REGISTRO ================= */
app.post('/api/personas', async (req, res) => {
  try {
    const { nombre, apellido, documento, area, telefono } = req.body || {};
    if (!nombre || !apellido) {
      return res.status(400).json({ ok: false, error: 'Nombre y apellido son obligatorios' });
    }

    const persona = {
      id: crypto.randomUUID(),
      nombre: String(nombre).trim(),
      apellido: String(apellido).trim(),
      documento: documento ? String(documento).trim() : '',
      area: area ? String(area).trim() : '',
      telefono: telefono ? String(telefono).trim() : '',
      activo: true,
      creado: new Date().toISOString()
    };

    let personaGuardada;
    try {
      personaGuardada = await database.crearPersona(persona);
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ ok: false, error: 'Ya existe una persona con ese documento' });
      }
      throw error;
    }

    const qrDataUrl = await QRCode.toDataURL(personaGuardada.carnet, { width: 400, margin: 1 });
    res.json({ ok: true, persona: personaGuardada, qr: qrDataUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/personas/:id/qr.png', asyncHandler(async (req, res) => {
  const p = await database.obtenerPersonaPorId(req.params.id);
  if (!p) return res.status(404).send('No encontrado');
  const buf = await QRCode.toBuffer(p.carnet, { width: 400, margin: 1 });
  res.type('png').send(buf);
}));

/* ================= ESCANEO ================= */
app.post('/api/scan', async (req, res) => {
  try {
    const codigo = String(req.body.codigo || '').trim().toUpperCase();
    if (!codigo) return res.status(400).json({ ok: false, error: 'Código vacío' });

    const ahora = new Date();
    const fecha = fechaLocal(ahora);
    const hora  = horaLocal(ahora);
    const resultado = await database.registrarEscaneo(
      codigo, req.body.tipo, !!req.body.sensor, ahora, fecha, hora
    );
    if (resultado.noEncontrada) {
      return res.status(404).json({ ok: false, error: 'Carnet no registrado', codigo });
    }
    if (resultado.inactiva) {
      return res.status(403).json({ ok: false, error: 'Carnet inactivo', persona: resultado.persona });
    }
    if (resultado.ignorado) {
      return res.json({
        ok: false, ignorado: true,
        mensaje: 'Lectura duplicada ignorada',
        persona: resultado.persona, tipo: resultado.tipo
      });
    }

    enviarAviso(resultado.persona, resultado.tipo, fecha, hora)
      .catch(err => console.error('Aviso:', err));
    res.json({
      ok: true,
      persona: resultado.persona,
      registro: resultado.registro,
      tipo: resultado.tipo
    });
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

async function enviarAviso(persona, tipo, fecha, hora) {
  const cfg = await database.obtenerConfig();

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

  const aviso = await database.crearAviso({
    id: crypto.randomUUID(),
    para: cfg.emailAdmin,
    asunto, cuerpo: texto,
    creado: new Date().toISOString(),
    estado: 'pendiente',
    error: null
  });

  const transport = crearTransporte(cfg);
  if (!transport) {
    await database.actualizarAviso(aviso.id, 'sin_smtp', 'SMTP no configurado (aviso guardado en el panel)');
    return;
  }
  try {
    await transport.sendMail({
      from: cfg.smtp.from || cfg.smtp.user || cfg.emailAdmin,
      to: cfg.emailAdmin,
      subject: asunto,
      text: texto
    });
    await database.actualizarAviso(aviso.id, 'enviado', null);
  } catch (e) {
    await database.actualizarAviso(aviso.id, 'error', e.message);
  }
}

/* ================= ADMINISTRACIÓN ================= */
app.get('/api/admin/config', auth, asyncHandler(async (req, res) => {
  res.json(configParaCliente(await database.obtenerConfig()));
}));

app.put('/api/admin/config', auth, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const config = await database.actualizarConfig(c => {
    if (typeof b.modoSensor === 'boolean') c.modoSensor = b.modoSensor;
    if (b.emailAdmin !== undefined) c.emailAdmin = String(b.emailAdmin).trim();
    if (typeof b.notificarEntrada === 'boolean') c.notificarEntrada = b.notificarEntrada;
    if (typeof b.notificarSalida === 'boolean') c.notificarSalida = b.notificarSalida;
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
  });
  res.json({ ok: true, config: configParaCliente(config) });
}));

app.get('/api/admin/personas', auth, asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  res.json(await database.buscarPersonas(q));
}));

app.put('/api/admin/personas/:id', auth, asyncHandler(async (req, res) => {
  let p;
  try {
    p = await database.actualizarPersona(req.params.id, req.body || {});
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una persona con ese documento' });
    }
    throw error;
  }
  if (!p) return res.status(404).json({ ok: false, error: 'No encontrada' });
  res.json({ ok: true, persona: p });
}));

app.delete('/api/admin/personas/:id', auth, asyncHandler(async (req, res) => {
  const eliminada = await database.eliminarPersona(req.params.id);
  if (!eliminada) return res.status(404).json({ ok: false, error: 'No encontrada' });
  res.json({ ok: true });
}));

app.get('/api/admin/registros', auth, asyncHandler(async (req, res) => {
  const fecha = req.query.fecha || fechaLocal();
  const regs = await database.listarRegistros(fecha);
  res.json({ fecha, total: regs.length, registros: regs });
}));

app.get('/api/admin/registros/export', auth, asyncHandler(async (req, res) => {
  const fecha = req.query.fecha || fechaLocal();
  const regs = await database.listarRegistros(fecha);

  let csv = '\uFEFF' + 'Carnet,Nombre,Tipo,Fecha,Hora,Modo\n';
  for (const r of regs) {
    csv += [r.carnet, r.nombre, r.tipo, r.fecha, r.hora, r.modo].map(csvEscape).join(',') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="asistencia-${fecha}.csv"`);
  res.send(csv);
}));

app.get('/api/admin/avisos', auth, asyncHandler(async (req, res) => {
  res.json(await database.listarAvisos());
}));

/* ================= INICIO ================= */
app.use((error, req, res, next) => {
  console.error('Error en solicitud:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ ok: false, error: 'Error interno del servidor' });
});

database.inicializar().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Sistema QR activo en http://localhost:${PORT}`);
    console.log('   Abre el panel desde el acceso oculto de la página principal.');
  });
}).catch(error => {
  console.error('No se pudo conectar o inicializar Supabase:', error.message);
  database.cerrar().finally(() => {
    process.exitCode = 1;
  });
});