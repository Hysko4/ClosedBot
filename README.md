# ClosedBot

Tu equipo personal de agentes de IA (hasta la versión 0.2 se llamaba Cuadrilla). Cada agente tiene nombre, rol e instrucciones, trabaja con **Claude**, **Codex**, **Gemini** o **Grok** en su propia carpeta, y puede pedirles ayuda a sus compañeros. Lo manejas como una app de escritorio en Windows (ventana propia e icono en la bandeja), desde el navegador o desde el teléfono, como una app instalada.

Está inspirada en [OpenBot](https://openbot.run/) y reutiliza partes de su versión 0.1.11, publicada con licencia Apache 2.0 (ver [Licencias](#licencias)).

## Qué hace

- **Claude Bot, el bot principal**: va fijo arriba de la barra lateral. Le cuentas qué quieres lograr y él decide cómo se hace: usa los agentes que ya tienes o arma un equipo (cada agente con su nombre, rol, instrucciones y el proveedor que mejor hace su parte, agrupados en un proyecto y con su canal), le da a cada uno su parte y te cuenta cómo va. También ajusta equipos que ya existen (rol, instrucciones, proyecto, proveedor o modelo) y les crea el canal si no lo tienen. Antes de cada mensaje se entera de lo que cambiaste tú en agentes, secciones y canales (por ejemplo, si eliminaste un equipo), así no se queda con lo que recordaba. Si le pides eliminar agentes (uno, varios o un equipo entero), te deja una tarjeta para confirmar y, al tocar «Eliminar», los elimina; un canal que se queda sin miembros pasa a «Canales eliminados». No cambia los permisos de los agentes y a él no se le puede eliminar.
- **Un solo cerebro**: Claude Bot reparte y los agentes no debaten entre ellos.
  - Ve la ficha completa de cada agente (instrucciones, recuerdos, habilidades y en qué anda), su proveedor y cuánto plan le queda a cada cuenta.
  - Elige el proveedor de cada parte: imágenes con Codex (GPT), código y textos con Claude, y el QA con un proveedor distinto del que hizo el trabajo. Si un agente no puede hacer su parte con el suyo, se lo cambia.
  - Lleva una pizarra del trabajo (objetivo, quién hace qué, en qué orden y dónde queda cada entrega) que les llega a los agentes cuando les escribe.
  - Trabaja en cadena: cada entrega le vuelve sola, la revisa y se la pasa al siguiente, hasta 20 encargos seguidos por pedido.
- **La Oficina**: el botón del edificio, arriba en la barra lateral, muestra a tus equipos como plataformas isométricas de neón, cada una con un escritorio por integrante y un robot por agente. Claude Bot tiene la suya, unida con líneas a la de cada canal; los agentes sin canal van a «Sin grupo», y la plataforma crece con el equipo. Una plataforma con un solo agente toma el color de ese agente; cuando ya son varios, el del equipo. La escena usa todo el espacio: con pocos equipos se agranda y los reparte (también en un monitor vertical); si son muchos, se desplaza hacia abajo. Sobre cada plataforma, una tarjeta muestra el nombre, cuántos agentes son, qué están haciendo y el avance del equipo. El robot que trabaja brilla y escribe, el que te pregunta algo muestra «?», el que está en pausa duerme, y los encargos entre compañeros viajan como luces. En el computador, al tocar un robot su chat se abre abajo y su ficha (modelo, carpetas, instrucciones…) a la derecha, sin salir de la Oficina; en el teléfono se abre su chat. Al tocar la tarjeta de un canal se abre el canal y la de Claude Bot muestra su pizarra. Arrastrando un robot a otra plataforma lo cambias de equipo (en el teléfono, mantenlo presionado y arrástralo), y soltándolo en «Equipo nuevo», que aparece abajo mientras lo arrastras, armas un equipo nuevo con él. «Nuevo agente» y el «+» junto a cada tarjeta crean agentes ahí mismo, y el clic derecho (o mantener presionado) muestra más opciones; en un espacio vacío, «Nuevo equipo» y «Nuevo agente»; en la tarjeta de un equipo, «MCP y habilidades» muestra los MCP conectados y las habilidades del equipo, todo junto y por agente. La primera vez se abre una guía que explica todo; después queda en el «?». Sobre cada robot, una barra muestra cuánto lleva de su tarea (los agentes lo informan con `report_progress` al avanzar); el porcentaje también sale en su fila de la barra lateral.
- **Imágenes**: las que genera un agente de Codex (con el generador de imágenes de tu plan de ChatGPT) se copian solas a la carpeta compartida, en `imagenes/<agente>/`. Se ven en miniatura en su chat y le llegan con su ruta a quien las pidió.
- **Varios agentes**, cada uno con su proveedor (Claude, Codex, Gemini o Grok), modelo, nivel de esfuerzo y nivel de acceso.
- **Canales**: una conversación con varios agentes a la vez. El encargado del canal responde lo que no nombra a nadie y reparte el trabajo; con `@Nombre` le hablas a un agente en particular y con `@todos` a todos. Se crean con clic derecho en la barra lateral → «Nuevo canal». Los eliminados quedan en «Canales eliminados», desde donde se restauran o se borran para siempre.
- **Cola por agente**: si le escribes mientras trabaja, el mensaje espera su turno. Puedes quitar mensajes de la cola, pausarla o detener el turno en curso.
- **Trabajo en equipo**: los agentes se escriben entre sí con las herramientas `list_agents` y `send_message`. Si un compañero termina sin contestar, su resultado vuelve solo a quien se lo pidió. Hay un límite de reenvíos seguidos (6 por defecto) para cortar bucles.
- **Respuestas en vivo**, con el historial guardado en SQLite. Cada agente retoma su conversación aunque reinicies el servidor.
- **Preguntas con opciones**: un agente puede preguntarte algo con una tarjeta de 2 a 4 opciones (con una recomendada). Tocas una y tu respuesta le llega como un mensaje nuevo.
- **Rutinas**: tareas que se repiten solas, a horas fijas (por ejemplo, de lunes a viernes a las 08:30) o cada cierto tiempo (desde 15 minutos). Las creas tú o se las pides a un agente. Solo corren mientras ClosedBot está abierta; si una se atrasa más de 2 horas, se salta y queda el aviso.
- **Lista de agentes como en una app de chat**: agrupados en secciones, con su último mensaje y un punto en los que tienen novedades. Clic derecho (o mantener presionado en el celular) en un agente: fijar, mover a otra sección, marcar como no leído, cambiar nombre, ocultar, seleccionar varios y eliminar. Clic derecho en el fondo de la lista: nuevo agente, nueva sección, marcar todo como leído y seleccionar agentes.
- **Mover o eliminar varios agentes a la vez**: «Seleccionar varios» (o Ctrl+clic y Mayús+clic) marca agentes; la casilla de cada sección marca a todos los suyos y «Todos», a toda la lista. «Mover a» (clic derecho sobre uno de los marcados) los mueve a todos a otra sección, y «Eliminar» los borra con una sola confirmación: al que está trabajando se le detiene el turno, y un canal que se queda sin miembros pasa a «Canales eliminados». Esc o la X terminan la selección. Al eliminar una sección puedes elegir «Solo la sección» (sus agentes pasan a «Sin asignar») o «Con sus agentes» (se borran ellos y su canal, y su plataforma desaparece de la Oficina).
- **Crear un agente en un paso**: el **+** pide solo el nombre, una figura y un color. El agente nuevo te saluda y te pregunta para qué lo quieres. Los que arma Claude Bot no saludan.
- **Ficha de cada agente, como en OpenBot** (tocando su nombre arriba del chat): arriba su figura, nombre, título y descripción (al tocarlos se editan en *Perfil*), y debajo sus ajustes por secciones. Cada fila abre su pantalla, con «Volver a los ajustes»:
  - *Cerebro → Modelo*: proveedor, modelo y razonamiento.
  - *Sabe → Instrucciones*: viven en el archivo `AGENTS.md` de su carpeta. Las editas en la ficha o se las pides al agente («agrega a tus instrucciones…»), y él mismo las cambia. Si las cambió mientras las editabas, ClosedBot te pregunta antes de pisar su versión.
  - *Sabe → Recuerdos*: datos que debe tener presentes. Los de «Siempre se usan» van en cada mensaje; los demás los busca cuando el tema puede tenerlos. Los guardas tú o el agente (cuando le dices «recuerda que…»). Hasta 64 por agente.
  - *Sabe → Habilidades*: procedimientos guardados como carpetas con un `SKILL.md` (en `.agents/skills` o `.claude/skills` de su carpeta). Se crean, editan, apagan o eliminan; el agente ve la lista y lee la que necesita.
  - *Sabe → Archivos*: los de su carpeta y los de la compartida, para abrir, descargar o subir.
  - *Hace → Rutinas* (con «Probar ahora» y su historial: cuándo corrió, si terminó y qué respondió) y *Chat de voz*.
  - *Hace → MCP*: los servidores MCP que tiene conectados, con su estado, de dónde salen y sus herramientas.
  - *Reglas → Carpetas*, *Acceso* (no aparece con «Acceso total para todos» encendido), *Avanzado* (pausar la cola o empezar de cero) y *Avisarme*: toda la actividad, solo cuando te necesite (una pregunta o un error) o nada. Los avisos salen como notificaciones del sistema mientras ClosedBot está abierta, aunque esté minimizada; al tocar uno se abre esa conversación.
- **Respuestas en voz alta**: cada agente tiene su voz, velocidad e idioma. Usa solo las 10 voces de OpenBot (Supertonic 3), que leen en el propio PC, gratis y sin internet. Lee solo sus respuestas si lo activas, o cuando le hablas con el botón morado.
- **Uso del plan de cada cuenta**: un anillo junto a Ajustes muestra el porcentaje semanal de Claude. Al tocarlo se ven también Codex, Grok y Gemini (con sus ventanas, como «5 horas» o «Semanal · Gemini 4 Argon») y cuánto falta para que se reinicien. Es el uso de cada cuenta, también fuera de ClosedBot.
- **Dictado por voz y adjuntos**: el micrófono escribe lo que dices. Elige el motor por sí solo: en el PC reconoce la voz en el propio equipo, sin internet (el modelo se descarga una vez); donde no puede, usa el del navegador. Puedes adjuntar archivos, que quedan en la carpeta del agente.
- **App instalable** (PWA) en Android y iPhone, a través de tu red privada de Tailscale.
- **Conexión con tu cuenta**: en Ajustes, «Iniciar sesión con Claude» abre el navegador para que entres con tu cuenta de Claude, como en OpenBot. No hace falta una clave de API.
- **Dos niveles de acceso**:
  - *Solo su carpeta* (por defecto): el agente escribe en su carpeta y en la carpeta compartida, y sus comandos corren dentro de un sandbox.
  - *Acceso total*: comandos y archivos de toda la máquina, sin pedir permiso. Úsalo solo en una máquina dedicada.
  - En Ajustes, **«Acceso total para todos»** se lo da a todos los agentes a la vez, incluidos los nuevos. Al apagarlo, cada agente vuelve a su propio nivel. Desde la consola: `npm run access -- total` o `npm run access -- carpeta`.
- **Los conectores de tu cuenta de Claude quedan fuera.** Los agentes entran con tu cuenta, pero no cargan los conectores que tengas en claude.ai (servidores, bancos, brókeres), ni siquiera con acceso total. ClosedBot se los apaga con `ENABLE_CLAUDEAI_MCP_SERVERS=false` y `disableClaudeAiConnectors`.

## Modelos locales (Qwen GGUF)

El proveedor opcional **Qwen local** conserva el motor de herramientas y sesiones
del Claude Agent SDK, pero realiza la inferencia en llama.cpp en este PC, sin
usar una cuenta de Claude ni su cuota. Aparece al configurar
`~/.closedbot/local-model.json` y reiniciar ClosedBot:

```json
{
  "model": "qwen3.8-unleashed",
  "baseUrl": "http://127.0.0.1:8089",
  "executable": "C:/Users/tu-usuario/.closedbot/local-model/llama/llama-server.exe",
  "modelPath": "C:/Users/tu-usuario/.closedbot/local-model/Qwen3.8-27B-Unleashed-UD-Q3_K_XL.gguf",
  "chatTemplatePath": "C:/Users/tu-usuario/ClosedBot/scripts/local/qwen-sdk.jinja",
  "contextSize": 32768,
  "gpuLayers": "auto"
}
```

ClosedBot inicia llama.cpp al recibir el primer mensaje local y cierra el
proceso que inició al salir. Si ya existe un servidor con el mismo modelo en
esa dirección, lo reutiliza y lo deja abierto al salir. Puedes omitir
`executable` y `modelPath` juntos para administrar el servidor por tu cuenta.
Solo se permiten direcciones HTTP de loopback, sin claves ni rutas adicionales.
`baseUrl` es la raíz del servidor, sin `/v1`.
La plantilla `scripts/local/qwen-sdk.jinja` conserva la plantilla del GGUF Qwen3.8
Unleashed y reúne los mensajes de sistema del SDK al principio. Esto evita el
error «System message must be at the beginning». Para otro modelo, usa una
plantilla compatible con ese modelo o elimina `chatTemplatePath` si su plantilla
ya admite el formato del SDK.

En la ficha del agente, selecciona **Cerebro → Modelo → Qwen local**. Se
recomienda crear un agente separado para conservar las conversaciones de los
demás proveedores. El historial local del SDK está en
`~/.closedbot/local-model/agent-state`; el registro de carga del modelo, en
`~/.closedbot/local-model/server.log`. Requiere una versión de llama.cpp con
`/v1/messages`, soporte de la arquitectura del GGUF y las DLL de CUDA apropiadas.
La velocidad y la cantidad de capas que caben en GPU dependen de la RAM/VRAM
libres. No descarga ni cambia automáticamente a un modelo en la nube.
Si llama.cpp termina inesperadamente mientras un agente conserva su hilo abierto,
reinicia ClosedBot para volver a cargar el servidor y reanudar esa conversación.

### Varios modelos locales

Para ofrecer varios modelos desde el mismo proveedor, añade `modelsPresetPath`
(ruta absoluta a un INI de presets de llama.cpp) y `models` a `local-model.json`:

```json
{
  "model": "qwen3.8-unleashed",
  "baseUrl": "http://127.0.0.1:8089",
  "executable": "C:/Users/tu-usuario/.closedbot/local-model/llama/llama-server.exe",
  "modelsPresetPath": "C:/Users/tu-usuario/.closedbot/local-model/models.ini",
  "models": [
    { "model": "qwen3.8-unleashed", "displayName": "Qwen 3.8 27B Unleashed" },
    { "model": "qwen3.5-9b-abliterated", "displayName": "Qwen 3.5 9B abliterated Q4_K_M" }
  ]
}
```

Los nombres del catálogo deben coincidir con las secciones del INI y el catálogo
debe incluir `model`, el predeterminado. Cada sección define su GGUF, contexto y
plantilla. Para Qwen3.5-9B se incluye `scripts/local/qwen35-sdk.jinja`.
ClosedBot inicia el router con `--models-max 1`: los agentes eligen su modelo y
llama.cpp gestiona la carga y descarga de memoria. Los modelos auxiliares del
SDK usan el modelo del agente correspondiente. La configuración anterior de un
solo GGUF sigue siendo válida; en modo router `modelPath` no es necesario.

## Antes de instalar: seguridad

- **Instálala en una máquina dedicada** (una VM o VPS aparte), nunca en el servidor de Sider4 ni donde guardes credenciales de bancos, exchanges o bots. Los agentes ejecutan comandos de verdad.
- **No la expongas a Internet.** Por defecto solo escucha en `127.0.0.1`. Al teléfono llega por Tailscale, que es una red privada entre tus dispositivos.
- El acceso pide una contraseña. La sesión se guarda en una cookie `HttpOnly`, y el login se bloquea tras 10 intentos fallidos en 15 minutos.
- Cada mensaje a un agente consume tu saldo de API o el plan de su proveedor.

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
- En la ficha → «Modelo», el modelo y el razonamiento se eligen por separado (por ejemplo, Gemini 4 Argon con esfuerzo Alto), como en OpenBot. Qué modelos aparecen lo decide Google según tu plan: con el plan gratis de Antigravity no hay ningún «Pro».
- Si le falta la sesión durante un chat, ClosedBot lo corta enseguida y te pide entrar desde Ajustes, en vez de esperar a que se abra el navegador.

## Uso

- **Armar un equipo**: toca a Claude Bot (arriba en la barra lateral) y cuéntale qué necesitas, por ejemplo: «Arma un equipo para crear un videojuego de plataformas». Cada agente que crea aparece en la lista, dentro de su proyecto y con un punto azul, y el equipo queda con su canal. En su chat verás «Creó a …» y «Creó el canal …»; al tocar el nombre se abre esa conversación. En su ficha → «Instrucciones» puedes dejarle tus preferencias para armar equipos (por ejemplo, «máximo 3 agentes» o «usa Sonnet para tareas simples»).
- **Eliminar agentes con Claude Bot**: pídeselo, por ejemplo «Elimina a Tester y a Artista» o «Elimina el equipo de Creación de Juegos». En su chat aparece una tarjeta con los agentes que va a eliminar: «Eliminar» los borra (con su historial, su cola y sus rutinas; sus archivos quedan en sus carpetas) y «Cancelar» no borra nada. Al que está trabajando se le detiene el turno. En su chat queda «Eliminó a …».
- **Crear un agente**: botón **+**. Ponle nombre, elige su modelo (Claude, Codex, Gemini, Grok o Qwen local) y su figura. No tiene color hasta que eliges el modelo: Claude lo pinta naranja, Codex verde, Gemini azul, Grok gris y Qwen morado. Después puedes cambiarlo, y el próximo agente de ese modelo sale con el último color que le elegiste. El título, la descripción, las instrucciones, la versión del modelo, el razonamiento y el acceso se cambian en su ficha (con «Acceso total para todos» encendido, el acceso no aparece: todos lo tienen).
- **Oficina**: botón del edificio en la barra lateral. Todo se dibuja en la app (sin imágenes ni servicios externos); los personajes de PixelLab de la 0.9.0 ya no se usan.
  - **Hablarle a un agente sin salir**: tócalo. Su chat aparece abajo (arrastra su borde para hacerlo más alto o más bajo; doble clic lo devuelve) y su ficha a la derecha; tocar su nombre en el chat la cierra o la vuelve a abrir, y la X del chat deja la Oficina sola.
  - **Cambiar de equipo**: arrastra el robot a otra plataforma (o clic derecho → «Cambiar de equipo»). Sale del equipo de donde lo sacaste (en «Sin grupo», de todos); si su sección era la de ese equipo, se cambia con él. Un canal que se queda sin agentes pasa a «Canales eliminados», y al restaurarlo vuelve con ellos. Claude Bot no se mueve de su salón.
  - **Crear**: «Nuevo agente» o el «+» de un equipo (el agente queda en ese equipo; «Qué hará» es opcional). Un equipo nuevo se arma con clic derecho (o mantener presionado) en un espacio vacío → «Nuevo equipo», o soltando un robot en «Equipo nuevo».
  - **MCP y habilidades de un equipo**: clic derecho (o mantener presionada) su tarjeta → «MCP y habilidades». Arriba, los del equipo (con «1 de 3» si no los tienen todos); abajo, los de cada agente. Tocar un agente abre su ficha en «MCP», igual que clic derecho sobre su robot → «Ver sus MCP».
- **Escribir**: en el computador, Enter envía y Mayús+Enter hace un salto de línea. En el teléfono se envía con el botón.
- **Cola**: si el agente está ocupado, verás «N mensajes esperando turno». Desde ahí puedes quitar mensajes. En su ficha (toca su nombre arriba) → «Avanzado» puedes pausar la cola o empezar de cero; «Eliminar agente» está al final de la ficha. «Detener» corta el turno en curso.
- **Equipo**: pídele a un agente que consulte a otro, por ejemplo: «Pídele a Beto que revise esto». En su chat verás «Enviado a Beto» y después «Respuesta de Beto».
- **Carpetas**: cada agente trabaja en `~/.closedbot/agentes/<nombre>`, y todos comparten `~/.closedbot/compartida`.
- **Preguntas**: cuando un agente necesita que elijas, verás una tarjeta con opciones (A, B, C…). La recomendada lleva una etiqueta. Al tocar una, el agente sigue con tu respuesta.
- **Rutinas**: botón del reloj en la barra lateral, o pídeselo a un agente («todos los días a las 9, revisa…»). Puedes pausarlas, ejecutarlas al momento o borrarlas. Cada agente tiene hasta 20. En su ficha → «Rutinas» están las suyas, con «Probar ahora» y el historial de las últimas 10 ejecuciones.
- **Secciones**: agrupan a los agentes en la barra lateral. Créalas con clic derecho en el fondo de la lista y mueve agentes con «Mover a». Al eliminar una sección, sus agentes pasan a «Sin asignar»; para eliminarlos a ellos, usa «Seleccionar sus agentes» en el menú de la sección. Claude Bot pone en la misma sección a los agentes de un equipo.
- **Ocultos y fijados**: los fijados van arriba; los ocultos, plegados al final de la lista («Ocultos») y en la búsqueda.
- **Voz**: el micrófono dicta en el cuadro de texto. Con el cuadro vacío, el botón morado graba y envía al terminar, y la respuesta se lee en voz alta.
  - *Dictado*: siempre en automático. En el PC, ClosedBot reconoce la voz en el propio equipo con Parakeet v3 (sherpa-onnx): la primera vez que tocas el micrófono pide descargar el modelo (unos 490 MB, a `<datos>/voz`), y después funciona sin internet y tu voz no sale del equipo. Donde no se puede grabar el audio, usa el servicio de voz del navegador.
  - *Lectura*: en la ficha del agente, *Chat de voz* elige la voz, la velocidad y el idioma, y si lee siempre sus respuestas. Bajo cada respuesta hay un botón para escucharla.
  - *Voces*: solo las 10 de OpenBot (Supertonic 3: 5 de mujer y 5 de hombre, en 31 idiomas). Corren en el propio equipo con sherpa-onnx, sin internet ni claves, y el teléfono recibe el audio desde el PC. Si OpenBot ya las descargó, ClosedBot usa esa copia; si no, «Descargar» (en Ajustes o en la ficha del agente) baja una vez los archivos de Hugging Face (unos 145 MB, en la revisión que fija OpenBot), comprueba el SHA-256 de cada uno y los deja en `<datos>/voz/voces`.
  - Las voces del navegador (las de Edge) y las de pago (Grok, ChatGPT, ElevenLabs) no se usan.
- **Recuerdos**: dile «recuerda que prefiero respuestas cortas» y lo guarda (verás «Guardó un recuerdo» en el chat), o agrégalos en su ficha → «Recuerdos». Con las flechas pasas uno a «Siempre se usan» o a «Se usan si hacen falta».
- **Habilidades**: en su ficha → «Habilidades» → «Nueva habilidad» (nombre, para qué sirve y los pasos), o pídele al agente que guarde un procedimiento como habilidad. Cada una es una carpeta con su `SKILL.md`; el interruptor la apaga sin borrarla.
- **MCP**: en su ficha → «MCP». Con Claude, si el agente no tiene una sesión abierta, ClosedBot abre una corta de Claude Code sin mandarle mensajes (no gasta plan), le pregunta y la cierra. La revisión se guarda 5 minutos; «Revisar de nuevo» la repite. Con «Solo su carpeta» solo aparece el de ClosedBot; con acceso total, también los que configuraste en tu Claude Code. Los de Codex son los de tu Codex, los mismos para todos sus agentes. Gemini y Grok no le cuentan a ClosedBot los suyos: de ellos solo se ve el de ClosedBot. Los conectores de claude.ai siguen apagados.
- **Avisarme**: en su ficha → «Avisarme». La primera vez, «Permitir avisos» le pide permiso al navegador. Claude Bot avisa de toda su actividad y los demás agentes, solo cuando te necesitan; no avisan de la conversación que estás mirando. En el teléfono por Tailscale (sin HTTPS) el navegador no muestra avisos.
- **Archivos**: en la ficha del agente se ven y descargan los archivos de su carpeta y de la compartida. «Subir archivo» los deja en `adjuntos/`. Los archivos se abren en una pestaña aparte, sin permisos sobre la app.
- **Uso del plan**: se lee cada 10 minutos y tras cada turno, solo de las cuentas con sesión. Claude lo informa Claude Code (como `/usage`); Codex, su `app-server`; Grok, su CLI; y Gemini, Antigravity con «/usage» (desde la 1.4.1, sin pasar por el modelo). Codex y Grok se abren un momento para leerlo y se cierran si ningún agente los usa. Antigravity no se abre solo para esto: Gemini se actualiza cuando un agente lo está usando y, mientras, se ve la última lectura con su hora. Si una de esas lecturas cambia, esa cuenta desaparece del detalle y la app sigue igual.
- **Adjuntos**: clip, pegar o arrastrar. Hasta 25 MB por archivo; se guardan en `adjuntos/` dentro de la carpeta del agente.
- **Probar sin IA** (solo para desarrollo: Demo ya no aparece en la app): con el proveedor Demo, una línea `@Nombre: texto` envía `texto` a ese compañero, `/equipo` lista a los compañeros, `/lento` responde despacio (para probar «Detener»), `/pregunta ¿Texto? | A | B` muestra una tarjeta de opciones y `/rutina 09:00 Nombre` crea una rutina, `/recuerda [siempre] texto` guarda un recuerdo y `/busca texto` busca entre ellos. Si Claude Bot usa la demo, `/crear Nombre | Rol | Proyecto | Aspecto` crea un agente (el aspecto es opcional), `/ajustar Nombre | Rol nuevo | Aspecto nuevo` le cambia el rol o el aspecto, `/canal Nombre | Encargado | Ana, Beto` crea un canal, `/proveedor Nombre | codex` le cambia el proveedor, `/eliminar Ana, Beto` pide eliminar agentes (con la tarjeta para confirmar), `/ficha Nombre` lee la ficha de un agente y `/pizarra texto` escribe la pizarra. Con `/imagen descripción`, cualquier agente de la demo «genera» una imagen de prueba, como el generador de Codex.

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

Las pruebas usan el proveedor Demo y simulaciones del SDK de Claude y del `codex app-server`, así que no gastan créditos. Cubren a Claude Bot (crear, proteger, sus herramientas para armar y eliminar equipos, la nota con lo que cambiaste, las fichas, la pizarra, el cambio de proveedor y la cadena de encargos), las imágenes que genera Codex, el uso del plan de cada proveedor, la cola, los mensajes entre agentes, el límite de reenvíos, la interrupción, el reinicio, el login, la protección CSRF, los eventos en vivo, las preguntas con opciones, las rutinas y sus horarios, los adjuntos, el control del lanzador de escritorio, el inicio de sesión con la cuenta (con un Claude Code falso), los MCP de cada agente (Claude, Codex y Gemini, sin copiar la configuración de los servidores), la Oficina (cambiar agentes de equipo, cómo se ubican, cómo llena la pantalla y, con un PixelLab simulado, personajes, ZIP, errores y arte en alta resolución) y la mudanza de `~/.cuadrilla` a `~/.closedbot`.

```
src/
  server.ts            arranque y apagado
  app.ts               API HTTP, eventos en vivo (SSE) y archivos estáticos
  auth.ts              contraseña (scrypt), sesiones y freno de intentos
  service.ts           orquestador: colas, hilos, mensajes entre agentes
  db.ts                SQLite (node:sqlite)
  instructions.ts      instrucciones de sistema de cada agente
  team.ts              herramientas del equipo: mensajes, preguntas, rutinas y las de Claude Bot
  team-state.ts        lo que sabe Claude Bot de agentes y canales, y la nota con lo que cambió
  board.ts             la pizarra de Claude Bot
  images.ts            las imágenes que genera un agente, copiadas a la carpeta compartida
  office.ts            la Oficina: personajes de PixelLab y arte en alta resolución
  mcp.ts               los MCP de cada agente, iguales para todos los proveedores
  schedule.ts          horarios de las rutinas
  version.ts           versión de la app
  providers/           Claude (Agent SDK), Codex (app-server), Grok y Gemini (ACP), Demo, detección y uso del plan
  cli/password.ts      npm run password
  cli/access.ts        npm run access (acceso total para todos, sin abrir la app)
public/                interfaz web (sin dependencias ni compilación); office.js dibuja la Oficina (plataformas de neón y robots)
public/fonts/          la letra de toda la app: Inter, la misma de OpenBot (incluida, funciona sin internet)
public/office/         arte pintado de la 0.9.0 (ya no lo usa la Oficina)
scripts/office-art.py  prepara public/office/ a partir de los dibujos originales (Pillow)
scripts/windows/       ClosedBot.exe: ventana propia e icono en la bandeja (C#)
deploy/                servicio de systemd y plantilla de entorno
test/                  pruebas (node:test)
```

## Estado y límites conocidos

- Versión 0.9.10 (toda la app, la Oficina incluida, usa una sola letra: Inter, la misma de OpenBot; el encabezado de la Oficina dice solo «Oficina»; la 0.9.9 hizo que la Oficina llene el espacio, también en un monitor vertical, y que el equipo nuevo se arme con clic derecho; la 0.9.8 trajo ver qué MCP tiene conectados cada agente y cada equipo, junto con las habilidades del equipo; la 0.9.7 hizo que al crear un agente elijas su modelo, y eso le pone color; la 0.9.6 hizo que en la Oficina la plataforma de un agente solo tome el color de ese agente, y la 0.9.5 trajo crear agentes y equipos en la Oficina, arrastrarlos entre equipos, su chat y su ficha ahí mismo, y una guía). Se probó con el proveedor Demo y con simulaciones de Claude, Codex, Gemini (Antigravity) y Grok. Las voces de OpenBot se probaron con el modelo real en Windows. **Falta la primera prueba con tus cuentas reales**: hazla con un agente en «Solo su carpeta».
- PixelLab se probó con una simulación de su API: **falta la primera prueba con tu cuenta**. Si algo falla, el agente queda con el personaje simple: tocando su figura en la ficha se ve el motivo y «Dibujarlo» lo intenta de nuevo.
- En la Oficina, cada agente está en una sola plataforma (la del equipo donde lo dejaste en este navegador, la del canal que encarga o, si no, la del primero en que está); en sus otros canales su escritorio queda vacío. El chat abajo y la ficha al lado son para pantallas de más de 760 px: en el teléfono, tocar un robot abre su chat completo.
- Un solo usuario y sin notificaciones push por ahora.
- Claude Bot crea hasta 8 agentes por pedido y deja de crear cuando ya hay 60 agentes en total.
- Claude Bot hace hasta 20 encargos seguidos por pedido; cuando él escribe, la cuenta de reenvíos seguidos entre agentes (6) vuelve a empezar. Cada agente que trabaja gasta el plan de su proveedor, y las imágenes gastan el de ChatGPT más rápido.
- Solo se copian a la carpeta compartida las imágenes de Codex: falta ver si Gemini (Antigravity) y Grok generan imágenes desde ClosedBot.
- Las preguntas con opciones terminan el turno del agente: tu respuesta le llega como un mensaje nuevo.
- Las rutinas solo corren con ClosedBot abierta (en Windows, basta con el icono de la bandeja).

## Licencias

- El código propio de ClosedBot es privado.
- Algunas partes derivan de **OpenBot v0.1.11** (Copyright 2026 Norbert Bodziony), con licencia Apache 2.0. Cada archivo derivado lo indica al inicio. Ver [NOTICE](NOTICE) y [licenses/OPENBOT-APACHE-2.0.txt](licenses/OPENBOT-APACHE-2.0.txt). Las versiones posteriores de OpenBot usan otra licencia y su código no se usó: de ellas solo se tomó la idea de conectar los proveedores con el inicio de sesión de su propio CLI.
- La letra **Inter** (The Inter Project Authors, SIL Open Font License 1.1) va incluida en `public/fonts/`. Ver [licenses/INTER-OFL-1.1.txt](licenses/INTER-OFL-1.1.txt).
- Dependencias: ver [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
