// Las imágenes que genera un agente (Codex, con el generador de imágenes del plan de ChatGPT) se copian a la
// carpeta compartida: así el usuario las ve en el chat y los demás agentes pueden usarlas. Codex las deja en
// su propia carpeta (~/.codex/generated_images) y la ruta que da en su respuesta no siempre es la correcta,
// por eso ClosedBot las toma del evento de la imagen. Escrito para ClosedBot.

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** Subcarpeta de la carpeta compartida con las imágenes: una carpeta por agente. */
export const IMAGES_DIR = "imagenes";
/** Una imagen más grande que esto no se copia. */
export const IMAGE_MAX_BYTES = 40 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface SavedImage {
  /** Ruta completa del archivo. */
  path: string;
  /** Ruta dentro de la carpeta compartida, con «/» (p. ej. «imagenes/ana/portada.png»). */
  relativePath: string;
}

/**
 * Guarda en la carpeta compartida (en imagenes/<folder>/) la imagen de un evento `imageGeneration`: la copia desde
 * `savedPath` si existe o, si no, la decodifica de `result` (base64). Devuelve null si no hay una imagen válida.
 */
export function saveGeneratedImage(input: {
  sharedDir: string;
  folder: string;
  savedPath: string | null;
  result: string | null;
  now?: Date;
}): SavedImage | null {
  const folder = input.folder || "agente";
  const dir = join(input.sharedDir, IMAGES_DIR, folder);
  const source = input.savedPath?.trim() || null;
  if (source && IMAGE_EXTENSIONS.has(extname(source).toLowerCase()) && existsSync(source)) {
    const stats = statSync(source);
    if (stats.isFile() && stats.size > 0 && stats.size <= IMAGE_MAX_BYTES) {
      mkdirSync(dir, { recursive: true });
      const name = freeName(dir, basename(source));
      copyFileSync(source, join(dir, name));
      return { path: join(dir, name), relativePath: `${IMAGES_DIR}/${folder}/${name}` };
    }
  }
  const data = decodeImage(input.result);
  if (!data) return null;
  mkdirSync(dir, { recursive: true });
  const name = freeName(dir, `imagen-${stamp(input.now ?? new Date())}${data.extension}`);
  writeFileSync(join(dir, name), data.bytes);
  return { path: join(dir, name), relativePath: `${IMAGES_DIR}/${folder}/${name}` };
}

/** El texto con la lista de imágenes al final, con su ruta completa para que quien lo recibe pueda abrirlas. */
export function withImages(text: string, images: ReadonlyArray<Pick<SavedImage, "path">>): string {
  const body = text.trim();
  if (!images.length) return body;
  const note = [
    images.length === 1 ? "Imagen generada, ya en la carpeta compartida:" : "Imágenes generadas, ya en la carpeta compartida:",
    ...images.map((image) => `- ${image.path}`),
  ].join("\n");
  return body ? `${body}\n\n${note}` : note;
}

/** Los bytes de una imagen en base64 (con o sin «data:…;base64,»), si de verdad es una imagen. */
function decodeImage(value: string | null): { bytes: Buffer; extension: string } | null {
  if (!value) return null;
  const text = value.trim().replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
  // Muy corto para ser una imagen, o no es base64.
  if (text.length < 32 || !/^[A-Za-z0-9+/=\s_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return null;
  const extension = imageExtension(bytes);
  return extension ? { bytes, extension } : null;
}

/** La extensión según los primeros bytes (PNG, JPEG, WebP o GIF), o null si no es una imagen conocida. */
export function imageExtension(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return ".webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return ".gif";
  return null;
}

/** Un nombre que todavía no existe en la carpeta («portada.png», «portada-2.png»…). */
function freeName(dir: string, wanted: string): string {
  const extension = extname(wanted);
  const stem = (basename(wanted, extension).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "imagen").slice(0, 80);
  for (let index = 1; index < 1_000; index += 1) {
    const name = `${stem}${index === 1 ? "" : `-${index}`}${extension.toLowerCase()}`;
    if (!existsSync(join(dir, name))) return name;
  }
  return `${stem}-${Date.now()}${extension.toLowerCase()}`;
}

/** «20261105-201530», en la hora local. */
function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
