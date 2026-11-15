CREATE SEQUENCE IF NOT EXISTS carnet_counter START WITH 1;

CREATE TABLE IF NOT EXISTS app_config (
  id integer PRIMARY KEY CHECK (id = 1),
  config jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id uuid PRIMARY KEY,
  carnet text NOT NULL UNIQUE,
  nombre text NOT NULL,
  apellido text NOT NULL,
  documento text NOT NULL DEFAULT '',
  area text NOT NULL DEFAULT '',
  telefono text NOT NULL DEFAULT '',
  activo boolean NOT NULL DEFAULT true,
  creado timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS personas_documento_unico
  ON personas (documento)
  WHERE documento <> '';

CREATE TABLE IF NOT EXISTS registros (
  id uuid PRIMARY KEY,
  persona_id uuid NOT NULL,
  carnet text NOT NULL,
  nombre text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('entrada', 'salida')),
  fecha text NOT NULL,
  hora text NOT NULL,
  timestamp timestamptz NOT NULL,
  modo text NOT NULL
);

CREATE INDEX IF NOT EXISTS registros_persona_timestamp
  ON registros (persona_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS registros_fecha_timestamp
  ON registros (fecha, timestamp);

CREATE TABLE IF NOT EXISTS avisos (
  id uuid PRIMARY KEY,
  para text NOT NULL,
  asunto text NOT NULL,
  cuerpo text NOT NULL,
  creado timestamptz NOT NULL,
  estado text NOT NULL,
  error text
);

CREATE INDEX IF NOT EXISTS avisos_creado
  ON avisos (creado DESC);
