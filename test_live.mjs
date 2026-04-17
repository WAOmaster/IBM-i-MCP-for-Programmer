// Live test script - spawns the server and sends MCP tool calls
import { spawn } from "child_process";

const proc = spawn("node", ["build/index.js"], {
  cwd: import.meta.dirname,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
proc.stdout.on("data", (d) => { buffer += d.toString(); });
proc.stderr.on("data", (d) => { process.stderr.write("[stderr] " + d); });

function send(obj) {
  const json = JSON.stringify(obj);
  const msg = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
  proc.stdin.write(msg);
}

function waitResponse(timeoutMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      // Try to parse JSON from buffer
      const match = buffer.match(/\{.*"jsonrpc".*\}/s);
      if (match) {
        clearInterval(check);
        try { resolve(JSON.parse(match[0])); } catch { resolve(buffer); }
        buffer = "";
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve({ timeout: true, buffer });
        buffer = "";
      }
    }, 500);
  });
}

async function run() {
  console.log("=== 1. Initialize ===");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" }
  }});
  const init = await waitResponse();
  console.log("Init:", JSON.stringify(init).slice(0, 200));

  // Send initialized notification
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise(r => setTimeout(r, 1000));

  console.log("\n=== 2. Test Connection ===");
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "test_connection", arguments: {}
  }});
  const conn = await waitResponse();
  console.log("Connection:", JSON.stringify(conn).slice(0, 500));

  console.log("\n=== 3. Get Connection Info ===");
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "get_connection_info", arguments: {}
  }});
  const info = await waitResponse();
  console.log("Info:", JSON.stringify(info).slice(0, 500));

  console.log("\n=== 4. List Libraries ===");
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
    name: "list_libraries", arguments: { name_filter: "SHOLON", max_rows: 10 }
  }});
  const libs = await waitResponse();
  console.log("Libraries:", JSON.stringify(libs).slice(0, 500));

  console.log("\n=== 5. SQL Query ===");
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {
    name: "run_sql_query", arguments: {
      sql: "SELECT SYSTEM_VALUE_NAME, CURRENT_CHARACTER_VALUE FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME IN ('QSRLNBR','QLANGID') FETCH FIRST 5 ROWS ONLY"
    }
  }});
  const sqlRes = await waitResponse();
  console.log("SQL:", JSON.stringify(sqlRes).slice(0, 500));

  console.log("\n=== Done ===");
  proc.kill();
  process.exit(0);
}

run().catch(e => { console.error(e); proc.kill(); process.exit(1); });
