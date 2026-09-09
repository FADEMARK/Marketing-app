// Quitar el fondo de una imagen (pegada o subida en el editor), 100% local:
// corre dentro de nuestro propio servidor con un modelo de IA ya entrenado
// (U^2-Net, versión "ligera" u2netp) usando onnxruntime-node — sin mandar la
// imagen a ningún servicio externo, sin costo por imagen y sin API key.
//
// Por qué esta opción y no otras:
// - @imgly/background-removal (la más conocida) es AGPL: nos obligaría a
//   liberar el código fuente completo de la plataforma si la usamos en un
//   producto que se ofrece como servicio a otras empresas — justo el modelo
//   de negocio de este ERP/CRM/Marketing. La descartamos por eso.
// - onnxruntime-node (MIT, de Microsoft) + el modelo u2netp.onnx (arquitectura
//   U^2-Net, licencia Apache 2.0, de sus autores originales) sí son libres de
//   usar en un producto comercial cerrado sin restricciones de este tipo.
// - Corre en el mismo proceso Node de siempre (usa "sharp", que ya es
//   dependencia del proyecto) — no requiere Python ni un microservicio aparte.
//
// Trade-off aceptado a propósito: el modelo es más ligero (u2netp, ~4.5MB) en
// vez del modelo completo u2net (~176MB) para que el archivo se pueda incluir
// tal cual en el proyecto (sin descargarlo en cada arranque) y para que la
// inferencia no consuma demasiada memoria/CPU en un plan de hosting modesto.
// La calidad del recorte es buena para fotos de producto/objetos con un
// sujeto razonablemente definido, pero no es perfecta en casos muy difíciles
// (pelo suelto muy fino, fondos con mucho contraste bajo, etc.) — para esos
// casos seguirá quedando la opción de subir la imagen ya recortada a mano.

const path = require("path");
const sharp = require("sharp");
const { InferenceSession, Tensor } = require("onnxruntime-node");

const MODEL_PATH = path.join(__dirname, "..", "models", "u2netp.onnx");
const MODEL_SIZE = 320;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

// Límite de tamaño de entrada: si la foto pegada/subida es más grande, la
// reducimos antes de procesar. El modelo igual la analiza a 320x320 por
// dentro, así que no perdemos calidad de segmentación por esto — solo
// evitamos cargar/mover en memoria una imagen innecesariamente enorme.
const MAX_INPUT_DIMENSION = 1600;

let sessionPromise = null;
function getSession() {
  if (!sessionPromise) {
    sessionPromise = InferenceSession.create(MODEL_PATH).catch((err) => {
      sessionPromise = null; // permite reintentar en la siguiente llamada
      throw err;
    });
  }
  return sessionPromise;
}

// Aísla el sujeto principal de una foto, devolviendo un PNG con canal alfa
// (transparente donde el modelo detectó fondo). Recibe y devuelve Buffers.
async function removeBackgroundFromBuffer(inputBuffer) {
  const session = await getSession();

  let working = sharp(inputBuffer, { failOn: "none" }).rotate(); // respeta orientación EXIF
  const meta = await working.metadata();
  let { width, height } = meta;
  if (!width || !height) {
    throw new Error("No se pudo leer la imagen de entrada.");
  }

  if (width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION) {
    working = working.resize({
      width: MAX_INPUT_DIMENSION,
      height: MAX_INPUT_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });
    const resizedMeta = await working.clone().metadata();
    width = resizedMeta.width;
    height = resizedMeta.height;
  }

  // Congelamos los píxeles de trabajo en un Buffer para no repetir el
  // decodificado/rotate() en cada rama de abajo.
  const workingBuffer = await working.toBuffer();

  // --- Preprocesado: 320x320 RGB, normalizado estilo ImageNet, formato
  // CHW (canal-primero) como espera el modelo. ---
  const { data: rgbData } = await sharp(workingBuffer)
    .removeAlpha()
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const planeSize = MODEL_SIZE * MODEL_SIZE;
  const chw = new Float32Array(planeSize * 3);
  for (let i = 0; i < planeSize; i++) {
    const r = rgbData[i * 3] / 255;
    const g = rgbData[i * 3 + 1] / 255;
    const b = rgbData[i * 3 + 2] / 255;
    chw[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    chw[planeSize + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    chw[planeSize * 2 + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  const inputName = session.inputNames[0];
  const tensor = new Tensor("float32", chw, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const results = await session.run({ [inputName]: tensor });

  // U^2-Net expone varias salidas laterales (a distinta escala/profundidad);
  // la de nombre numérico más chico es la salida principal fusionada (d0),
  // la más precisa — mismo criterio usado en otras implementaciones de
  // referencia de este modelo.
  const mainOutputName = session.outputNames
    .slice()
    .sort((a, b) => Number(a) - Number(b))[0];
  const maskData = results[mainOutputName].data; // Float32Array 0..1, 320x320

  const maskBytes = Buffer.alloc(planeSize);
  for (let i = 0; i < planeSize; i++) {
    const v = Math.round(maskData[i] * 255);
    maskBytes[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // Reescalamos la máscara al tamaño real de la foto. IMPORTANTE: sin
  // .greyscale() aquí, sharp promueve la salida a 3 canales al reescalar un
  // buffer raw de 1 canal, y se pierde la máscara (queda "aplanada").
  const resizedMask = await sharp(maskBytes, {
    raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 1 },
  })
    .greyscale()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();

  const rgba = await sharp(workingBuffer).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4 + 3] = resizedMask[i];
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// Conveniencia: recibe y devuelve data URIs (mismo formato que usa el resto
// de la app para imágenes en memoria/Postgres).
async function removeBackgroundFromDataUri(dataUri) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri || "");
  if (!match) {
    throw new Error("Formato de imagen no reconocido (se esperaba un data URI base64).");
  }
  const inputBuffer = Buffer.from(match[2], "base64");
  const outputBuffer = await removeBackgroundFromBuffer(inputBuffer);
  return "data:image/png;base64," + outputBuffer.toString("base64");
}

module.exports = { removeBackgroundFromBuffer, removeBackgroundFromDataUri };
