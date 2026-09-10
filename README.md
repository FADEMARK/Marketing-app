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

## Conectar Facebook (Meta Graph API)

Publicar automáticamente en la página de Facebook de **cada cliente** requiere permisos que Meta solo otorga sin restricciones después de un proceso de revisión (App Review). Pasos:

1. Crea una cuenta de desarrollador en [developers.facebook.com](https://developers.facebook.com) y crea una **App** de tipo "Business".
2. Agrega el producto **Facebook Login** y el permiso **`pages_manage_posts`** (y `pages_read_engagement`/`pages_show_list`).
3. En **Configuración → Básica**, agrega tu dominio en "Dominios de la app". En **Facebook Login → Configuración**, agrega en "URI de redireccionamiento de OAuth válidos" AMBAS URLs (una por cada flujo de conexión que tiene la app):
   - `https://tu-dominio/facebook/callback` (cuando el propio negocio conecta su página)
   - `https://tu-dominio/admin/facebook/callback` (cuando el admin la conecta a nombre del negocio)
4. **Mientras la app siga en modo Desarrollo** (antes de terminar App Review), el login de Facebook solo funciona con cuentas agregadas como Admin/Desarrollador/Tester de la app (Funciones de la app → Roles). Por eso, hasta que la app esté aprobada, es el **admin** quien conecta la página de cada negocio desde `/admin/businesses` (botón "Conectar Facebook" en cada fila) — no cada negocio por su cuenta.
5. Para que cualquier negocio pueda conectar su propia página sin depender del admin, hay que completar **Verificación de negocio** y enviar la app a **App Review** pidiendo acceso avanzado a los permisos de arriba (Meta pide al menos una llamada real ya hecha con cada permiso — lo que ya haces al conectar páginas desde el admin — y usualmente un video del flujo). Calcula unas semanas: verificación de negocio 1-2 semanas, y la revisión de los permisos de páginas para un caso tipo agencia 2-6 semanas, con posibilidad de un primer rechazo.
6. Una vez aprobado, cambia la app de "Desarrollo" a "Activo" en Configuración → Básica, y el flujo de negocio (`/facebook/connect`, botón en "Mi negocio") empieza a funcionar para cualquier cuenta sin que esté en la lista de testers.

Mientras tanto, el flujo manual también sigue disponible: tu equipo descarga la imagen final aprobada, publica a mano en la página del cliente, y pega el link del post en el panel interno para cerrar el ciclo (el cliente lo ve reflejado en su panel).

## FadeMarkSuite: semana de contenido con publicación automática programada

Plan aparte pensado para **diseñadores**: en vez de que la IA genere la imagen, el negocio/diseñador
pide el copy de una semana completa (7 publicaciones, cada una con un ángulo distinto sobre el mismo
tema), sube él mismo el diseño ya terminado para cada día, y al autorizar cada publicación queda
programada para publicarse **sola** en Facebook en su fecha y hora — sin pasar por la revisión del
equipo interno (a diferencia de los planes Estándar/Plus).

Para activarlo:

1. Cambia el plan del negocio a **FadeMarkSuite** desde `/admin/businesses`.
2. El negocio debe tener conectada su página de Facebook desde `/profile` (igual que el plan Plus).
3. El negocio entra a **"Semana de contenido"** en su menú, pone el tema y la fecha/hora de inicio, y
   se generan 7 publicaciones con copy distinto.
4. Sube su diseño para cada día y le da **"Autorizar publicación"** — a partir de ahí queda programada.

### Por qué necesitas configurar un cron externo

El plan gratis de Render "duerme" el servicio por inactividad. La app revisa cada 5 minutos (mientras
esté despierta) si hay publicaciones autorizadas cuyo horario ya venció, pero si nadie visita el sitio
el servicio puede estar dormido justo cuando le toca publicar algo. Para que sea confiable de verdad,
configura un cron **externo** que llame periódicamente a un endpoint protegido:

```
GET https://tu-app.onrender.com/cron/publish-due?key=EL_VALOR_DE_CRON_SECRET
```

1. Define `CRON_SECRET` en las variables de entorno de Render (un valor largo y aleatorio).
2. Configura alguna de estas opciones para que llame a esa URL cada 5-15 minutos:
   - **Render Cron Jobs** (si tienes un plan que los incluye).
   - **[cron-job.org](https://cron-job.org)** (gratis) — crea un "cronjob" con esa URL y el intervalo que quieras.
   - Un **GitHub Actions** programado (`schedule:` con `cron:`) que haga un `curl` a esa URL.

La respuesta es un JSON con cuántas publicaciones se procesaron, útil para confirmar que está funcionando.

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

El flujo actual tiene 3 pasos, pensado para que el negocio tenga control total y rápido sobre el resultado final, sin depender de que la IA acierte con texto o logos (algo que los modelos de imagen todavía no hacen de forma confiable):

1. **Copy**: al enviar el brief, la IA redacta de inmediato el título, el post/caption y los hashtags (esto ya lo ve el negocio en su panel).
2. **Fondo**: desde la página de la campaña, el negocio revisa qué se le va a mandar a la IA y da clic en "Generar imagen ahora". La IA entrega **solo el fondo** — una fotografía/escena limpia, profesional, **sin ningún texto, logo, botón ni letrero** — porque escribir texto legible dentro de la imagen es justo lo que más falla (letras cortadas, botones duplicados, datos inventados). Si hay más de un motor configurado (Gemini + OpenAI en plan Plus), se generan ambas versiones y el negocio elige con cuál quedarse.
3. **Editor**: con el fondo elegido, el negocio pasa a un mini-editor en el navegador (`/campaigns/:id/editor`, basado en Fabric.js) donde agrega su propio texto (precargado con el título/mensaje/CTA/contacto que la IA ya redactó, listo para mover o editar), su logo real, y autoformas (rectángulos, círculos, líneas, flechas, estrellas/insignias) con los colores que quiera. Al dar "Guardar y continuar" se exporta un PNG final que queda como la imagen de la campaña.

El negocio ve cada uno de estos pasos de inmediato (no espera aprobación para verlos) — pero la imagen final solo se publica en Facebook después de que tu equipo la revise y la apruebe desde el panel admin.

## Editor de imágenes: tipografías, imágenes propias y quitar fondo

El mini-editor (`/campaigns/:id/editor`) se amplió para acercarse más a un Canva/Photoshop rápido, sin salir del navegador:

- **Más tipografías**: 19 fuentes de Google Fonts organizadas por estilo (impacto/títulos, texto/cuerpo, elegante/serif, manuscrita, amigable/redondeada), más controles de negrita, cursiva, alineación y espaciado entre letras — todo aplicable a cualquier texto seleccionado.
- **Imágenes propias**: se pueden subir desde archivo o **pegar directamente con Ctrl+V/Cmd+V** (copiando de cualquier lado: el explorador de archivos, Google, Word, etc.) — se agregan como un objeto más del lienzo, movible y redimensionable.
- **Quitar fondo**: con una imagen seleccionada, el botón "✂️ Quitar fondo" aísla el sujeto/objeto principal (como en Canva), dejando el resto transparente. Corre **100% en el propio servidor** con un modelo de IA ya entrenado (U²-Net, variante ligera `u2netp`, vía `onnxruntime-node`) — no se manda la imagen a ningún servicio externo, no hay costo por imagen ni API key que configurar. Se descartó a propósito la librería más conocida para esto (`@imgly/background-removal`) porque es de licencia **AGPL**, que habría obligado a liberar el código fuente completo de la plataforma al ofrecerla como servicio a otras empresas — justo el modelo de negocio de este proyecto. Lo que se usa en su lugar (`onnxruntime-node` + el modelo `u2netp.onnx`, en `models/`) es libre de usar en un producto comercial cerrado.
  - Trade-off aceptado a propósito: se usa el modelo "ligero" (~4.5MB) en vez del modelo completo (~176MB) para que quepa dentro del proyecto sin descargarlo en cada arranque y para que no consuma demasiada memoria en un plan de hosting modesto. La calidad es buena para fotos de producto/objetos con un sujeto razonablemente definido; en casos difíciles (pelo muy fino, fondos de bajo contraste) puede no quedar perfecto — para esos casos siempre queda la opción de subir la imagen ya recortada a mano.
  - Si más adelante el volumen de uso crece y quieren mejor calidad/velocidad a cambio de un costo por imagen, la alternativa es una API de pago (ej. remove.bg, Clipdrop) — cambiar a eso solo implica reemplazar `services/backgroundRemoval.js` por una llamada HTTP, sin tocar el resto del editor.
- **Recursos 3D (stickers)**: casi 100 stickers organizados en 12 categorías pensadas para marketing (ofertas y ventas, dinero, redes y digital, tiempo y eventos, comunicación, reacciones, comida y bebida, belleza y salud, negocios, transporte y logística, temporada/fechas especiales, personas y celebración), con un buscador que filtra por palabra clave en español (ej. escribir "dinero" muestra moneda/billetes/tarjeta). Usan el emoji a color nativo del sistema operativo/navegador (ya tienen un estilo "3D" brillante con degradados y sombras) en vez de depender de un banco de íconos con licencia externa — es un punto de partida pensado para poder sustituirse después por un set de marca propio (ej. Flaticon, Freepik) sin cambiar la mecánica del editor. El catálogo completo vive como datos en `views/editor.ejs` (`STICKERS_3D`), así que agregar más es solo añadir entradas a ese arreglo.
- **Filtros de imagen**: con una imagen seleccionada (o usando el botón "Editar la foto de fondo" para apuntar a la fotografía de fondo), hay 9 preajustes de un clic (Vívido, Blanco y negro, Sepia, Cálido, Frío, Alto contraste, Nítida, Suave, Ninguno) más sliders de brillo/contraste/saturación para afinar. Usa los filtros nativos de Fabric.js (`fabric.Image.filters.*`) — no se agregó ninguna librería nueva para esto.

## Claude (Anthropic): afinar el prompt + revisar la foto generada (opcional)

Anthropic no ofrece un modelo que genere imágenes — Claude sigue siendo Gemini/OpenAI para eso. Pero se puede usar Claude alrededor del paso 2 de arriba para dos cosas, ambas opcionales:

1. **Afinar el prompt**: justo antes de mandarle el prompt a Gemini/OpenAI, Claude lo reescribe agregando detalle visual concreto (encuadre, luz, ángulo de cámara) sin tocar las reglas técnicas fijas (no texto, no logo) que ya trae `services/aiImage.js`.
2. **Revisar la foto y regenerar sola si hace falta**: apenas Gemini/OpenAI entregan el fondo, Claude lo revisa con visión. Si detecta texto/logo/marca de agua que se colaron por error, caras o manos deformadas, o una escena que no calza con el giro del negocio, la app **regenera automáticamente** (hasta `AI_IMAGE_MAX_ATTEMPTS`, 3 por defecto) y se queda con la primera versión que salga limpia. Si se agotan los intentos sin lograrlo, muestra el último intento junto con el aviso de Claude, para que el negocio decida si regenera a mano o sigue al editor de todas formas — nunca es 100% garantizado (ningún generador de imágenes lo es), pero baja bastante la chance de que llegue algo con texto o logo mal puesto.

Para activarlo:

1. Crea tu API key en [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys).
2. Agrega `ANTHROPIC_API_KEY` a las variables de entorno de tu servicio.
3. Redeploy.

Si no defines esta clave, la app sigue funcionando exactamente igual que hoy, solo sin estas dos ayudas (y sin reintentos automáticos). Usa por defecto el modelo más económico (`claude-haiku-4-5-20251001`) — el costo por publicación es una fracción de centavo (precios actuales: ~$1 por millón de tokens de entrada, ~$5 por millón de salida; revisa [claude.com/pricing](https://claude.com/pricing) para precios vigentes). Puedes forzar otro modelo con `ANTHROPIC_TEXT_MODEL` / `ANTHROPIC_VISION_MODEL` si prefieres más calidad a cambio de más costo.

## Documentos rápidos (propuestas, cotizaciones, reportes...) con Claude

Módulo aparte, en `/documents` — a diferencia de las dos ayudas de arriba, aquí Claude **sí es obligatorio** (no hay Gemini/OpenAI de respaldo, porque esto es puro texto, no imagen). El flujo:

1. El negocio entra a **Documentos** desde el menú y escribe en sus palabras qué necesita (ej. "una cotización para el negocio X por 4 publicaciones, entrega en 5 días, 50% anticipo").
2. Claude redacta el documento completo (título + secciones) — instrucción explícita de no inventar precios, fechas ni cantidades que el negocio no haya dado; si hacen falta, los deja marcados entre corchetes (ej. `[monto a confirmar]`) para que el negocio los complete.
3. El negocio revisa y edita el texto libremente (agregar/quitar secciones, corregir redacción) antes de descargarlo.
4. Al descargar, `services/pdfBuilder.js` arma el PDF (con [pdfkit](https://pdfkit.org/), sin necesitar un navegador headless) usando automáticamente el **logo y los colores de marca** que el negocio ya tiene cargados en su perfil — así cada documento sale con la misma identidad visual sin que el negocio tenga que diseñar nada.

Sin `ANTHROPIC_API_KEY` configurada, la sección `/documents` se muestra deshabilitada con un mensaje explicativo, en vez de fallar a medias.

Costo: igual de bajo que las otras ayudas de Claude — un documento típico (~2,000 tokens de entrada, ~1,200 de salida) cuesta entre $0.005 y $0.01 con Haiku 4.5. El PDF en sí no tiene costo de IA, es generación normal en el servidor.

Ojo con el costo cuando el reintento automático entra en acción: cada intento repite la generación con Gemini/OpenAI (que tiene su propio costo aparte) más una llamada de enriquecer + revisar con Claude, así que en el peor caso (3 intentos seguidos fallidos) el gasto de esa publicación se multiplica hasta por 3. En la práctica es poco frecuente que agote los 3 intentos. Puedes bajar `AI_IMAGE_MAX_ATTEMPTS` a 1 o 2 si prefieres priorizar costo sobre insistencia.

## Módulos por negocio: cómo activar/desactivar CRM y ERP

A partir de esta versión, MarketingHub deja de ser solo "marketing" — es una plataforma con **módulos opcionales** que se activan por negocio, pensada para revenderse por partes. Marketing (crear publicaciones, generar copy/imagen, publicar en Facebook) es el producto base y siempre está disponible. CRM y ERP-Yonkes son módulos aparte que tu equipo activa o desactiva desde `/admin/businesses` con un check por negocio — el negocio mismo no se puede autoactivar un módulo nuevo, así queda claro qué le vendiste a cada cliente.

Si un negocio no tiene un módulo activo, al intentar entrar a `/crm` o `/erp` ve una pantalla explicando que ese módulo no está activo (y el link ni siquiera aparece en su menú). Apagar un módulo corta el acceso al instante, sin que el negocio tenga que cerrar sesión — útil si alguien deja de pagar ese módulo en particular.

Técnicamente: `businesses.module_crm_enabled` y `businesses.module_erp_enabled` (booleanos), validados en cada request por `services/modules.js` → `requireModule()`, el mismo patrón que ya se usaba para revisar que el negocio esté activo (`is_active`). Agregar un módulo nuevo en el futuro (por ejemplo, la tienda en línea) es: una columna booleana más, un middleware `requireModule("nombre")` en sus rutas, y un check más en el panel admin.

## CRM: contactos y leads por negocio

Módulo opcional (`/crm`, requiere `module_crm_enabled`) — cada negocio lleva su propia lista de clientes/leads, con notas de seguimiento. No depende de ninguna IA, así que no tiene costo variable. Es intencionalmente simple (v1): una lista con estado (Nuevo, Contactado, Interesado, Cliente, Perdido) y notas de texto libre por contacto — sin pipeline tipo kanban.

Cada contacto guarda, además de nombre/teléfono/correo: **dirección**, y **datos fiscales básicos** (RFC y razón social) por si el negocio más adelante quiere facturarle — a propósito esto NO se conecta a ningún PAC/SAT, solo se guarda para mostrarse en reportes o PDFs internos del negocio. La fecha de alta del contacto se muestra siempre en su detalle.

**Campos personalizados por negocio**: cada cliente puede necesitar rastrear cosas distintas de sus leads (una aseguradora quiere "Tipo de póliza", un consultorio quiere "Fecha de próxima cita", etc.). Estos campos **los configura tu equipo, no el negocio**, desde el panel interno en `/admin/businesses/:id/crm-fields` — así se pueden ajustar a la medida de cada cliente al momento de venderle la herramienta, como haría una implementación de NetSuite. Tipos disponibles: texto, número, fecha y lista de opciones. Los valores que cada negocio llena para sus contactos se guardan automáticamente y aparecen tanto en el formulario de nuevo contacto como en el detalle.

Si borras un campo personalizado desde el panel admin, los valores que ya se habían guardado en contactos existentes no se pierden, pero el campo deja de mostrarse (por si luego lo vuelves a crear con el mismo nombre).

## YonkSuite (ERP Yonkes): control de autos siniestrados y venta de piezas

Módulo opcional (`/erp`, requiere `module_erp_enabled`), pensado para yonkes/deshuesaderos: se compra un auto siniestrado, se desarma en piezas, y cada pieza se vende por separado. Vive en su propia sección de la plataforma, con su propio dashboard (`/erp`), su propio login para empleados (`/erp/login`) y su propia barra de navegación reducida cuando entra un empleado.

### Planes: YonkSuite Standard vs YonkSuite Plus

Independiente del check "Módulo ERP" (que solo prende/apaga el acceso), cada negocio tiene un **plan ERP** que tu equipo controla desde `/admin/businesses` (columna "Plan ERP"):

- **YonkSuite Standard**: solo la cuenta dueña del negocio puede entrar al ERP. Es una sola sesión activa a la vez en **toda la plataforma** (Marketing, CRM y ERP) — si el mismo usuario inicia sesión desde otra computadora o navegador, la sesión anterior se cierra sola en cuanto esa persona vuelve a interactuar con la app (no hace falta que la cierre manualmente).
- **YonkSuite Plus**: agrega hasta **3 cuentas de empleado** (`/erp/empleados`, gestionado por el dueño o por un empleado con rol Admin) con acceso por rol:
  - **Admin**: puede crear/editar/desactivar/borrar empleados y sus roles, y además tiene acceso completo a compras y ventas.
  - **Ventas**: solo puede registrar y cancelar ventas de piezas ya en inventario. No puede dar de alta vehículos, subir fotos, agregar piezas ni editar datos del vehículo.
  - **Compras**: da de alta vehículos, sube fotos, agrega/edita/borra piezas y las manda a inventario. No puede vender.
  - **Ventas / Admin**: compras + ventas juntos, sin permisos de gestión de empleados.

  Cada cuenta de empleado también tiene sesión única (si el mismo empleado entra desde otro dispositivo, la sesión vieja de ESE empleado se cierra). Si el negocio baja de Plus a Standard, las cuentas de empleado pierden acceso al instante (no necesitan cerrar sesión, se les corta como al resto de módulos).

### El flujo del día a día

1. **Alta del vehículo** (`/erp/vehicles/new`, requiere permiso de Compras): marca, modelo, año, VIN, placa, color, precio de compra, fecha de compra, notas, y hasta 8 fotos (se comprimen automáticamente a JPEG al subirlas).
2. **Búsqueda de stock**: tanto el dashboard (`/erp`) como el inventario (`/erp/vehiculos`) tienen un buscador de texto libre — escribe algo como "camioneta Ford 2016" y encuentra coincidencias sin importar el orden de las palabras ni en qué campo estén (marca, modelo, año, VIN o placa).
3. **Piezas**: desde el detalle del vehículo se registran las piezas que salen de él (motor, transmisión, suspensión y dirección, frenos, eléctrico, carrocería, interior, llantas y rines, u otro), cada una con un precio sugerido opcional y un **estado físico** (Bueno / Deteriorado / Malo) que ayuda a decidir a qué precio venderla.
4. **Venta** (requiere permiso de Ventas): se registra en el detalle de ESE vehículo — seleccionas qué piezas se vendieron y confirmas el precio real de cada una. Las piezas vendidas quedan marcadas como tal y ya no se pueden editar ni borrar (es un registro financiero). Las ventas se pueden **cancelar** si se registraron por error: las piezas regresan a "Disponible".
5. **Estado de cuenta por vehículo**: precio de compra, cuánto se ha vendido de él hasta ahora, y la ganancia o pérdida resultante — sin necesitar que el vehículo esté completamente vendido para verlo.
6. **Dar de baja el stock**: cuando ya no queda nada que vender de un vehículo, se marca manualmente como "Agotado" (botón "Marcar como Agotado" en el detalle del vehículo, se puede reactivar si hace falta). Un vehículo con ventas registradas no se puede borrar —por ser un registro financiero—, solo marcarse como agotado. Cada pieza también se puede marcar como "Desechada" si resultó dañada/sin valor de venta.

Todo queda aislado por negocio y todo el flujo de venta corre dentro de una transacción de base de datos, para que una venta a medio registrar nunca deje piezas en un estado inconsistente.

### Funciones de IA (solo se disparan con un clic, nunca automáticas)

Igual que en Marketing, ninguna función de IA del ERP se ejecuta sola — todas requieren que el usuario presione un botón explícito, para que nunca se gaste una llamada de IA sin que lo pidan:

- **🤖 Analizar con IA (sugerir piezas)** — botón en la sección de Fotos del detalle del vehículo (solo con permiso de Compras y solo si ya hay al menos una foto subida). Manda las fotos del vehículo a Gemini/OpenAI (según cuál API key esté configurada) pidiéndole que identifique qué piezas se ven y sugiera categoría, estado físico y precio. El resultado aparece como un **checklist**: cada pieza sugerida trae casilla, estado editable y precio editable — solo las piezas que el usuario **marca y envía** con el botón "Enviar seleccionadas a inventario" se crean como piezas reales; las que no se marcan nunca llegan al inventario disponible.
- **💡 Sugerir precio** — botón junto a cada pieza ya existente; le pasa a la IA el vehículo, el nombre de la pieza y su estado (Bueno/Deteriorado/Malo) y devuelve un precio sugerido en pesos mexicanos.
- **🔎 Buscador rápido de compatibilidad** — un cuadro de texto libre en el detalle del vehículo (disponible para cualquier rol, sin cambiar de pantalla) donde puedes preguntar cosas como "Nissan Versa 2016 puerta derecha es compatible con qué modelos" y la IA responde en el momento.

Las tres funciones usan el mismo proveedor de IA ya configurado para Marketing (`GEMINI_API_KEY` primero, `OPENAI_API_KEY` como respaldo — ver la sección de variables de entorno). Si el negocio no tiene ninguna de las dos configuradas, los botones responden con un mensaje claro en vez de fallar. El costo por uso es el mismo orden de magnitud que un copy de Marketing (unos centavos de dólar por llamada); el análisis de fotos cuesta un poco más que una llamada de solo texto por incluir imágenes, pero sigue siendo bajo.

### Consultoría: cómo empaquetar y revender YonkSuite

Dado que la idea es venderlo como producto aparte (estilo NetSuite, pero mucho más ligero y enfocado a un giro específico), los dos planes (Standard/Plus) ya están implementados y listos para usarse como escalones de precio — esta es una propuesta de modelo de negocio de partida, ajústala según lo que veas en el mercado:

- **YonkSuite Standard** como plan de entrada: un solo usuario (el dueño), sin cuentas de empleado. Bueno para un yonke chico donde una sola persona captura todo.
- **YonkSuite Plus** como plan superior: hasta 3 cuentas de empleado con roles (Admin/Ventas/Compras/Ventas-Admin) — natural para un yonke con mostrador de ventas separado de quien desarma los autos. El cambio de plan lo haces tú desde `/admin/businesses` con el selector "Plan ERP", sin tocar código.
- **Cuota mensual por yonke (SaaS)**, no por transacción — es lo más simple de vender y de explicarle al cliente, con Standard y Plus como dos precios distintos. Un tope de vehículos activos (por ejemplo, hasta 30 vehículos "en stock" simultáneos) es fácil de agregar más adelante (un `COUNT` sobre `erp_vehicles WHERE status='en_stock'`) si quieres un tercer escalón por volumen.
- **Cuota de implementación inicial (setup fee), aparte de la mensualidad**: carga de su catálogo de vehículos/piezas existente si ya tenían algo en Excel, configuración de su marca (logo/colores, que ya se reutilizan en Documentos y en el futuro catálogo), y una sesión de capacitación al equipo del yonke. Esto es normal en software B2B y ayuda a que el precio mensual no cargue con todo el costo de arranque.
- **Cobro por el uso de las funciones de IA** (análisis de fotos, precio sugerido, compatibilidad) si decides pasarle ese costo al cliente en vez de absorberlo en la mensualidad — cada llamada es barata, pero en un yonke con mucho movimiento puede sumar.
- Tú (o tu equipo) actúan como el "admin" de la plataforma: dan de alta al negocio, activan el módulo ERP con el check correspondiente y eligen su Plan ERP, y quedan como soporte de primer nivel — el mismo rol que ya cumples hoy con los negocios de Marketing.

### Próximos pasos sugeridos para YonkSuite

- **Tienda en línea**: el modelo de datos ya quedó listo para esto (las piezas ya tienen categoría, precio, estado físico y el vehículo ya tiene fotos) — el siguiente paso natural sería una página pública de catálogo por yonke (sin necesitar login) mostrando las piezas "Disponibles", para que el público las vea y contacte o compre. Vale la pena definir aparte si el pago se procesa en línea (Stripe/Mercado Pago) o solo se usa como escaparate para generar el contacto.
- **Fotos por pieza** (hoy las fotos son del vehículo completo) — importante si se construye la tienda en línea, ya que el comprador de una pieza específica quiere verla a ella, no solo el auto completo.
- **Reportes**: un dashboard con ganancia acumulada por periodo, piezas más vendidas por categoría, etc. — con los datos ya estructurados como quedaron (erp_sales/erp_sale_items), son consultas SQL directas, no requiere cambiar el modelo de datos.
- **Historial de auditoría por empleado**: hoy se sabe qué rol tiene cada empleado, pero no queda un registro de "quién exactamente dio de alta esta pieza o esta venta" — útil si el yonke crece y quiere rastrear responsabilidad por captura.
- **Facturación electrónica real (CFDI)** si en algún momento se vuelve un requisito — se dejó la puerta abierta guardando los datos fiscales del cliente en el CRM, pero conectar un PAC (proveedor autorizado del SAT) es un desarrollo aparte, con costo recurrente propio del PAC.

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
│   ├── aiParts.js           # YonkSuite: sugerir piezas por foto, precio sugerido, compatibilidad
│   ├── backgroundRemoval.js # quitar fondo de imágenes (self-hosted, sin licencia AGPL)
│   ├── canva.js             # genera el diseño vía Canva Connect API
│   ├── erpStatus.js         # constantes de YonkSuite (estados, planes, roles/permisos)
│   ├── facebook.js          # publica en Facebook vía Meta Graph API
│   ├── middleware.js        # protección de rutas (negocio / admin / ERP por rol)
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
