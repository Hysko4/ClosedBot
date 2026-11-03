# Avisos de terceros

## Código derivado

| Proyecto | Versión | Licencia | Uso |
| --- | --- | --- | --- |
| [OpenBot](https://github.com/nightly-labs/openbot) | 0.1.11 | Apache-2.0 | Protocolo de proveedores, cliente del app-server de Codex, adaptador de Claude e instrucciones de los agentes, con modificaciones. Ver `NOTICE` y `licenses/OPENBOT-APACHE-2.0.txt`. |

## Dependencias de ejecución

| Paquete | Versión | Licencia |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.316 | Términos comerciales de Anthropic (ver el README del paquete) |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `zod` | 4.6.7 | MIT |
| `sherpa-onnx-node` (y su paquete para cada sistema) | 1.13.8 | Apache-2.0 |

## Dependencias de desarrollo

| Paquete | Licencia |
| --- | --- |
| `typescript` | Apache-2.0 |
| `@types/node` | MIT |

## Herramientas externas (no incluidas)

- `codex` (OpenAI Codex CLI) se instala aparte con `npm install -g @openai/codex` (o con «Instalar» en Ajustes).
- Para Gemini, el servidor ACP de **Google Antigravity** (`agy_acp_server`, licencia propietaria de Google LLC, términos en https://antigravity.google/terms). ClosedBot no lo incluye: usa la copia que descargó OpenBot o, al pulsar «Instalar» en Ajustes, descarga el `.zip` oficial de `dl.google.com` indicado en el registro de ACP y comprueba su SHA-256.
- Grok CLI se instala con el instalador oficial de xAI (`https://x.ai/cli`) al pulsar «Instalar» en Ajustes; lo rigen los términos de xAI.
- Modelo de dictado **Parakeet TDT 0.6B v3** (NVIDIA, CC-BY-4.0), en la versión convertida por el proyecto sherpa-onnx. Se descarga solo si lo pides en Ajustes, a `<datos>/voz`.
- `@playwright/mcp` se descarga con `npx` solo si activas `CLOSEDBOT_PLAYWRIGHT=1`.
