# Cuadrilla

Tu equipo personal de agentes de IA. Cada agente tiene nombre, rol e instrucciones, trabaja con **Claude** o **Codex** en su propia carpeta, y puede pedirles ayuda a sus compañeros. Lo manejas como una app de escritorio en Windows (ventana propia e icono en la bandeja), desde el navegador o desde el teléfono, como una app instalada.

Está inspirada en [OpenBot](https://openbot.run/) y reutiliza partes de su versión 0.1.11, publicada con licencia Apache 2.0 (ver [Licencias](#licencias)).

## Qué hace

- **Varios agentes**, cada uno con su proveedor (Claude, Codex o Demo), modelo, nivel de esfuerzo y nivel de acceso.
- **Cola por agente**: si le escribes mientras trabaja, el mensaje espera su turno. Puedes quitar mensajes de la cola, pausarla o detener el turno en curso.
- **Trabajo en equipo**: los agentes se escriben entre sí con las herramientas `list_agents` y `send_message`. Si un compañero termina sin contestar, su resultado vuelve solo a quien se lo pidió. Hay un límite de reenvíos seguidos (6 por defecto) para cortar bucles.
- **Respuestas en vivo**, con el historial guardado en SQLite. Cada agente retoma su conversación aunque reinicies el servidor.
- **Preguntas con opciones**: un agente puede preguntarte algo con una tarjeta de 2 a 4 opciones (con una recomendada). Tocas una y tu respuesta le llega como un mensaje nuevo.
- **Rutinas**: tareas que se repiten solas, a horas fijas (por ejemplo, de lunes a viernes a las 08:30) o cada cierto tiempo (desde 15 minutos). Las creas tú o se las pides a un agente. Solo corren mientras Cuadrilla está abierta; si una se atrasa más de 2 horas, se salta y queda el aviso.
- **Lista de agentes como en una app de chat**: agrupados por proyecto, con su último mensaje y un punto en los que tienen novedades.
- **Dictado por voz y adjuntos**: el micrófono escribe lo que dices (en Edge o Chrome) y puedes adjuntar archivos, que quedan en la carpeta del agente.
- **App instalable** (PWA) en Android y iPhone, a través de tu red privada de Tailscale.
- **Dos niveles de acceso**:
  - *Solo su carpeta* (por defecto): el agente escribe en su carpeta y en la carpeta compartida, y sus comandos corren dentro de un sandbox.
  - *Acceso total*: comandos y archivos de toda la máquina, sin pedir permiso. Úsalo solo en una máquina dedicada.

## Antes de instalar: seguridad

- **Instálala en una máquina dedicada** (una VM o VPS aparte), nunca en el servidor de Sider4 ni donde guardes credenciales de bancos, exchanges o bots. Los agentes ejecutan comandos de verdad.
- **No la expongas a Internet.** Por defecto solo escucha en `127.0.0.1`. Al teléfono llega por Tailscale, que es una red privada entre tus dispositivos.
- El acceso pide una contraseña. La sesión se guarda en una cookie `HttpOnly`, y el login se bloquea tras 10 intentos fallidos en 15 minutos.
- Cada mensaje a Claude o a Codex consume tu saldo de API o tu plan. El proveedor **Demo** no usa IA y sirve para probar la app gratis.

## Requisitos

- Linux (probado pensando en Ubuntu 22.04 o 24.04), **Node.js 22.13 o superior** y `git`.
- **Claude**: una clave de API de Anthropic (`ANTHROPIC_API_KEY`). Para apps hechas con el Agent SDK, Anthropic indica autenticarse con clave de API.
- **Codex** (opcional): `npm install -g @openai/codex` y luego iniciar sesión con `codex login --device-auth`.
- **Modo «Solo su carpeta» con Claude**: el sandbox de Claude Code necesita `bubblewrap` y `socat`.
- **Tailscale**, en el servidor y en el teléfono.

## Instalación paso a paso

Todos los comandos van en el servidor dedicado.

```bash
# 1. Node.js 22, git y el sandbox
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git bubblewrap socat

# 2. Un usuario solo para Cuadrilla (sin sudo)
sudo adduser --disabled-password --gecos "" cuadrilla
sudo -iu cuadrilla

# 3. Descargar el código. El repo es privado, así que primero inicia sesión en GitHub.
#    Puedes usar la CLI de GitHub (gh auth login) o una "deploy key" de solo lectura.
gh auth login
gh repo clone Hysko4/ClosedBot cuadrilla
cd cuadrilla
npm ci
npm run build

# 4. Crear la contraseña de acceso
npm run password                 # te la pide dos veces
# o bien:  npm run password -- --generate   (genera una segura y la muestra una vez)

# 5. (Opcional) Iniciar sesión en Codex como este usuario
codex login --device-auth

# 6. Probar a mano
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Para verla desde tu computador antes de configurar Tailscale, usa un túnel SSH: `ssh -L 8787:127.0.0.1:8787 usuario@servidor`, y luego abre <http://127.0.0.1:8787>.

### Dejarla funcionando siempre (systemd)

```bash
# como un usuario con sudo (no como "cuadrilla")
sudo cp /home/cuadrilla/cuadrilla/deploy/cuadrilla.service /etc/systemd/system/
sudo install -m 600 /home/cuadrilla/cuadrilla/deploy/cuadrilla.env.example /etc/cuadrilla.env
sudo nano /etc/cuadrilla.env          # pega tu ANTHROPIC_API_KEY
sudo systemctl daemon-reload
sudo systemctl enable --now cuadrilla
journalctl -u cuadrilla -f            # ver registros
```

### Usarla desde el teléfono (Tailscale)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8787        # publica https://<maquina>.<tu-tailnet>.ts.net solo dentro de tu red
```

En el teléfono, instala la app de Tailscale y entra con la misma cuenta. Luego abre la dirección `https://….ts.net`, inicia sesión e instala la app:

- **Android (Chrome)**: menú ⋮ → «Instalar app».
- **iPhone (Safari)**: botón Compartir → «Añadir a pantalla de inicio».

## Windows: app de escritorio (en tu PC, para uso personal)

También funciona en Windows 10 u 11, sin servidor aparte, como una app con su propia ventana:

1. Instala Node.js 22 o superior: `winget install OpenJS.NodeJS.LTS`.
2. Descarga el código en una carpeta tuya (por ejemplo, `C:\Users\<tú>\cuadrilla`).
3. Abre **`Instalar-escritorio.cmd`** con doble clic. Instala las dependencias, compila, crea el programa `Cuadrilla.exe`, crea una contraseña si no tenías (queda en `CONTRASENA-CUADRILLA.txt`) y pone el acceso directo **Cuadrilla** en el escritorio y en el menú Inicio.

Cómo se usa:

- El acceso directo abre Cuadrilla en **su propia ventana**, sin barras del navegador y sin pedir la contraseña (entra con un código de un solo uso). Usa Edge, o Chrome si no hay Edge, con un perfil solo para Cuadrilla.
- Queda un **icono en la bandeja**, junto al reloj. Clic: abre la ventana. Clic derecho: *Iniciar con Windows*, *Ver registro* y *Salir*.
- Si cierras la ventana, Cuadrilla sigue funcionando en segundo plano para tus rutinas. Para cerrarla del todo, usa *Salir*.
- Arranca con Windows (sin abrir la ventana) desde la primera instalación. Lo cambias en el menú de la bandeja.
- El registro está en `%LOCALAPPDATA%\Cuadrilla\cuadrilla.log`. Si el servidor se cae, el programa lo vuelve a arrancar (hasta 3 veces en 15 minutos) y te avisa si no puede.
- **Actualizar**: reemplaza el código por la versión nueva (tus datos están en `C:\Users\<tú>\.cuadrilla` y no se tocan) y vuelve a abrir `Instalar-escritorio.cmd`.
- **Quitar los accesos directos**: `Cuadrilla.exe /desinstalar`.

Si prefieres la consola: `npm ci`, `npm run build`, `npm run password -- --generate` y `npm start`, y abre <http://127.0.0.1:8787>.

Diferencias en Windows:

- **Claude en «Solo su carpeta» no tiene terminal.** Claude Code no puede encerrar los comandos en una carpeta en Windows. Por eso, en ese modo, el agente lee y escribe archivos solo en sus carpetas, busca en la web y habla con sus compañeros, pero no ejecuta comandos.
- **«Acceso total» le da la terminal sobre todo tu PC**, con tus archivos y tus sesiones abiertas, y también permisos de administrador si Windows no te pide confirmarlos (UAC). En tu equipo personal, evítalo.
- **Codex** tiene su propio aislamiento en Windows. Compruébalo antes de darle tareas delicadas.
- **Para el teléfono**, instala Tailscale para Windows y ejecuta `tailscale serve --bg 8787` en una ventana de PowerShell como administrador.

## Uso

- **Crear un agente**: botón **+**. Elige el proveedor, el modelo (o «Predeterminado»), el esfuerzo y el acceso.
- **Escribir**: en el computador, Enter envía y Mayús+Enter hace un salto de línea. En el teléfono se envía con el botón.
- **Cola**: si el agente está ocupado, verás «N mensajes esperando turno». Desde ahí puedes quitar mensajes. En el menú ⋯ puedes pausar la cola, empezar de cero, editar o eliminar el agente. «Detener» corta el turno en curso.
- **Equipo**: pídele a un agente que consulte a otro, por ejemplo: «Pídele a Beto que revise esto». En su chat verás «Enviado a Beto» y después «Respuesta de Beto».
- **Carpetas**: cada agente trabaja en `~/.cuadrilla/agentes/<nombre>`, y todos comparten `~/.cuadrilla/compartida`.
- **Preguntas**: cuando un agente necesita que elijas, verás una tarjeta con opciones (A, B, C…). La recomendada lleva una etiqueta. Al tocar una, el agente sigue con tu respuesta.
- **Rutinas**: botón del reloj en la barra lateral, o pídeselo a un agente («todos los días a las 9, revisa…»). Puedes pausarlas, ejecutarlas al momento o borrarlas. Cada agente tiene hasta 20.
- **Proyectos**: al crear o editar un agente, escribe un proyecto para agruparlo en la barra lateral.
- **Voz**: el micrófono dicta en el cuadro de texto. Con el cuadro vacío, el botón morado graba y envía al terminar. El dictado usa el reconocimiento de voz del navegador, que en Edge y Chrome procesa el audio en los servidores de Microsoft o Google.
- **Adjuntos**: clip, pegar o arrastrar. Hasta 25 MB por archivo; se guardan en `adjuntos/` dentro de la carpeta del agente.
- **Probar sin IA**: con el proveedor Demo, una línea `@Nombre: texto` envía `texto` a ese compañero, `/equipo` lista a los compañeros, `/lento` responde despacio (para probar «Detener»), `/pregunta ¿Texto? | A | B` muestra una tarjeta de opciones y `/rutina 09:00 Nombre` crea una rutina.

## Configuración

Se configura con variables de entorno, en `/etc/cuadrilla.env` si usas systemd.

| Variable | Por defecto | Para qué sirve |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Clave de API para los agentes de Claude. |
| `CUADRILLA_HOST` | `127.0.0.1` | Dirección donde escucha. No la cambies si usas `tailscale serve`. |
| `CUADRILLA_PORT` | `8787` | Puerto. |
| `CUADRILLA_DATA_DIR` | `~/.cuadrilla` | Base de datos y carpetas de los agentes. |
| `CUADRILLA_WORKSPACES_DIR` | `<datos>/agentes` | Carpetas de trabajo de los agentes. |
| `CUADRILLA_SHARED_DIR` | `<datos>/compartida` | Carpeta compartida por el equipo. |
| `CUADRILLA_MAX_HOPS` | `6` | Máximo de reenvíos seguidos entre agentes. |
| `CUADRILLA_CODEX_BIN` | `codex` | Ruta del ejecutable de Codex. |
| `CUADRILLA_CLAUDE_BIN` | — | Ruta a un `claude` propio. Si no la indicas, se usa el que trae el SDK. |
| `CUADRILLA_PLAYWRIGHT` | `0` | `1` da a los agentes de Claude un navegador sin ventana (Playwright MCP). |
| `CUADRILLA_DETECT` | `1` | `0` desactiva la comprobación de proveedores al arrancar. |
| `CUADRILLA_SESSION_DAYS` | `30` | Días que dura la sesión en cada dispositivo. |
| `CUADRILLA_SECURE_COOKIES` | `auto` | `auto` marca la cookie como `Secure` cuando llega por HTTPS (Tailscale). |
| `CUADRILLA_PASSWORD` | — | Contraseña por variable de entorno. Solo se usa si no creaste una con `npm run password`. |
| `CUADRILLA_CONTROL_TOKEN` | — | La pone `Cuadrilla.exe` al arrancar el servidor (mínimo 32 caracteres) para entrar sin contraseña y cerrarlo con calma. Solo funciona desde el mismo equipo y los agentes no la heredan. No hace falta configurarla. |

## Actualizar

```bash
sudo -iu cuadrilla
cd ~/cuadrilla && git pull && npm ci && npm run build
exit
sudo systemctl restart cuadrilla
```

## Respaldo

Todo vive en `~/.cuadrilla`: la base de datos `cuadrilla.db` y las carpetas de los agentes. Para respaldar la base sin detener la app: `sqlite3 ~/.cuadrilla/cuadrilla.db ".backup respaldo.db"`.

## Solución de problemas

- **«El modo solo su carpeta necesita el sandbox…»**: instala `bubblewrap` y `socat`. Si aun así falla (algunas versiones de Ubuntu restringen los espacios de nombres de usuario), revisa la documentación de sandbox de Claude Code o dale acceso total a ese agente, solo en una máquina dedicada.
- **Codex «sin sesión»**: ejecuta `codex login --device-auth` como el usuario `cuadrilla` y pulsa «Volver a comprobar» en Ajustes.
- **Olvidé la contraseña**: ejecuta `npm run password` en el servidor. Eso cierra las sesiones abiertas.

## Desarrollo

```bash
npm ci
npm test        # compila y corre las pruebas
```

Las pruebas usan el proveedor Demo y simulaciones del SDK de Claude y del `codex app-server`, así que no gastan créditos. Cubren la cola, los mensajes entre agentes, el límite de reenvíos, la interrupción, el reinicio, el login, la protección CSRF, los eventos en vivo, las preguntas con opciones, las rutinas y sus horarios, los adjuntos y el control del lanzador de escritorio.

```
src/
  server.ts            arranque y apagado
  app.ts               API HTTP, eventos en vivo (SSE) y archivos estáticos
  auth.ts              contraseña (scrypt), sesiones y freno de intentos
  service.ts           orquestador: colas, hilos, mensajes entre agentes
  db.ts                SQLite (node:sqlite)
  instructions.ts      instrucciones de sistema de cada agente
  team.ts              herramientas del equipo: mensajes, preguntas y rutinas
  schedule.ts          horarios de las rutinas
  version.ts           versión de la app
  providers/           Claude (Agent SDK), Codex (app-server), Demo, detección
  cli/password.ts      npm run password
public/                interfaz web (sin dependencias ni compilación)
scripts/windows/       Cuadrilla.exe: ventana propia e icono en la bandeja (C#)
deploy/                servicio de systemd y plantilla de entorno
test/                  pruebas (node:test)
```

## Estado y límites conocidos

- Versión 0.2.0. Se probó con el proveedor Demo y con simulaciones de Claude y Codex. **Falta la primera prueba con tus cuentas reales**: hazla con un agente en «Solo su carpeta».
- Un solo usuario y sin notificaciones push por ahora.
- Las preguntas con opciones terminan el turno del agente: tu respuesta le llega como un mensaje nuevo.
- Las rutinas solo corren con Cuadrilla abierta (en Windows, basta con el icono de la bandeja).

## Licencias

- El código propio de Cuadrilla es privado.
- Algunas partes derivan de **OpenBot v0.1.11** (Copyright 2026 Norbert Bodziony), con licencia Apache 2.0. Cada archivo derivado lo indica al inicio. Ver [NOTICE](NOTICE) y [licenses/OPENBOT-APACHE-2.0.txt](licenses/OPENBOT-APACHE-2.0.txt). Las versiones posteriores de OpenBot usan otra licencia y no se usaron.
- Dependencias: ver [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
