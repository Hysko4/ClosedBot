#!/usr/bin/env node
// Claude Code falso para las pruebas de inicio de sesión: imita `claude auth status --json`,
// `claude auth login --claudeai` y `claude auth logout`. La «sesión» es el archivo
// .credentials.json dentro de CLAUDE_CONFIG_DIR, igual que en Windows y Linux.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir) {
  process.stderr.write("Falta CLAUDE_CONFIG_DIR\n");
  process.exit(2);
}
mkdirSync(configDir, { recursive: true });
const credentials = join(configDir, ".credentials.json");
const [group, command, ...rest] = process.argv.slice(2);

function signIn() {
  writeFileSync(credentials, "{}");
  process.stdout.write("Login successful.\n");
  process.exit(0);
}

if (group !== "auth") {
  process.stderr.write(`Orden desconocida: ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}

if (command === "status") {
  const loggedIn = existsSync(credentials);
  const status = loggedIn
    ? { loggedIn, authMethod: "claude.ai", apiProvider: "firstParty", email: "persona@example.com", orgName: "Org", subscriptionType: "max", configDirectory: configDir }
    : { loggedIn, authMethod: "none", apiProvider: "firstParty", configDirectory: configDir };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(loggedIn ? 0 : 1);
}

if (command === "logout") {
  rmSync(credentials, { force: true });
  process.stdout.write("Successfully logged out from your Anthropic account.\n");
  process.exit(0);
}

if (command === "login") {
  writeFileSync(
    join(configDir, "login-env.json"),
    JSON.stringify({
      args: rest,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER ?? null,
      CLAUDECODE: process.env.CLAUDECODE ?? null,
      stdinIsTTY: Boolean(process.stdin.isTTY),
    }),
  );
  const url = "https://claude.ai/oauth/authorize?code=true&client_id=prueba&state=estado";
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write(`If the browser didn't open, visit: \u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\\n`);
  process.stdout.write("Paste code here if prompted > ");
  const mode = process.env.FAKE_CLAUDE_LOGIN ?? "code";
  if (mode === "browser") setTimeout(signIn, 50);
  else if (mode === "fail") {
    process.stderr.write("Login failed: Request failed with status code 403\n");
    process.exit(1);
  } else if (mode === "hang") setInterval(() => undefined, 1_000);
  else {
    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      if (line.trim() === "codigo#estado") signIn();
      process.stderr.write("Login failed: Invalid authorization code\n");
      process.exit(1);
    });
  }
} else {
  process.stderr.write(`Orden desconocida: auth ${command}\n`);
  process.exit(2);
}
