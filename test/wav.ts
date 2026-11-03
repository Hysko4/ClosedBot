// Audios WAV hechos a mano para las pruebas del dictado local.

/** WAV de prueba: PCM de 8/16/24/32 bits o flotante, con uno o varios canales intercalados. */
export function makeWav(frames: number[][], rate = 16_000, format: { bits?: number; float?: boolean; extensible?: boolean } = {}): Buffer {
  const bits = format.bits ?? 16;
  const channels = frames[0]?.length ?? 1;
  const bytes = bits / 8;
  const data = Buffer.alloc(frames.length * channels * bytes);
  let offset = 0;
  for (const frame of frames) {
    for (const value of frame) {
      if (format.float) data.writeFloatLE(value, offset);
      else if (bits === 8) data.writeUInt8(Math.round(value * 127 + 128), offset);
      else if (bits === 16) data.writeInt16LE(Math.round(value * 32_767), offset);
      else if (bits === 24) data.writeIntLE(Math.round(value * 8_388_607), offset, 3);
      else data.writeInt32LE(Math.round(value * 2_147_483_647), offset);
      offset += bytes;
    }
  }
  const fmtSize = format.extensible ? 40 : 16;
  const header = Buffer.alloc(12 + 8 + fmtSize + 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length - 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(fmtSize, 16);
  const code = format.float ? 3 : 1;
  header.writeUInt16LE(format.extensible ? 0xfffe : code, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytes, 28);
  header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bits, 34);
  if (format.extensible) {
    header.writeUInt16LE(22, 36);
    header.writeUInt16LE(bits, 38);
    header.writeUInt32LE(0, 40);
    header.writeUInt16LE(code, 44);
  }
  header.write("data", 12 + 8 + fmtSize, "ascii");
  header.writeUInt32LE(data.length, 12 + 8 + fmtSize + 4);
  return Buffer.concat([header, data]);
}

/** Silencio mono de «seconds» segundos (sin armar un arreglo por muestra). */
export function silentWav(seconds: number, rate = 16_000): Buffer {
  const header = makeWav([], rate);
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  header.writeUInt32LE(header.length - 8 + data.length, 4);
  header.writeUInt32LE(data.length, header.length - 4);
  return Buffer.concat([header, data]);
}

/** Audio mono de «seconds» segundos con un tono suave. */
export function toneWav(seconds: number, rate = 16_000): Buffer {
  const frames: number[][] = [];
  for (let index = 0; index < Math.round(seconds * rate); index += 1) frames.push([0.25 * Math.sin((index / rate) * 2 * Math.PI * 220)]);
  return makeWav(frames, rate);
}
