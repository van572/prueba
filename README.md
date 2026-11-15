# Sistema QR de entrada y salida

Aplicación web para registrar entradas y salidas con carnets QR. Incluye registro de personas, escáner desde el navegador, panel de administración, exportación CSV y avisos opcionales por correo. Los datos se almacenan en PostgreSQL de Supabase.

## Requisitos

- Node.js 20.6 o superior y npm.
- Un proyecto Supabase con una base de datos PostgreSQL.
- Un navegador moderno. El acceso a la cámara requiere `localhost` o HTTPS.

## Configurar Supabase

1. En Supabase, abre **Project Settings → Database** y copia el URI de conexión PostgreSQL (para Render, usa el URI del pooler de sesión si la conexión directa no está disponible).
2. No publiques ese URI ni uses la clave `service_role` en el navegador. `DATABASE_URL` debe configurarse únicamente en el entorno del servidor.
3. La aplicación crea las tablas de `supabase/schema.sql` al iniciar. También puedes ejecutar ese archivo manualmente desde el **SQL Editor** de Supabase.

## Ejecutar localmente

1. Instala dependencias:

   ```sh
   npm install
   ```

2. Crea la configuración local:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   En macOS/Linux usa `cp .env.example .env`. Configura `DATABASE_URL` con la URL PostgreSQL del proyecto y sustituye los valores `replace-` por secretos propios. `ADMIN_PASSWORD` debe tener al menos 16 caracteres y `ADMIN_SECRET` al menos 32. No subas `.env`.

3. Inicia en desarrollo y abre <http://localhost:3000>:

   ```sh
   npm run dev
   ```

   Para validar sintaxis:

   ```sh
   npm run check
   ```

## Desplegar en Render

1. Crea un **Web Service** desde el repositorio de GitHub.
2. Selecciona el entorno Node y configura:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
3. En **Environment**, añade `DATABASE_URL`, `ADMIN_USER`, `ADMIN_PASSWORD` y `ADMIN_SECRET`. Añade `DATABASE_SSL=true` salvo que uses intencionalmente una base local sin TLS. Render proporciona `PORT`.
4. Despliega y espera a que el servidor confirme que pudo inicializar Supabase.

El script `start` ejecuta `node server.js`, que es el comando de inicio de producción de Render. No requiere que exista un archivo `.env` en el servidor.

## Importar datos de `db.json`

Si tienes una copia local anterior de `data/db.json`, configura `.env` con el destino Supabase y ejecuta:

```sh
npm run migrate:json
```

El importador conserva personas, registros, avisos y configuración. Las filas con el mismo ID se omiten, por lo que puede repetirse para reintentar una importación parcial. Conserva una copia privada de `db.json` hasta verificar los datos importados; no la añadas a Git.

## Uso y configuración

- **Registro de personas:** crea una persona y genera su carnet QR.
- **Escáner:** usa la cámara o introduce un carnet manualmente. El tipo de registro alterna entre entrada y salida y aplica el periodo anti-duplicado configurado.
- **Administración:** abre el acceso oculto con `Ctrl+Shift+A` o haciendo cinco clics en el título de la página principal, e inicia sesión con `ADMIN_USER` y `ADMIN_PASSWORD`.
- **Asistencia:** consulta los registros diarios y descarga un CSV.
- **Avisos:** configura el destinatario y los datos SMTP desde el panel.

La URL de administración puede abrirse como `admin.html?k=TU_ADMIN_SECRET`. El secreto se valida en el servidor y el panel también requiere iniciar sesión.

| Variable | Descripción |
| --- | --- |
| `PORT` | Puerto HTTP. Render lo define automáticamente; localmente predeterminado: `3000`. |
| `DATABASE_URL` | URI PostgreSQL privado de Supabase. Obligatorio. |
| `DATABASE_SSL` | SSL de PostgreSQL. Predeterminado: `true`; no lo desactives en Render/Supabase. |
| `ADMIN_USER` | Usuario del panel. Obligatorio. |
| `ADMIN_PASSWORD` | Contraseña del panel, 16 caracteres o más. Obligatorio. |
| `ADMIN_SECRET` | Secreto de acceso directo al panel, 32 caracteres o más. Obligatorio. |

## Notas de despliegue

- El servicio usa `pg` directamente para comunicarse con PostgreSQL. La credencial de base de datos no se envía al navegador.
- El registro de personas y el escaneo son endpoints públicos en la configuración actual. Antes de exponerlos a Internet, añade controles de acceso o limita el servicio a una red de confianza.
- El acceso a la cámara necesita HTTPS fuera de `localhost`. El lector `html5-qrcode` se carga desde un CDN y requiere conexión a Internet.
- El plan gratuito de Render puede detener servicios inactivos; la primera petición tras una pausa puede tardar. Revisa también los límites y la política de suspensión del plan Supabase elegido.
- No se incluye una licencia. El propietario del repositorio debe elegir una antes de permitir reutilización del código.
