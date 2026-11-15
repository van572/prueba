const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('Configura DATABASE_URL con la URL PostgreSQL de Supabase.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true }
});

const CONFIG_POR_DEFECTO = {
  modoSensor: false,
  cooldownSegundos: 20,
  emailAdmin: '',
  notificarEntrada: true,
  notificarSalida: true,
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' }
};

function personaDesdeFila(row) {
  if (!row) return null;
  return {
    id: row.id,
    carnet: row.carnet,
    nombre: row.nombre,
    apellido: row.apellido,
    documento: row.documento,
    area: row.area,
    telefono: row.telefono,
    activo: row.activo,
    creado: row.creado
  };
}

function registroDesdeFila(row) {
  return {
    id: row.id,
    personaId: row.persona_id,
    carnet: row.carnet,
    nombre: row.nombre,
    tipo: row.tipo,
    fecha: row.fecha,
    hora: row.hora,
    timestamp: new Date(row.timestamp).toISOString(),
    modo: row.modo
  };
}

function avisoDesdeFila(row) {
  return {
    id: row.id,
    para: row.para,
    asunto: row.asunto,
    cuerpo: row.cuerpo,
    creado: new Date(row.creado).toISOString(),
    estado: row.estado,
    error: row.error
  };
}

async function inicializar() {
  const schema = fs.readFileSync(path.join(__dirname, 'supabase', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(
    `INSERT INTO app_config (id, config)
     VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(CONFIG_POR_DEFECTO)]
  );
  await pool.query('SELECT 1');
}

async function obtenerConfig(client = pool, bloquear = false) {
  const result = await client.query(
    `SELECT config FROM app_config WHERE id = 1${bloquear ? ' FOR UPDATE' : ''}`
  );
  if (!result.rows[0]) throw new Error('No se encontró la configuración inicial de la base de datos.');
  return Object.assign({}, CONFIG_POR_DEFECTO, result.rows[0].config, {
    smtp: Object.assign({}, CONFIG_POR_DEFECTO.smtp, result.rows[0].config.smtp || {})
  });
}

async function actualizarConfig(actualizar) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const config = await obtenerConfig(client, true);
    actualizar(config);
    await client.query('UPDATE app_config SET config = $1::jsonb WHERE id = 1', [JSON.stringify(config)]);
    await client.query('COMMIT');
    return config;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function obtenerConfigPublica() {
  const config = await obtenerConfig();
  return {
    modoSensor: !!config.modoSensor,
    cooldownSegundos: config.cooldownSegundos
  };
}

async function crearPersona(persona) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ carnet_numero: numero }] } = await client.query(
      "SELECT nextval('carnet_counter') AS carnet_numero"
    );
    const nuevaPersona = Object.assign({}, persona, {
      carnet: 'CAR-' + String(numero).padStart(4, '0')
    });
    const result = await client.query(
      `INSERT INTO personas (id, carnet, nombre, apellido, documento, area, telefono, activo, creado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        nuevaPersona.id, nuevaPersona.carnet, nuevaPersona.nombre, nuevaPersona.apellido,
        nuevaPersona.documento, nuevaPersona.area, nuevaPersona.telefono,
        nuevaPersona.activo, nuevaPersona.creado
      ]
    );
    await client.query('COMMIT');
    return personaDesdeFila(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function obtenerPersonaPorId(id) {
  const result = await pool.query('SELECT * FROM personas WHERE id = $1', [id]);
  return personaDesdeFila(result.rows[0]);
}

async function actualizarPersona(id, cambios) {
  const campos = ['nombre', 'apellido', 'documento', 'area', 'telefono'];
  const asignaciones = [];
  const valores = [id];
  for (const campo of campos) {
    if (cambios[campo] !== undefined) {
      valores.push(String(cambios[campo]).trim());
      asignaciones.push(`${campo} = $${valores.length}`);
    }
  }
  if (typeof cambios.activo === 'boolean') {
    valores.push(cambios.activo);
    asignaciones.push(`activo = $${valores.length}`);
  }
  if (!asignaciones.length) return obtenerPersonaPorId(id);
  const result = await pool.query(
    `UPDATE personas SET ${asignaciones.join(', ')} WHERE id = $1 RETURNING *`,
    valores
  );
  return personaDesdeFila(result.rows[0]);
}

async function buscarPersonas(termino = '') {
  const result = termino
    ? await pool.query(
      `SELECT * FROM personas
       WHERE position(lower($1) in lower(concat_ws(' ', nombre, apellido, carnet, documento, area))) > 0
       ORDER BY creado DESC`,
      [termino]
    )
    : await pool.query('SELECT * FROM personas ORDER BY creado DESC');
  return result.rows.map(personaDesdeFila);
}

async function eliminarPersona(id) {
  const result = await pool.query('DELETE FROM personas WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function registrarEscaneo(codigo, tipoForzado, sensor, ahora, fecha, hora) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const personaResult = await client.query(
      'SELECT * FROM personas WHERE upper(carnet) = $1 FOR UPDATE',
      [codigo]
    );
    const persona = personaDesdeFila(personaResult.rows[0]);
    if (!persona) {
      await client.query('COMMIT');
      return { noEncontrada: true };
    }
    if (!persona.activo) {
      await client.query('COMMIT');
      return { inactiva: true, persona };
    }

    const ultimoResult = await client.query(
      'SELECT * FROM registros WHERE persona_id = $1 ORDER BY timestamp DESC LIMIT 1',
      [persona.id]
    );
    const ultimo = ultimoResult.rows[0] ? registroDesdeFila(ultimoResult.rows[0]) : null;
    const config = await obtenerConfig(client);
    const cooldownMs = Math.max(3, Number(config.cooldownSegundos) || 20) * 1000;
    if (ultimo && (ahora.getTime() - new Date(ultimo.timestamp).getTime()) < cooldownMs) {
      await client.query('COMMIT');
      return { ignorado: true, persona, tipo: ultimo.tipo };
    }

    const tipo = tipoForzado === 'entrada' || tipoForzado === 'salida'
      ? tipoForzado
      : (ultimo && ultimo.tipo === 'entrada') ? 'salida' : 'entrada';
    const registroResult = await client.query(
      `INSERT INTO registros (id, persona_id, carnet, nombre, tipo, fecha, hora, timestamp, modo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        crypto.randomUUID(), persona.id, persona.carnet,
        `${persona.nombre} ${persona.apellido}`.trim(), tipo, fecha, hora,
        ahora.toISOString(), sensor ? 'sensor' : 'manual'
      ]
    );
    await client.query('COMMIT');
    return { persona, registro: registroDesdeFila(registroResult.rows[0]), tipo };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function crearAviso(aviso) {
  const result = await pool.query(
    `INSERT INTO avisos (id, para, asunto, cuerpo, creado, estado, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [aviso.id, aviso.para, aviso.asunto, aviso.cuerpo, aviso.creado, aviso.estado, aviso.error]
  );
  return avisoDesdeFila(result.rows[0]);
}

async function actualizarAviso(id, estado, error) {
  await pool.query('UPDATE avisos SET estado = $2, error = $3 WHERE id = $1', [id, estado, error || null]);
}

async function listarAvisos(limite = 200) {
  const result = await pool.query('SELECT * FROM avisos ORDER BY creado DESC LIMIT $1', [limite]);
  return result.rows.map(avisoDesdeFila);
}

async function listarRegistros(fecha) {
  const result = await pool.query(
    'SELECT * FROM registros WHERE fecha = $1 ORDER BY timestamp ASC',
    [fecha]
  );
  return result.rows.map(registroDesdeFila);
}

module.exports = {
  inicializar,
  obtenerConfig,
  actualizarConfig,
  obtenerConfigPublica,
  crearPersona,
  obtenerPersonaPorId,
  actualizarPersona,
  buscarPersonas,
  eliminarPersona,
  registrarEscaneo,
  crearAviso,
  actualizarAviso,
  listarAvisos,
  listarRegistros,
  cerrar: () => pool.end()
};
