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

## Dependencias de desarrollo

| Paquete | Licencia |
| --- | --- |
| `typescript` | Apache-2.0 |
| `@types/node` | MIT |

## Herramientas externas (no incluidas)

- `codex` (OpenAI Codex CLI) se instala aparte con `npm install -g @openai/codex`.
- `@playwright/mcp` se descarga con `npx` solo si activas `CUADRILLA_PLAYWRIGHT=1`.
