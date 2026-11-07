import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describeMcp, parseClaudeMcp, parseCodexMcp, readPcMcpServers } from "../src/mcp-share.js";
import { createPermissionPolicy } from "../src/providers/claude.js";
import { createHarness, tempDir, waitFor } from "./helpers.js";

const CODEX_TOML = `
model = "gpt-5.5"

# El de Unity, como lo deja su instalador.
[mcp_servers.unityMCP]
command = "C:\\\\Users\\\\44\\\\AppData\\\\Local\\\\unity-mcp\\\\server.exe" # comentario
args = ["--port", "6400"]

[mcp_servers.unityMCP.env]
UNITY_KEY = "secreto-123"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
http_headers = { "X-Team" = "4fter" }

[mcp_servers.apagado]
command = "algo"
enabled = false

[mcp_servers.codex_apps]
command = "no-se-comparte"

[profiles.rapido]
model = "gpt-5.5-mini"
`;

function pcHome(): { path: string; cleanup: () => void } {
  const temp = tempDir();
  mkdirSync(join(temp.path, ".codex"), { recursive: true });
  writeFileSync(join(temp.path, ".codex", "config.toml"), CODEX_TOML);
  writeFileSync(
    join(temp.path, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        blender: { type: "stdio", command: "uvx", args: ["blender-mcp"], env: { BLENDER_PORT: "9876" } },
        unityMCP: { command: "otro" },
        "claude.ai Sider4": { type: "http", url: "https://ejemplo" },
      },
    }),
  );
  return temp;
}

test("MCP del PC: lee los de Codex (TOML) y los de Claude Code, sin los conectores de la cuenta", () => {
  const codex = parseCodexMcp(CODEX_TOML);
  assert.deepEqual(
    codex.map((server) => server.name),
    ["unityMCP", "figma", "codex_apps"],
  );
  assert.equal(codex[0]?.command, "C:\\Users\\44\\AppData\\Local\\unity-mcp\\server.exe");
  assert.deepEqual(codex[0]?.args, ["--port", "6400"]);
  assert.deepEqual(codex[0]?.env, { UNITY_KEY: "secreto-123" });
  assert.deepEqual({ transport: codex[1]?.transport, url: codex[1]?.url, headers: codex[1]?.headers }, { transport: "http", url: "https://mcp.figma.com/mcp", headers: { "X-Team": "4fter" } });
  assert.deepEqual(
    parseClaudeMcp('{"mcpServers":{"web":{"type":"http","url":"https://x"},"roto":{}}}').map((server) => `${server.name}:${server.transport}`),
    ["web:http"],
  );
  const home = pcHome();
  try {
    const all = readPcMcpServers(home.path, join(home.path, ".codex"));
    assert.deepEqual(
      all.map((server) => `${server.name}:${server.origin}`),
      ["unityMCP:codex", "figma:codex", "blender:claude"],
    );
  } finally {
    home.cleanup();
  }
  assert.match(describeMcp("unityMCP"), /Unity/);
  assert.match(describeMcp("blender"), /Blender/);
  assert.match(describeMcp("rarito", ["a", "b"]), /2 herramientas: a, b/);
});

test("MCP del equipo: se le dan a un equipo y los tienen todos sus agentes; la app nunca ve su configuración", async () => {
  const home = pcHome();
  const h = await createHarness({ mcpHome: home.path });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const fuera = h.service.createAgent({ name: "Fuera", provider: "demo" });
    const channel = h.service.createChannel({ name: "4FTER", memberIds: [ana.id, beto.id] });
    const listing = h.service.teamMcp(channel.id);
    assert.deepEqual(listing.selected, []);
    assert.deepEqual(
      listing.available.map((server) => server.name),
      ["unityMCP", "figma", "blender"],
    );
    assert.doesNotMatch(JSON.stringify(listing), /secreto|server\.exe|uvx|mcp\.figma/, "sin configuración");
    assert.match(listing.available[0]?.description ?? "", /Unity/);

    const saved = h.service.setTeamMcp(channel.id, ["unityMCP", "no-existe", "unityMCP"]);
    assert.deepEqual(saved.selected, ["unityMCP"]);
    for (const id of [ana.id, beto.id]) {
      const view = await h.service.agentMcp(id, { refresh: true });
      const unity = view.servers.find((server) => server.name === "unityMCP");
      assert.equal(unity?.source, "team", "lo recibe por su equipo");
      assert.match(unity?.description ?? "", /Unity/);
    }
    const other = await h.service.agentMcp(fuera.id, { refresh: true });
    assert.ok(!other.servers.some((server) => server.name === "unityMCP"), "quien no es del equipo no lo recibe");
    assert.deepEqual(h.service.setTeamMcp(channel.id, []).selected, []);
  } finally {
    await h.close();
    home.cleanup();
  }
});

test("MCP del equipo: Claude los recibe con su configuración y puede usarlos aunque esté en «solo su carpeta»", async () => {
  const home = pcHome();
  const options: Options[] = [];
  const { ClaudeAgentClient } = await import("../src/providers/claude.js");
  const { DemoAgentClient } = await import("../src/providers/demo.js");
  const h = await createHarness({
    mcpHome: home.path,
    createClient: (provider) =>
      provider === "claude"
        ? new ClaudeAgentClient({
            createQuery: ({ options: value }) => {
              options.push(value as Options);
              throw new Error("solo se miran las opciones");
            },
            idleMs: 0,
            platform: "linux",
          })
        : new DemoAgentClient({ wordDelayMs: 0 }),
  });
  try {
    const dev = h.service.createAgent({ name: "Dev", provider: "claude" });
    const channel = h.service.createChannel({ name: "4FTER", memberIds: [dev.id] });
    h.service.setTeamMcp(channel.id, ["unityMCP", "blender"]);
    h.service.sendUserMessage(dev.id, "hola");
    await waitFor(() => options.length > 0, 5_000, "opciones de Claude");
    const servers = options[0]?.mcpServers ?? {};
    assert.deepEqual(servers.unityMCP, {
      type: "stdio",
      command: "C:\\Users\\44\\AppData\\Local\\unity-mcp\\server.exe",
      args: ["--port", "6400"],
      env: { UNITY_KEY: "secreto-123" },
    });
    assert.equal((servers.blender as { command?: string }).command, "uvx");
    assert.ok(!("figma" in servers), "solo los que le diste");
  } finally {
    await h.close();
    home.cleanup();
  }
  const policy = createPermissionPolicy("carpeta", ["/srv/a"], ["unityMCP"]);
  const context = { signal: new AbortController().signal, toolUseID: "t", suggestions: [] } as unknown as Parameters<typeof policy>[2];
  assert.equal((await policy("mcp__unityMCP__create_object", {}, context))?.behavior, "allow");
  assert.equal((await policy("mcp__otro__x", {}, context))?.behavior, "deny");
});
