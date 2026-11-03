// «Instalar» de Gemini en Ajustes: descarga Antigravity, el programa oficial de Google, en la carpeta de
// programas de ClosedBot. Uso: node install-antigravity.js <carpeta>

import { ANTIGRAVITY, installAntigravity } from "./antigravity.js";

const [dir] = process.argv.slice(2);
if (!dir) {
  process.stderr.write("Uso: install-antigravity <carpeta>\n");
  process.exit(2);
}

let shown = -1;
process.stdout.write(`Descargando Antigravity ${ANTIGRAVITY.version} de Google…\n`);
try {
  const program = await installAntigravity({
    dir,
    onProgress: (received, total) => {
      // Una línea cada 10 %: queda en el registro si algo falla.
      const step = total ? Math.floor((received / total) * 10) : Math.floor(received / 50_000_000);
      if (step === shown) return;
      shown = step;
      process.stdout.write(total ? `${step * 10} %\n` : `${Math.round(received / 1_000_000)} MB\n`);
    },
  });
  process.stdout.write(`Listo: ${program}\n`);
} catch (error) {
  // Solo el motivo: la app le antepone «No se pudo instalar».
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
