# MarketingHub — Prototipo funcional

App donde un negocio se registra con su **nombre** y el **link de su página de Facebook**, y luego llena un formulario con los datos de su próxima publicación. Ese "brief" queda pendiente en un panel interno donde tu equipo de Marketing/Diseño Senior redacta el copy, genera/ajusta la imagen y finalmente publica (por ahora, manualmente) en la página de Facebook del cliente.

Probado end-to-end: registro, login, creación de brief, generación automática de copy + hashtags, panel admin, actualización de estado y cierre del ciclo con el link del post publicado.

## Qué incluye

- **Sitio del cliente**: registro, login, dashboard con sus publicaciones, formulario de nueva publicación con todos los campos creativos (objetivo, producto, mensaje clave, público, tono, CTA, palabras clave, fecha deseada, imagen de referencia, notas de marca), y vista de detalle con el resultado.
- **Panel interno (tu equipo)**: login separado, listado de todos los briefs de todos los clientes, vista de detalle con el brief completo, edición del copy/hashtags generados, subida de la imagen final, campo para el link de Canva y para el link del post ya publicado, y cambio de estado (`Pendiente de revisión` → `En diseño` → `Listo para aprobación` → `Aprobado` → `Publicado`).
- **Generación de copy**: por reglas (funciona sin configuración) o con IA vía OpenAI si defines `OPENAI_API_KEY`.
- **Generación de diseño**: integración lista para Canva Connect API (autofill de una plantilla de marca). Si no está configurada, el brief simplemente queda en "En diseño" para que tu diseñador lo haga a mano y suba el resultado.
- **Publicación en Facebook**: estructura lista para Meta Graph API, pero **sin configurar todavía** (ver guía abajo). Mientras tanto el flujo es manual: tu equipo publica y pega el link del post en el panel.

## Requisitos

- Node.js **18 o superior**.
- Una base de datos **PostgreSQL** (local para desarrollo, o gratis en Render/Railway/Supabase para producción). La app usa Postgres — no un archivo local — precisamente para poder correr en hostings gratuitos con sistema de archivos efímero (ver sección de Render abajo).

## Instalación (desarrollo local)

```bash
cd marketing-app
npm install
cp .env.example .env
```

Edita `.env`:
- `SESSION_SECRET`: cualquier string largo y aleatorio.
- `DATABASE_URL`: la conexión a tu Postgres local, ej. `postgres://usuario:password@localhost:5432/marketing_app`.
- Si tu Postgres local no usa SSL, agrega `PGSSL=disable`.

Crea tu primer usuario del equipo interno:

```bash
npm run seed:admin -- "Tu Nombre" tucorreo@empresa.com unaContraseñaSegura
```

Arranca el servidor (crea las tablas solo si no existen):

```bash
npm start
```

Abre `http://localhost:3000` para el sitio del cliente y `http://localhost:3000/admin/login` para el panel interno.

## Desplegar GRATIS en Render (recomendado para empezar)

Esta es la ruta más simple: sin servidor que administrar, con HTTPS y dominio propio incluidos, y puedes ir de gratis a un plan pagado sin tocar el código.

**1. Sube el proyecto a GitHub** (Render despliega desde un repositorio Git). Crea un repo — puede ser privado — y sube todo el contenido de esta carpeta (excepto `node_modules` y `.env`, ya están en `.gitignore`).

**2. Crea la base de datos gratis:**
- En el [Dashboard de Render](https://dashboard.render.com), click **New → Postgres**.
- Elige el plan **Free**. Cópiate la **Internal Database URL** que te da (la vas a necesitar en el paso 4).
- Ten en cuenta: una base Postgres gratis de Render **expira a los 30 días** (con 14 días de gracia) si no la subes a un plan pagado (~$6-9/mes). Antes de esa fecha, decides si sigues gratis migrando a otra base o si pagas para no perder los datos.

**3. Crea el servicio web:**
- Click **New → Web Service** y conecta el repositorio de GitHub que subiste.
- **Language**: Node. **Build Command**: `npm install`. **Start Command**: `npm start`.
- **Instance Type**: elige **Free**.

**4. Variables de entorno** (sección Environment del servicio):
- `DATABASE_URL`: pega la Internal Database URL del paso 2.
- `SESSION_SECRET`: un string largo y aleatorio.
- (Opcional) `OPENAI_API_KEY`, `CANVA_API_KEY`, `CANVA_BRAND_TEMPLATE_ID`, etc.

**5. Deploy.** Render instala, arranca `npm start`, y te da una URL tipo `tuapp.onrender.com`.

**6. Crea tu usuario admin.** Dos formas, según lo que te sea más fácil:

- **Sin terminal (recomendado si no usas la línea de comandos)**: agrega temporalmente la variable de entorno `SETUP_ADMIN_TOKEN` (cualquier texto secreto que inventes) en el Web Service, redeploy, y visita `https://tu-app.onrender.com/setup-admin` en el navegador — ahí hay un formulario para crear tu usuario admin. Cuando termines, **quita** esa variable de entorno por seguridad (para que la página deje de estar disponible).
- **Con terminal**, si tienes Node.js instalado en tu computadora:
  ```bash
  DATABASE_URL="la-external-database-url-de-render" npm run seed:admin -- "Tu Nombre" tucorreo@empresa.com unaContraseñaSegura
  ```
  (Usa la **External** Database URL para esto, no la interna — la interna solo funciona entre servicios dentro de Render.)

**7. Conecta tu dominio** (fade.mx o el que sea): en el servicio de Render, ve a **Settings → Custom Domains**, agrega tu dominio, y sigue las instrucciones para apuntar un registro CNAME desde IONOS (o Cloudflare, si ya moviste el DNS ahí) hacia Render.

### Sobre las limitaciones del plan gratis

- El servicio se "duerme" tras 15 minutos sin visitas y tarda ~1 minuto en despertar con la siguiente visita (Render muestra una pantalla de carga mientras tanto). Los **datos no se pierden** — ya están en Postgres, no en el disco del servicio — y las **sesiones tampoco**, porque también viven en Postgres (tabla `session`, se crea sola).
- 750 horas gratis de servicio al mes por workspace (de sobra para un solo servicio corriendo todo el mes).
- Cuando quieras que ya no se duerma (por ejemplo, en cuanto tengas clientes reales usándolo seguido), sube el **Instance Type** del Web Service a **Starter** (~$7/mes) desde el dashboard — un clic, sin tocar código.
- Recuerda la fecha de expiración de la base Postgres gratis (30 días) para decidir a tiempo si pagas por ella (~$6-9/mes) o migras.

## Desplegar en tu propio servidor (VPS)

Si prefieres no depender de Render:

1. Sube el proyecto (sin `node_modules` ni `.env`) y corre `npm install --production` en el servidor.
2. Instala Postgres en el mismo servidor o usa uno gestionado (Render, Supabase, etc.) y define `DATABASE_URL` en `.env`.
3. Corre `npm run seed:admin -- ...` para crear el usuario del equipo.
4. Usa un gestor de procesos como **PM2** para mantenerlo vivo:
   ```bash
   npm install -g pm2
   pm2 start server.js --name marketinghub
   pm2 save
   ```
5. Pon un **Nginx** (o similar) delante como proxy inverso hacia el puerto definido en `PORT`, con HTTPS (Let's Encrypt).

## Conectar Facebook (Meta Graph API) — pendiente, guía paso a paso

Publicar automáticamente en la página de Facebook de **cada cliente** requiere permisos que Meta solo otorga después de un proceso de revisión (App Review). Pasos:

1. Crea una cuenta de desarrollador en [developers.facebook.com](https://developers.facebook.com) y crea una **App** de tipo "Business".
2. Agrega el producto **Facebook Login** y el permiso **`pages_manage_posts`** (y `pages_read_engagement` si quieres leer métricas después).
3. Cada negocio deberá autorizar tu App para gestionar su página (flujo de Facebook Login / OAuth). Con eso obtienes un **Page Access Token** por cada página de cliente — es el que necesita `services/facebook.js`.
4. Envía la App a **App Review** de Meta, explicando el caso de uso (agencia que publica en nombre de negocios que la autorizan). Sin esta aprobación, los permisos solo funcionan con páginas de prueba tuyas.
5. Una vez aprobado, guarda el token de cada negocio (hoy el `.env` tiene un solo `META_PAGE_ACCESS_TOKEN` de ejemplo; en producción cada negocio necesita su propio token guardado en la base de datos).

Mientras tanto, el flujo manual ya funciona: tu equipo descarga la imagen final aprobada, publica a mano en la página del cliente, y pega el link del post en el panel interno para cerrar el ciclo (el cliente lo ve reflejado en su panel).

## Generar el copy Y la imagen automáticamente con IA (la forma más simple)

Con una sola variable de entorno, la app genera automáticamente **tanto el texto del post como la imagen** para cada brief nuevo, sin necesidad de configurar Canva.

### Opción recomendada: Google Gemini (gratis, sin tarjeta)

Ojo: esto es distinto de una suscripción a "Gemini Advanced" (Google One) — esa no da acceso a la API. Lo que necesitas es una cuenta de Google normal y una API key gratuita:

1. Ve a [aistudio.google.com/apikey](https://aistudio.google.com/apikey), inicia sesión con tu cuenta de Google, y crea una API key. No pide tarjeta.
2. Agrega `GEMINI_API_KEY` a las variables de entorno de tu servicio (en Render: **Environment** → Add Environment Variable).
3. Redeploy.

El nivel gratuito incluye hasta 500 imágenes al día y un límite generoso de texto — más que suficiente para empezar. Ten en cuenta que en el nivel gratuito, Google puede usar tus prompts para entrenar sus modelos (revisa sus términos si esto te preocupa por confidencialidad de tus clientes).

### Opción alternativa: OpenAI (de pago, sin relación con ChatGPT Plus)

Si prefieres OpenAI: crea una API key en [platform.openai.com/api-keys](https://platform.openai.com/api-keys) (cuenta de facturación separada de una suscripción a ChatGPT Plus, esa no sirve aquí) y agrega `OPENAI_API_KEY`. El costo es por uso (revisa precios vigentes en [openai.com/api/pricing](https://openai.com/api/pricing)).

Si defines ambas claves, la app usa Gemini primero y solo recurre a OpenAI si Gemini falla.

### Cómo se comporta con cualquiera de las dos

Desde que agregues la clave, cada publicación nueva llega al panel admin ya con: copy redactado, hashtags, y una imagen generada por IA lista para revisar — el estado pasa directo a "Listo para aprobación" en vez de "En diseño".

Importante: el cliente **no ve** la imagen ni el copy hasta que tu equipo cambie el estado a "Aprobado" o "Publicado" desde el panel admin — así siempre hay una revisión humana antes de que el cliente vea el resultado (la IA ayuda con el trabajo pesado, tu equipo se queda con el control de calidad).

Ten en cuenta: los modelos de generación de imagen todavía no escriben texto de forma confiable, así que la imagen se genera **sin texto superpuesto** (solo el elemento visual); el copy/CTA se maneja aparte como el texto del post. Si necesitas texto dentro de la imagen (como un banner con precio), tu equipo puede editarla en Canva/Photoshop antes de aprobarla.

## Conectar Canva (alternativa más elaborada, con plantillas de marca)

`services/canva.js` ya tiene la llamada real a la API de autofill de Canva. Para activarla:

1. Crea una app en [canva.com/developers](https://www.canva.com/developers/).
2. Diseña una o varias **plantillas de marca** (Brand Templates) en Canva con placeholders de texto (por ejemplo `headline`, `subheadline`, `cta`) que coincidan con los nombres usados en `services/canva.js`.
3. Canva Connect API usa OAuth 2.0: implementa el flujo de autorización para obtener un `access_token` (y `refresh_token`) y colócalo en `CANVA_API_KEY`. Guarda el ID de la plantilla en `CANVA_BRAND_TEMPLATE_ID`.
4. Si más adelante cada cliente tiene su propia identidad visual, lo más simple es tener una plantilla de marca distinta por cliente (guardando el `brand_template_id` en la tabla `businesses`).

Sin esto configurado, la app sigue funcionando: el brief pasa directo a "En diseño" para que el equipo cree la pieza a mano y la suba en el panel interno.

## Estructura del proyecto

```
marketing-app/
├── server.js              # rutas y arranque del servidor
├── db/db.js                # conexión PostgreSQL (pg) y esquema
├── services/
│   ├── aiCopy.js           # genera caption + hashtags (reglas o IA)
│   ├── canva.js             # genera el diseño vía Canva Connect API
│   ├── facebook.js          # publica en Facebook vía Meta Graph API
│   ├── middleware.js        # protección de rutas (negocio / admin)
│   └── status.js            # estados posibles de una campaña
├── views/                  # plantillas EJS (sitio cliente + panel admin)
├── public/css/style.css     # estilos
└── scripts/seed-admin.js    # crea/actualiza un usuario del equipo interno
```

Los logos, imágenes de referencia y diseños finales se guardan como texto (data URI en base64) directamente en Postgres, no como archivos en disco — así sobreviven a los reinicios del servicio en hostings con sistema de archivos efímero (como el free tier de Render).

## Próximos pasos sugeridos

- Guardar un `page_access_token` por negocio (columna nueva en `businesses`) una vez que Facebook Login esté integrado, para poder publicar automáticamente por cliente.
- Notificar por correo al cliente cuando su publicación pasa a "Aprobado" o "Publicado".
- Calendario de publicaciones (vista mensual) en vez de solo lista.
- Roles dentro del panel interno (diseñador vs. copywriter vs. aprobador).
- Si el volumen de imágenes crece mucho, mover el almacenamiento de imágenes de Postgres (base64) a un object storage como Cloudflare R2 o AWS S3, y guardar solo la URL en la base de datos — más barato y eficiente a gran escala.
