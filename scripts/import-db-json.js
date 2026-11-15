const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const archivo = path.join(__dirname, '..', 'data', 'db.json');
if (!process.env.DATABASE_URL) {
  throw new Error('Configura DATABASE_URL antes de importar los datos.');
}
if (!fs.existsSync(archivo)) {
  throw new Error('No existe data/db.json. No hay datos locales para importar.');
}

function extraerNumeroCarnet(carnet) {
  const coincidencia = /^CAR-(\d+)$/i.exec(carnet || '');
  return coincidencia ? Number(coincidencia[1]) : 0;
}

async function importar() {
  const db = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  if (!Array.isArray(db.personas) || !Array.isArray(db.registros) || !Array.isArray(db.avisos)) {
    throw new Error('data/db.json no tiene la estructura esperada.');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true }
  });
  await client.connect();
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
    await client.query(schema);
    await client.query('BEGIN');
    for (const persona of db.personas) {
      await client.query(
        `INSERT INTO personas (id, carnet, nombre, apellido, documento, area, telefono, activo, creado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          persona.id, persona.carnet, persona.nombre, persona.apellido, persona.documento || '',
          persona.area || '', persona.telefono || '', persona.activo !== false,
          persona.creado || new Date().toISOString()
        ]
      );
    }

    for (const registro of db.registros) {
      await client.query(
        `INSERT INTO registros (id, persona_id, carnet, nombre, tipo, fecha, hora, timestamp, modo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          registro.id, registro.personaId, registro.carnet, registro.nombre, registro.tipo,
          registro.fecha, registro.hora, registro.timestamp, registro.modo || 'manual'
        ]
      );
    }

    for (const aviso of db.avisos) {
      await client.query(
        `INSERT INTO avisos (id, para, asunto, cuerpo, creado, estado, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          aviso.id, aviso.para, aviso.asunto, aviso.cuerpo || '', aviso.creado,
          aviso.estado || 'pendiente', aviso.error || null
        ]
      );
    }

    if (db.config && typeof db.config === 'object') {
      await client.query(
        `INSERT INTO app_config (id, config) VALUES (1, $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
        [JSON.stringify(db.config)]
      );
    }

    const numeroImportado = Math.max(
      Number(db.contadorCarnet) || 0,
      ...db.personas.map(persona => extraerNumeroCarnet(persona.carnet))
    );
    const secuencia = await client.query("SELECT last_value, is_called FROM carnet_counter");
    const numeroActual = Number(secuencia.rows[0].last_value);
    if (numeroImportado > numeroActual || !secuencia.rows[0].is_called) {
      await client.query("SELECT setval('carnet_counter', $1, $2)", [
        Math.max(numeroImportado, numeroActual),
        numeroImportado > 0 || secuencia.rows[0].is_called
      ]);
    }
    await client.query('COMMIT');
    console.log(`Importación completada: ${db.personas.length} personas, ${db.registros.length} registros y ${db.avisos.length} avisos.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

importar().catch(error => {
  console.error('No se pudo importar data/db.json:', error.message);
  process.exitCode = 1;
});
