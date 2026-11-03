# ClosedBot

Tu equipo personal de agentes de IA (hasta la versión 0.2 se llamaba Cuadrilla). Cada agente tiene nombre, rol e instrucciones, trabaja con **Claude**, **Codex**, **Gemini** o **Grok** en su propia carpeta, y puede pedirles ayuda a sus compañeros. Lo manejas como una app de escritorio en Windows (ventana propia e icono en la bandeja), desde el navegador o desde el teléfono, como una app instalada.

Está inspirada en [OpenBot](https://openbot.run/) y reutiliza partes de su versión 0.1.11, publicada con licencia Apache 2.0 (ver [Licencias](#licencias)).

## Qué hace

- **Claude Bot, el bot principal**: va fijo arriba de la barra lateral. Le cuentas qué quieres lograr y arma el equipo de agentes que lo hará: crea cada agente con su nombre, rol e instrucciones, los agrupa en un proyecto, le pasa el primer encargo al líder y te cuenta cómo va. También ajusta equipos que ya existen (rol, instrucciones, proyecto o modelo). No elimina agentes ni cambia sus permisos, y no se puede eliminar.
- **Varios agentes**, cada uno con su proveedor (Claude, Codex, Gemini, Grok o Demo), modelo, nivel de esfuerzo y nivel de acceso.
- **Canales**: una conversación con varios agentes a la vez. El encargado del canal responde lo que no nombra a nadie y reparte el trabajo; con `@Nombre` le hablas a un agente en particular y con `@todos` a todos. Se crean con clic derecho en la barra lateral → «Nuevo canal». Los eliminados quedan en «Canales eliminados», desde donde se restauran o se borran para siempre.
- **Cola por agente**: si le escribes mientras trabaja, el mensaje espera su turno. Puedes quitar mensajes de la cola, pausarla o detener el turno en curso.
- **Trabajo en equipo**: los agentes se escriben entre sí con las herramientas `list_agents` y `send_message`. Si un compañero termina sin contestar, su resultado vuelve solo a quien se lo pidió. Hay un límite de reenvíos seguidos (6 por defecto) para cortar bucles.
- **Respuestas en vivo**, con el historial guardado en SQLite. Cada agente retoma su conversación aunque reinicies el servidor.
- **Preguntas con opciones**: un agente puede preguntarte algo con una tarjeta de 2 a 4 opciones (con una recomendada). Tocas una y tu respuesta le llega como un mensaje nuevo.
- **Rutinas**: tareas que se repiten solas, a horas fijas (por ejemplo, de lunes a viernes a las 08:30) o cada cierto tiempo (desde 15 minutos). Las creas tú o se las pides a un agente. Solo corren mientras ClosedBot está abierta; si una se atrasa más de 2 horas, se salta y queda el aviso.
- **Lista de agentes como en una app de chat**: agrupados en secciones, con su último mensaje y un punto en los que tienen novedades. Clic derecho (o mantener presionado en el celular) en un agente: fijar, mover a otra sección, marcar como no leído, cambiar nombre, ocultar y eliminar. Clic derecho en el fondo de la lista: nuevo agente, nueva sección y marcar todo como leído.
- **Crear un agente en un paso**: el **+** pide solo el nombre, una figura y un color. El agente nuevo te saluda y te pregunta para qué lo quieres. Los que arma Claude Bot no saludan.
- **Ficha de cada agente** (tocando su nombre arriba del chat): *Detalles* con sus rutinas y el chat de voz, *Biblioteca* con los archivos de su carpeta y de la compartida, y *Computadora* con sus carpetas y su nivel de acceso.
- **Respuestas en voz alta**: cada agente tiene su voz, velocidad e idioma. Solo usa voces naturales, que suenan casi humanas y son gratis (las «Online (Natural)» de Edge); las voces robóticas no se usan. Lee solo sus respuestas si lo activas, o cuando le hablas con el botón morado.
- **Uso del plan de Claude**: un anillo junto a Ajustes muestra el porcentaje semanal. Al tocarlo se ven también las 5 horas y cuánto falta para que se reinicien. Es el uso de toda tu cuenta.
- **Dictado por voz y adjuntos**: el micrófono escribe lo que dices. En el PC se reconoce en el propio equipo, sin internet (el modelo se descarga una vez); también puede usar el servicio de voz del navegador. Puedes adjuntar archivos, que quedan en la carpeta del agente.
- **App instalable** (PWA) en Android y iPhone, a través de tu red privada de Tailscale.
- **Conexión con tu cuenta**: en Ajustes, «Iniciar sesión con Claude» abre el navegador para que entres con tu cuenta de Claude, como en OpenBot. No hace falta una clave de API.
- **Dos niveles de acceso**:
  - *Solo su carpeta* (por defecto): el agente escribe en su carpeta y en la carpeta compartida, y sus comandos corren dentro de un sandbox.
  - *Acceso total*: comandos y archivos de toda la máquina, sin pedir permiso. Úsalo solo en una máquina dedicada.
  - En Ajustes, **«Acceso total para todos»** se lo da a todos los agentes a la vez, incluidos los nuevos. Al apagarlo, cada agente vuelve a su propio nivel. Desde la consola: `npm run access -- total` o `npm run access -- carpeta`.
- **Los conectores de tu cuenta de Claude quedan fuera.** Los agentes entran con tu cuenta, pero no cargan los conectores que tengas en claude.ai (servidores, bancos, brókeres), ni siquiera con acceso total. ClosedBot se los apaga con `ENABLE_CLAUDEAI_MCP_SERVERS=false` y `disableClaudeAiConnectors`.

## Antes de instalar: seguridad

- **Instálala en una máquina dedicada** (una VM o VPS aparte), nunca en el servidor de Sider4 ni donde guardes credenciales de bancos, exchanges o bots. Los agentes ejecutan comandos de verdad.
- **No la expongas a Internet.** Por defecto solo escucha en `127.0.0.1`. Al teléfono llega por Tailscale, que es una red privada entre tus dispositivos.
- El acceso pide una contraseña. La sesión se guarda en una cookie `HttpOnly`, y el login se bloquea tras 10 intentos fallidos en 15 minutos.
- Cada mensaje a Claude o a Codex consume tu saldo de API o tu plan. El proveedor **Demo** no usa IA y sirve para probar la app gratis.

## Requisitos

- Linux (probado pensando en Ubuntu 22.04 o 24.04), **Node.js 22.13 o superior** y `git`.
- **Claude**: tu cuenta de Claude (plan Pro o Max). Inicias sesión desde la app (ver [Conectar Claude](#conectar-claude)). Si prefieres, también sirve una clave de API de Anthropic (`ANTHROPIC_API_KEY`).
- **Codex** (opcional): `npm install -g @openai/codex`. Luego inicias sesión desde Ajustes («Iniciar sesión con ChatGPT») o con `codex login --device-auth`.
- **Modo «Solo su carpeta» con Claude**: el sandbox de Claude Code necesita `bubblewrap` y `socat`.
- **Tailscale**, en el servidor y en el teléfono.

## Instalación paso a paso

Todos los comandos van en el servidor dedicado.

```bash
# 1. Node.js 22, git y el sandbox
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git bubblewrap socat

# 2. Un usuario solo para ClosedBot (sin sudo)
sudo adduser --disabled-password --gecos "" closedbot
sudo -iu closedbot

# 3. Descargar el código. El repo es privado, así que primero inicia sesión en GitHub.
#    Puedes usar la CLI de GitHub (gh auth login) o una "deploy key" de solo lectura.
gh auth login
gh repo clone Hysko4/ClosedBot closedbot
cd closedbot
npm ci
npm run build

# 4. Crear la contraseña de acceso
npm run password                 # te la pide dos veces
# o bien:  npm run password -- --generate   (genera una segura y la muestra una vez)

# 5. (Opcional) Iniciar sesión en Codex como este usuario
codex login --device-auth

# 6. Probar a mano
npm start
```

Después entra a la app y conecta Claude desde Ajustes (ver [Conectar Claude](#conectar-claude)).

Para verla desde tu computador antes de configurar Tailscale, usa un túnel SSH: `ssh -L 8787:127.0.0.1:8787 usuario@servidor`, y luego abre <http://127.0.0.1:8787>.

### Dejarla funcionando siempre (systemd)

```bash
# como un usuario con sudo (no como "closedbot")
sudo cp /home/closedbot/closedbot/deploy/closedbot.service /etc/systemd/system/
sudo install -m 600 /home/closedbot/closedbot/deploy/closedbot.env.example /etc/closedbot.env
sudo nano /etc/closedbot.env          # opcional: puerto, carpeta de datos…
sudo systemctl daemon-reload
sudo systemctl enable --now closedbot
journalctl -u closedbot -f            # ver registros
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
2. Descarga el código en una carpeta tuya (por ejemplo, `C:\Users\<tú>\ClosedBot`).
3. Abre **`Instalar-escritorio.cmd`** con doble clic. Instala las dependencias, compila, crea el programa `ClosedBot.exe`, crea una contraseña si no tenías (queda en `CONTRASENA-CLOSEDBOT.txt`) y pone el acceso directo **ClosedBot** en el escritorio y en el menú Inicio.
4. En la app, abre Ajustes y pulsa **«Iniciar sesión con Claude»** (ver [Conectar Claude](#conectar-claude)).

Cómo se usa:

- El acceso directo abre ClosedBot en **su propia ventana**, sin barras del navegador y sin pedir la contraseña (entra con un código de un solo uso). Usa Edge, o Chrome si no hay Edge, con un perfil solo para ClosedBot.
- Queda un **icono en la bandeja**, junto al reloj. Clic: abre la ventana. Clic derecho: *Iniciar con Windows*, *Ver registro* y *Salir*.
- Si cierras la ventana, ClosedBot sigue funcionando en segundo plano para tus rutinas. Para cerrarla del todo, usa *Salir*.
- Arranca con Windows (sin abrir la ventana) desde la primera instalación. Lo cambias en el menú de la bandeja.
- El registro está en `%LOCALAPPDATA%\ClosedBot\closedbot.log`. Si el servidor se cae, el programa lo vuelve a arrancar (hasta 3 veces en 15 minutos) y te avisa si no puede.
- **Actualizar**: reemplaza el código por la versión nueva (tus datos están en `C:\Users\<tú>\.closedbot` y no se tocan) y vuelve a abrir `Instalar-escritorio.cmd`.
- **Desde la versión llamada Cuadrilla**: el instalador cierra `Cuadrilla.exe`, cambia sus accesos directos por los de ClosedBot (respeta si habías apagado el inicio con Windows) y borra `%LOCALAPPDATA%\Cuadrilla`. Al arrancar, la app mueve tus datos de `.cuadrilla` a `.closedbot`. El archivo `CONTRASENA-CUADRILLA.txt` pasa a llamarse `CONTRASENA-CLOSEDBOT.txt`.
- **Instalar o actualizar en un clic**: `scripts\windows\Instalar-ClosedBot.cmd` descarga o actualiza el código en `%USERPROFILE%\ClosedBot`, copia la contraseña de la carpeta `cuadrilla`, abre el instalador y, cuando ClosedBot responde, manda esa carpeta vieja a la papelera. Se puede copiar al Escritorio y abrir con doble clic.
- **Quitar los accesos directos**: `ClosedBot.exe /desinstalar`.

Si prefieres la consola: `npm ci`, `npm run build`, `npm run password -- --generate` y `npm start`, y abre <http://127.0.0.1:8787>.

Diferencias en Windows:

- **Claude en «Solo su carpeta» no tiene terminal.** Claude Code no puede encerrar los comandos en una carpeta en Windows. Por eso, en ese modo, el agente lee y escribe archivos solo en sus carpetas, busca en la web y habla con sus compañeros, pero no ejecuta comandos.
- **«Acceso total» le da la terminal sobre todo tu PC**, con tus archivos y tus sesiones abiertas, y también permisos de administrador si Windows no te pide confirmarlos (UAC). En tu equipo personal, evítalo.
- **Instalar con acceso total para todos**: `Instalar-escritorio.cmd acceso-total` (o `set "OPCIONES=acceso-total"` en `Instalar-ClosedBot.cmd`). Lo activa con la app cerrada, salvo que ya lo hayas elegido en Ajustes: si lo apagaste ahí, el instalador no lo vuelve a encender.
- **Codex** tiene su propio aislamiento en Windows. Compruébalo antes de darle tareas delicadas.
- **Para el teléfono**, instala Tailscale para Windows y ejecuta `tailscale serve --bg 8787` en una ventana de PowerShell como administrador.

## Conectar Claude

Como en OpenBot, los agentes se conectan **iniciando sesión con tu cuenta**, sin clave de API:

1. Abre **Ajustes** y pulsa **«Iniciar sesión con Claude»** (o el botón de la pantalla de inicio).
2. La app ejecuta el inicio de sesión de Claude Code (`claude auth login --claudeai`), que abre tu navegador en el equipo donde corre la app. Entra con tu cuenta de Claude y autoriza.
3. Al volver, Ajustes muestra «Conectado como tu@correo · plan …». Ya puedes crear agentes con Claude.

Si el navegador no se abre (o usas la app desde otro equipo), Ajustes muestra un enlace: ábrelo, entra con tu cuenta y pega en la app el código que te muestra la página. El intento se cancela solo a los 10 minutos.

- La sesión de los agentes se guarda **aparte**, en `<datos>/claude`: iniciar o cerrar sesión en la app no cambia el Claude Code que uses por tu cuenta en ese equipo.
- **«Cerrar sesión de Claude»** (en Ajustes) borra solo esa sesión.
- El uso de los agentes cuenta para los límites de tu plan de Claude.
- **Términos de Anthropic**: este inicio de sesión es para tu uso personal. Anthropic no permite ofrecer el login de claude.ai en apps para otras personas; para eso hace falta una clave de API.
- Si el servidor tiene `ANTHROPIC_API_KEY` (o `CLAUDE_CODE_OAUTH_TOKEN`), esa credencial manda y no se muestra el botón.
- Codex funciona igual con «Iniciar sesión con ChatGPT» (ejecuta `codex login`), si Codex está instalado.

## Conectar Codex, Gemini y Grok

En **Ajustes → Proveedores**, cada uno tiene dos botones, como en OpenBot:

1. **«Instalar»**, si no está en el equipo: Codex (`@openai/codex`) se instala con npm para tu usuario; Grok, con su instalador oficial (`https://x.ai/cli`), y Gemini descarga Antigravity de Google (ver abajo).
2. **«Iniciar sesión»**: Codex con tu cuenta de ChatGPT, Gemini con tu cuenta de Google y Grok con tu cuenta de X/xAI. Se abre el navegador; al volver, el proveedor queda «Conectado». Si el intento falla, la tarjeta muestra lo que respondió el proveedor.

ClosedBot los busca en el PATH, en las carpetas de npm, en la app de Codex, en la carpeta del instalador de Grok y en la copia de OpenBot. Si están en otro lugar, indica la ruta con `CLOSEDBOT_CODEX_BIN`, `CLOSEDBOT_GEMINI_BIN` o `CLOSEDBOT_GROK_BIN`. Gemini y Grok trabajan por ACP (Agent Client Protocol) y usan las mismas herramientas de equipo que los demás (`list_agents`, `send_message`). Cada proveedor recibe solo sus propias claves de entorno.

**Gemini usa Antigravity, como OpenBot.** Google ya no acepta Gemini CLI con las cuentas personales: al iniciar sesión responde «This client is no longer supported for Gemini Code Assist for individuals». Por eso ClosedBot habla con el servidor ACP de Antigravity (`agy_acp_server`), el programa oficial de Google que publica el registro de ACP:

- Si OpenBot ya lo descargó, ClosedBot usa esa copia. Si no, «Instalar» baja el `.zip` oficial de `dl.google.com` (versión 1.4.5; ocupa unos 200 MB), comprueba su SHA-256 publicado y lo deja en `<datos>/programas/antigravity`.
- La sesión con Google queda en `~/.gemini/antigravity-acp/acp_token.json` y es la misma de OpenBot: si ya entraste allí, Gemini aparece conectado sin volver a entrar. También sirve `GEMINI_API_KEY`.
- Cada vez que arranca, Antigravity descomprime unos 300 MB en una carpeta temporal. ClosedBot le da una propia en `<datos>/tmp` y la borra al cerrarlo (y al abrir la app, si quedó alguna).
- Si le falta la sesión durante un chat, ClosedBot lo corta enseguida y te pide entrar desde Ajustes, en vez de esperar a que se abra el navegador.

## Uso

- **Armar un equipo**: toca a Claude Bot (arriba en la barra lateral) y cuéntale qué necesitas, por ejemplo: «Arma un equipo para crear un videojuego de plataformas». Cada agente que crea aparece en la lista, dentro de su proyecto y con un punto azul. En su chat verás «Creó a …»; al tocar el nombre se abre la conversación de ese agente. En «Editar a Claude Bot» puedes dejarle tus preferencias para armar equipos (por ejemplo, «máximo 3 agentes» o «usa Sonnet para tareas simples»).
- **Crear un agente**: botón **+**. Ponle nombre y elige figura y color. Usa Claude si tienes sesión (si no, Demo). El rol, las instrucciones, el modelo, el esfuerzo y el acceso se cambian en su ficha → «Instrucciones y modelo».
- **Escribir**: en el computador, Enter envía y Mayús+Enter hace un salto de línea. En el teléfono se envía con el botón.
- **Cola**: si el agente está ocupado, verás «N mensajes esperando turno». Desde ahí puedes quitar mensajes. En su ficha (toca su nombre arriba) puedes pausar la cola, empezar de cero o eliminarlo. «Detener» corta el turno en curso.
- **Equipo**: pídele a un agente que consulte a otro, por ejemplo: «Pídele a Beto que revise esto». En su chat verás «Enviado a Beto» y después «Respuesta de Beto».
- **Carpetas**: cada agente trabaja en `~/.closedbot/agentes/<nombre>`, y todos comparten `~/.closedbot/compartida`.
- **Preguntas**: cuando un agente necesita que elijas, verás una tarjeta con opciones (A, B, C…). La recomendada lleva una etiqueta. Al tocar una, el agente sigue con tu respuesta.
- **Rutinas**: botón del reloj en la barra lateral, o pídeselo a un agente («todos los días a las 9, revisa…»). Puedes pausarlas, ejecutarlas al momento o borrarlas. Cada agente tiene hasta 20.
- **Secciones**: agrupan a los agentes en la barra lateral. Créalas con clic derecho en el fondo de la lista y mueve agentes con «Mover a». Al eliminar una sección, sus agentes pasan a «Sin asignar». Claude Bot pone en la misma sección a los agentes de un equipo.
- **Ocultos y fijados**: los fijados van arriba; los ocultos, plegados al final de la lista («Ocultos») y en la búsqueda.
- **Voz**: el micrófono dicta en el cuadro de texto. Con el cuadro vacío, el botón morado graba y envía al terminar, y la respuesta se lee en voz alta.
  - *Dictado*: en el PC, ClosedBot reconoce la voz en el propio equipo con Parakeet v3 (sherpa-onnx). La primera vez pide descargar el modelo (unos 490 MB, a `<datos>/voz`); después funciona sin internet y tu voz no sale del equipo. En **Ajustes → Dictado por voz** puedes elegir en su lugar el servicio de voz del navegador, que manda el audio a Microsoft o Google.
  - *Lectura*: en la ficha del agente, *Chat de voz* elige la voz (agrupadas por país), la velocidad y el idioma, y si lee siempre sus respuestas. Bajo cada respuesta hay un botón para escucharla.
  - *Solo voces naturales*: las «Online (Natural)» de Edge (por ejemplo, Catalina o Lorenzo, de Chile) y, en iPhone o Mac, las «Mejorada» o «Premium». Son gratis y las de Edge usan internet. Las voces robóticas del sistema no se usan: si no hay naturales, ClosedBot avisa dónde conseguirlas en vez de leer con una robótica. La app de escritorio ya abre ClosedBot en Edge. **Ajustes → Voces para leer en voz alta** muestra cuántas hay.
- **Biblioteca**: en la ficha del agente se ven y descargan los archivos de su carpeta y de la compartida. «Subir archivo» los deja en `adjuntos/`. Los archivos se abren en una pestaña aparte, sin permisos sobre la app.
- **Uso del plan**: lo informa Claude Code (como `/usage`) cada 10 minutos y tras cada turno. Esa lectura es una función experimental del SDK de Claude: si cambia, el anillo desaparece y la app sigue igual.
- **Adjuntos**: clip, pegar o arrastrar. Hasta 25 MB por archivo; se guardan en `adjuntos/` dentro de la carpeta del agente.
- **Probar sin IA**: con el proveedor Demo, una línea `@Nombre: texto` envía `texto` a ese compañero, `/equipo` lista a los compañeros, `/lento` responde despacio (para probar «Detener»), `/pregunta ¿Texto? | A | B` muestra una tarjeta de opciones y `/rutina 09:00 Nombre` crea una rutina. Si Claude Bot usa la demo, `/crear Nombre | Rol | Proyecto` crea un agente y `/ajustar Nombre | Rol nuevo` le cambia el rol.

## Configuración

Se configura con variables de entorno, en `/etc/closedbot.env` si usas systemd. Las de antes del cambio de nombre (`CUADRILLA_*`) siguen funcionando.

| Variable | Por defecto | Para qué sirve |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Opcional: clave de API para Claude, en vez de iniciar sesión con tu cuenta. |
| `CLOSEDBOT_HOST` | `127.0.0.1` | Dirección donde escucha. No la cambies si usas `tailscale serve`. |
| `CLOSEDBOT_PORT` | `8787` | Puerto. |
| `CLOSEDBOT_DATA_DIR` | `~/.closedbot` | Base de datos y carpetas de los agentes. Si solo existe `~/.cuadrilla`, se mueve a `~/.closedbot` al arrancar. |
| `CLOSEDBOT_WORKSPACES_DIR` | `<datos>/agentes` | Carpetas de trabajo de los agentes. |
| `CLOSEDBOT_SHARED_DIR` | `<datos>/compartida` | Carpeta compartida por el equipo. |
| `CLOSEDBOT_CLAUDE_CONFIG_DIR` | `<datos>/claude` | Sesión de Claude Code de los agentes, aparte de la tuya. |
| `CLOSEDBOT_MAX_HOPS` | `6` | Máximo de reenvíos seguidos entre agentes. |
| `CLOSEDBOT_CODEX_BIN` | `codex` | Ruta del ejecutable de Codex. |
| `CLOSEDBOT_GEMINI_BIN` | — | Ruta de `agy_acp_server` (Antigravity, el programa de Gemini), si no está donde ClosedBot lo busca. |
| `CLOSEDBOT_GROK_BIN` | — | Ruta de Grok CLI, si no está donde ClosedBot la busca. |
| `CLOSEDBOT_CLAUDE_BIN` | — | Ruta a un `claude` propio. Si no la indicas, se usa el que trae el SDK. |
| `CLOSEDBOT_PLAYWRIGHT` | `0` | `1` da a los agentes de Claude un navegador sin ventana (Playwright MCP). |
| `CLOSEDBOT_DETECT` | `1` | `0` desactiva la comprobación de proveedores al arrancar. |
| `CLOSEDBOT_SESSION_DAYS` | `30` | Días que dura la sesión en cada dispositivo. |
| `CLOSEDBOT_SECURE_COOKIES` | `auto` | `auto` marca la cookie como `Secure` cuando llega por HTTPS (Tailscale). |
| `CLOSEDBOT_PASSWORD` | — | Contraseña por variable de entorno. Solo se usa si no creaste una con `npm run password`. |
| `CLOSEDBOT_CONTROL_TOKEN` | — | La pone `ClosedBot.exe` al arrancar el servidor (mínimo 32 caracteres) para entrar sin contraseña y cerrarlo con calma. Solo funciona desde el mismo equipo y los agentes no la heredan. No hace falta configurarla. |

## Actualizar

```bash
sudo -iu closedbot
cd ~/closedbot && git pull && npm ci && npm run build
exit
sudo systemctl restart closedbot
```

## Respaldo

Todo vive en `~/.closedbot`: la base de datos `closedbot.db` (en las instalaciones de antes del cambio de nombre conserva su nombre, `cuadrilla.db`), las carpetas de los agentes y la sesión de Claude. Para respaldar la base sin detener la app: `sqlite3 ~/.closedbot/closedbot.db ".backup respaldo.db"`.

## Solución de problemas

- **«El modo solo su carpeta necesita el sandbox…»**: instala `bubblewrap` y `socat`. Si aun así falla (algunas versiones de Ubuntu restringen los espacios de nombres de usuario), revisa la documentación de sandbox de Claude Code o dale acceso total a ese agente, solo en una máquina dedicada.
- **Claude «sin sesión»**: Ajustes → «Iniciar sesión con Claude». Si el navegador no se abre, usa el enlace que aparece ahí y pega el código. Si falla, Ajustes muestra el motivo y el registro guarda el detalle.
- **Codex «sin sesión»**: Ajustes → «Iniciar sesión con ChatGPT», o `codex login --device-auth` como el usuario `closedbot`, y luego «Volver a comprobar».
- **Olvidé la contraseña**: ejecuta `npm run password` en el servidor. Eso cierra las sesiones abiertas.

## Desarrollo

```bash
npm ci
npm test        # compila y corre las pruebas
```

Las pruebas usan el proveedor Demo y simulaciones del SDK de Claude y del `codex app-server`, así que no gastan créditos. Cubren a Claude Bot (crear, proteger y sus herramientas para armar equipos), la cola, los mensajes entre agentes, el límite de reenvíos, la interrupción, el reinicio, el login, la protección CSRF, los eventos en vivo, las preguntas con opciones, las rutinas y sus horarios, los adjuntos, el control del lanzador de escritorio, el inicio de sesión con la cuenta (con un Claude Code falso) y la mudanza de `~/.cuadrilla` a `~/.closedbot`.

```
src/
  server.ts            arranque y apagado
  app.ts               API HTTP, eventos en vivo (SSE) y archivos estáticos
  auth.ts              contraseña (scrypt), sesiones y freno de intentos
  service.ts           orquestador: colas, hilos, mensajes entre agentes
  db.ts                SQLite (node:sqlite)
  instructions.ts      instrucciones de sistema de cada agente
  team.ts              herramientas del equipo: mensajes, preguntas, rutinas y las de Claude Bot
  schedule.ts          horarios de las rutinas
  version.ts           versión de la app
  providers/           Claude (Agent SDK), Codex (app-server), Demo, detección
  cli/password.ts      npm run password
  cli/access.ts        npm run access (acceso total para todos, sin abrir la app)
public/                interfaz web (sin dependencias ni compilación)
scripts/windows/       ClosedBot.exe: ventana propia e icono en la bandeja (C#)
deploy/                servicio de systemd y plantilla de entorno
test/                  pruebas (node:test)
```

## Estado y límites conocidos

- Versión 0.6.1. Se probó con el proveedor Demo y con simulaciones de Claude, Codex, Gemini (Antigravity) y Grok. **Falta la primera prueba con tus cuentas reales**: hazla con un agente en «Solo su carpeta».
- Un solo usuario y sin notificaciones push por ahora.
- Claude Bot crea hasta 8 agentes por pedido y deja de crear cuando ya hay 60 agentes en total.
- Las preguntas con opciones terminan el turno del agente: tu respuesta le llega como un mensaje nuevo.
- Las rutinas solo corren con ClosedBot abierta (en Windows, basta con el icono de la bandeja).

## Licencias

- El código propio de ClosedBot es privado.
- Algunas partes derivan de **OpenBot v0.1.11** (Copyright 2026 Norbert Bodziony), con licencia Apache 2.0. Cada archivo derivado lo indica al inicio. Ver [NOTICE](NOTICE) y [licenses/OPENBOT-APACHE-2.0.txt](licenses/OPENBOT-APACHE-2.0.txt). Las versiones posteriores de OpenBot usan otra licencia y su código no se usó: de ellas solo se tomó la idea de conectar los proveedores con el inicio de sesión de su propio CLI.
- Dependencias: ver [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
