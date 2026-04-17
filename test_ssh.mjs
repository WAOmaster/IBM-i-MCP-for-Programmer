import { Client } from "ssh2";
import { config } from "dotenv";
config();

const host = process.env.IBMI_HOST_DEV || process.env.IBMI_HOST_TEST || "PUB400.COM";
const port = parseInt(process.env.IBMI_PORT || "2222");
const user = process.env.IBMI_USER || "SHOLON";
const pass = process.env.IBMI_PASSWORD;

console.log(`Connecting to ${host}:${port} as ${user}...`);

const conn = new Client();
conn.on("ready", async () => {
  console.log("✅ SSH Connected!\n");

  const run = (cmd) => new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d) => out += d.toString());
      stream.stderr.on("data", (d) => out += d.toString());
      stream.on("close", () => resolve(out));
    });
  });

  try {
    // Test 1: Connection info
    console.log("=== Test 1: System info ===");
    const info = await run('hostname && uname -a');
    console.log(info || "(no output)");

    // Test 2: Library list via SQL
    console.log("\n=== Test 2: Current Library List ===");
    const libs = await run('/QOpenSys/pkgs/bin/db2util "SELECT ORDINAL_POSITION, SCHEMA_NAME, TYPE FROM QSYS2.LIBRARY_LIST_INFO ORDER BY ORDINAL_POSITION" 2>&1');
    console.log(libs || "(no output)");

    // Test 3: System schemas
    console.log("\n=== Test 3: System Values ===");
    const sysvals = await run(`/QOpenSys/pkgs/bin/db2util "SELECT SYSTEM_VALUE_NAME, CURRENT_CHARACTER_VALUE FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME IN ('QSRLNBR','QLANGID','QCCSID') FETCH FIRST 5 ROWS ONLY" 2>&1`);
    console.log(sysvals || "(no output)");

    // Test 4: IFS home directory
    console.log("\n=== Test 4: IFS Home Directory ===");
    const home = await run('ls -la /home/SHOLON 2>&1');
    console.log(home || "(no output)");

    console.log("\n✅ All tests completed!");
  } catch (e) {
    console.error("Test error:", e);
  }

  conn.end();
});

conn.on("error", (err) => {
  console.error("❌ SSH Error:", err.message);
  process.exit(1);
});

conn.connect({ host, port, username: user, password: pass, readyTimeout: 30000 });
