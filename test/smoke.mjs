// MCP stdio smoke: spawn the server with NO wallet, run initialize / tools/list /
// tools/call who_terms. who_terms hits the live 402 and pays nothing.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn(process.execPath, [new URL("../src/index.mjs", import.meta.url).pathname], {
  env: { ...process.env, PRIVATE_KEY: "" },
  stdio: ["pipe", "pipe", "inherit"]
});
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const seen = new Map();
createInterface({ input: child.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id) seen.set(m.id, m);
});
const wait = async (id) => {
  for (let i = 0; i < 300 && !seen.has(id); i++) await new Promise((r) => setTimeout(r, 100));
  return seen.get(id) ?? (() => { throw new Error(`timeout waiting for id ${id}`); })();
};

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
console.log("initialize   ->", JSON.stringify((await wait(1)).result.serverInfo));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
console.log("tools/list   ->", (await wait(2)).result.tools.map((t) => t.name).join(", "));
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "who_terms", arguments: { q: "apple.com" } } });
const terms = JSON.parse((await wait(3)).result.content[0].text);
console.log("who_terms    ->", JSON.stringify({ status: terms.status, network: terms.network, amount: terms.amount, price_usd: terms.price_usd, paid: terms.paid }));
child.kill();
process.exit(terms.amount === "50000" ? 0 : 1);
