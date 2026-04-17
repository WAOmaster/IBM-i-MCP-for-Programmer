#!/usr/bin/env node
/**
 * PUB400 IBM i MCP Server  v1.0.0
 * Purpose-built for PUB400.COM public IBM i environment.
 * SSH-based, pre-configured for PUB400.COM (port 2222).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "ssh2";
import { z } from "zod";
import { config } from "dotenv";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, "../.env");
config({ path: ENV_FILE });

// --- Environment Registry ---------------------------------------------------

const ENVS: Record<string, { host: string; port: number }> = {
  dev:  { host: process.env.IBMI_HOST_DEV  ?? "PUB400.COM", port: parseInt(process.env.IBMI_PORT ?? "2222") },
  test: { host: process.env.IBMI_HOST_TEST ?? "PUB400.COM", port: parseInt(process.env.IBMI_PORT ?? "2222") },
};

// --- Runtime Config ---------------------------------------------------------

function getEnv() {
  return {
    activeEnv:    process.env.IBMI_ENV            ?? "dev",
    user:         process.env.IBMI_USER           ?? "SHOLON",
    password:     process.env.IBMI_PASSWORD       ?? "",
    libraryList:  (process.env.IBMI_LIBRARY_LIST  ?? "").split(",").map(s => s.trim()).filter(Boolean),
    timeoutMs:    parseInt(process.env.IBMI_TIMEOUT_SEC     ?? "90")  * 1000,
    sqlTimeoutMs: parseInt(process.env.IBMI_SQL_TIMEOUT_SEC ?? "120") * 1000,
    poolMax:      parseInt(process.env.IBMI_POOL_MAX        ?? "5"),
    poolIdleMs:   parseInt(process.env.IBMI_POOL_IDLE_SEC   ?? "120") * 1000,
  };
}

function saveEnv(patch: Partial<ReturnType<typeof getEnv> & { host?: string }>) {
  const raw  = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const map: Record<string, string> = {};
  for (const l of raw.split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.*)/);
    if (m) map[m[1]] = m[2];
  }
  if (patch.activeEnv  !== undefined) map["IBMI_ENV"]           = patch.activeEnv;
  if ((patch as any).host !== undefined) {
    const e = patch.activeEnv ?? map["IBMI_ENV"] ?? "dev";
    map[`IBMI_HOST_${e.toUpperCase()}`] = (patch as any).host;
  }
  if (patch.user         !== undefined) map["IBMI_USER"]            = patch.user;
  if (patch.password     !== undefined) map["IBMI_PASSWORD"]        = patch.password;
  if (patch.libraryList  !== undefined) map["IBMI_LIBRARY_LIST"]    = (patch.libraryList as string[]).join(",");
  if (patch.timeoutMs    !== undefined) map["IBMI_TIMEOUT_SEC"]     = String((patch.timeoutMs    as number) / 1000);
  if (patch.sqlTimeoutMs !== undefined) map["IBMI_SQL_TIMEOUT_SEC"] = String((patch.sqlTimeoutMs as number) / 1000);
  if (patch.poolMax      !== undefined) map["IBMI_POOL_MAX"]        = String(patch.poolMax);
  if (patch.poolIdleMs   !== undefined) map["IBMI_POOL_IDLE_SEC"]   = String((patch.poolIdleMs   as number) / 1000);
  writeFileSync(ENV_FILE, Object.entries(map).map(([k,v]) => `${k}=${v}`).join("\n") + "\n", "utf8");
  config({ path: ENV_FILE, override: true });
}

// --- SSH Pool ---------------------------------------------------------------

interface PoolEntry { conn: Client; lastUsed: number; busy: boolean }
const pool: PoolEntry[] = [];
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function startPrune() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const { poolIdleMs } = getEnv();
    const now = Date.now();
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!pool[i].busy && now - pool[i].lastUsed > poolIdleMs) {
        pool[i].conn.end();
        pool.splice(i, 1);
      }
    }
  }, 30_000);
  pruneTimer.unref?.();
}

function getConn(): Promise<{ conn: Client; release: () => void }> {
  return new Promise((resolve, reject) => {
    const cfg = getEnv();
    const envDef = ENVS[cfg.activeEnv];
    if (!envDef)       return reject(new Error(`Unknown environment: ${cfg.activeEnv}`));
    if (!cfg.password) return reject(new Error("No password set — run configure_connection first."));

    for (const e of pool) {
      if (!e.busy) {
        e.busy = true; e.lastUsed = Date.now();
        return resolve({ conn: e.conn, release: () => { e.busy = false; e.lastUsed = Date.now(); } });
      }
    }
    if (pool.length >= cfg.poolMax) return reject(new Error("SSH pool exhausted"));

    const conn = new Client();
    conn.on("ready", () => {
      const entry: PoolEntry = { conn, lastUsed: Date.now(), busy: true };
      pool.push(entry);
      startPrune();
      resolve({ conn, release: () => { entry.busy = false; entry.lastUsed = Date.now(); } });
    });
    conn.on("error", reject);
    conn.connect({
      host:         cfg.user.includes("@") ? cfg.user.split("@")[1] : envDef.host,
      port:         envDef.port,
      username:     cfg.user.includes("@") ? cfg.user.split("@")[0] : cfg.user,
      password:     cfg.password,
      readyTimeout: 20_000,
    });
  });
}

function execOnConn(conn: Client, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "", stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    conn.exec(command, (e, stream) => {
      if (e) { clearTimeout(timer); return reject(e); }
      stream.on("data",        (d: Buffer) => (out    += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      stream.on("close", (code: number) => {
        clearTimeout(timer);
        if (code !== 0 && !out && stderr) return reject(new Error(stderr.trim()));
        resolve((out + (stderr ? `\n[stderr]: ${stderr}` : "")).trim());
      });
    });
  });
}

async function exec(command: string, timeoutMs?: number): Promise<string> {
  const { timeoutMs: def } = getEnv();
  const { conn, release } = await getConn();
  try   { return await execOnConn(conn, command, timeoutMs ?? def); }
  finally { release(); }
}

// --- Helpers ----------------------------------------------------------------

const SAFE_NAME = /^[A-Z0-9_#@$]{1,10}$/i;

function safeObjName(name: string, label = "name"): string {
  const n = name.trim().toUpperCase();
  if (!SAFE_NAME.test(n)) throw new Error(`Invalid IBM i ${label}: "${name}"`);
  return n;
}

function libSetup(extra: string[] = []): string {
  const { libraryList } = getEnv();
  const libs = [...extra, ...libraryList].filter(Boolean).map(l => safeObjName(l, "library"));
  if (libs.length === 0) return "";
  return libs.map(l => `system "ADDLIBLE LIB(${l}) POSITION(*FIRST)" 2>/dev/null`).join(" ; ") + " ; ";
}

// Keep old name for backward compat within file
const libListPrefix = libSetup;

async function execSql(sql: string, maxRows = 200): Promise<string> {
  const { sqlTimeoutMs } = getEnv();
  const escaped = sql.replace(/"/g, '\\"');
  return exec(`${libSetup()}/QOpenSys/pkgs/bin/db2util "${escaped}" 2>&1 | head -${maxRows + 5}`, sqlTimeoutMs);
}

async function execSqlParam(sql: string, params: string[] = [], maxRows = 200): Promise<string> {
  const { sqlTimeoutMs } = getEnv();
  const escaped = sql.replace(/"/g, '\\"');
  const pFlags = params.map(p => `-p ${p.replace(/"/g, '\\"')}`).join(" ");
  return exec(`${libSetup()}/QOpenSys/pkgs/bin/db2util -o csv ${pFlags} "${escaped}" 2>&1 | head -${maxRows + 5}`, sqlTimeoutMs);
}

// --- SFTP Helpers -----------------------------------------------------------

async function sftpWrite(remotePath: string, content: string): Promise<void> {
  const { conn, release } = await getConn();
  try {
    await new Promise<void>((resolve, reject) => {
      conn.sftp((e, sftp) => {
        if (e) return reject(e);
        sftp.writeFile(remotePath, Buffer.from(content, "utf8"), (we) => {
          sftp.end();
          if (we) return reject(we);
          resolve();
        });
      });
    });
  } finally { release(); }
}

async function sftpRead(remotePath: string): Promise<string> {
  const { conn, release } = await getConn();
  try {
    return await new Promise<string>((resolve, reject) => {
      conn.sftp((e, sftp) => {
        if (e) return reject(e);
        sftp.readFile(remotePath, (re, buf) => {
          sftp.end();
          if (re) return reject(re);
          resolve(buf.toString("utf8"));
        });
      });
    });
  } finally { release(); }
}

// --- Compile Type Mapping ---------------------------------------------------

const COMPILE_MAP: Record<string, { cmd: string; objKey: string }> = {
  RPGLE:    { cmd: "CRTBNDRPG",  objKey: "PGM" },
  SQLRPGLE: { cmd: "CRTSQLRPGI", objKey: "OBJ" },
  CLLE:     { cmd: "CRTBNDCL",   objKey: "PGM" },
  CLP:      { cmd: "CRTCLPGM",   objKey: "PGM" },
  CBLLE:    { cmd: "CRTBNDCBL",  objKey: "PGM" },
  PF:       { cmd: "CRTPF",      objKey: "FILE" },
  LF:       { cmd: "CRTLF",      objKey: "FILE" },
  DSPF:     { cmd: "CRTDSPF",    objKey: "FILE" },
  PRTF:     { cmd: "CRTPRTF",    objKey: "FILE" },
  CMD:      { cmd: "CRTCMD",     objKey: "CMD" },
};

const ok  = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (msg:  string) => ({ content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true });

function fmtRows(raw: string, maxRows = 200): string {
  const lines = raw.split("\n").filter(l => l.trim());
  if (lines.length > maxRows)
    return lines.slice(0, maxRows).join("\n") + `\n... (truncated — ${lines.length} total rows)`;
  return lines.join("\n");
}

// --- MCP Server -------------------------------------------------------------

const server = new McpServer({ name: "pub400-ibmi-mcp", version: "1.0.0" });

// ===== GROUP 1 — Connection & Configuration =====

server.registerTool("configure_connection", {
  description: "Set IBM i connection credentials and active environment. Persisted to .env.",
  inputSchema: {
    environment:  z.enum(["dev","test"]).describe("Target environment").optional(),
    user:         z.string().describe("SSH username (e.g. SHOLON)").optional(),
    password:     z.string().describe("SSH password").optional(),
    library_list: z.string().describe("Comma-separated library list (e.g. SHOLON1,QGPL)").optional(),
  },
}, async ({ environment, user, password, library_list }) => {
  try {
    const patch: Parameters<typeof saveEnv>[0] = {};
    if (environment)  patch.activeEnv   = environment;
    if (user)         patch.user        = user;
    if (password)     patch.password    = password;
    if (library_list) patch.libraryList = library_list.split(",").map(s => s.trim());
    saveEnv(patch);
    const cfg    = getEnv();
    const envDef = ENVS[cfg.activeEnv];
    return ok(`Configured.\nEnvironment : ${cfg.activeEnv} (${envDef.host}:${envDef.port})\nUser        : ${cfg.user}\nLibraries   : ${cfg.libraryList.join(", ")}`);
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_connection_info", {
  description: "Show current IBM i connection settings. Password not shown.",
  inputSchema: {},
}, async () => {
  const cfg    = getEnv();
  const envDef = ENVS[cfg.activeEnv];
  return ok(
    `Active environment : ${cfg.activeEnv}\n` +
    `Host               : ${envDef?.host ?? "unknown"}\n` +
    `Port               : ${envDef?.port ?? 22}\n` +
    `User               : ${cfg.user}\n` +
    `Password set       : ${cfg.password ? "yes" : "NO — run configure_connection"}\n` +
    `Library list       : ${cfg.libraryList.join(", ")}\n` +
    `SSH timeout        : ${cfg.timeoutMs    / 1000}s\n` +
    `SQL timeout        : ${cfg.sqlTimeoutMs / 1000}s\n` +
    `Pool max           : ${cfg.poolMax}\n`
  );
});

server.registerTool("test_connection", {
  description: "Test SSH connectivity to IBM i.",
  inputSchema: {
    environment: z.enum(["dev","test"]).describe("Environment to test (defaults to active)").optional(),
  },
}, async ({ environment }) => {
  try {
    if (environment) saveEnv({ activeEnv: environment });
    const result = await exec(`echo "SSH OK" && system "DSPJOBLOG OUTPUT(*PRINT)" 2>&1 | head -3`);
    return ok(`Connection test passed.\n${result}`);
  } catch (e) { return err(`Connection test failed: ${e}`); }
});

// ===== GROUP 2 — Library & Object Management =====

server.registerTool("list_libraries", {
  description: "List DB2 libraries/schemas on IBM i, optionally filtered by name pattern.",
  inputSchema: {
    name_filter: z.string().describe("Filter by name pattern (partial match, e.g. IV15)").optional(),
    max_rows:    z.number().int().min(1).max(2000).describe("Max rows (default 200)").optional(),
  },
}, async ({ name_filter, max_rows = 200 }) => {
  try {
    const where = name_filter ? `WHERE SCHEMA_NAME LIKE '%${name_filter.toUpperCase()}%'` : "";
    const sql   = `SELECT SCHEMA_NAME, SCHEMA_TEXT FROM QSYS2.SYSSCHEMAS ${where} ORDER BY SCHEMA_NAME FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("list_files", {
  description: "List all files (tables) in a specific IBM i library.",
  inputSchema: {
    library:     z.string().describe("Library/schema name (e.g. FSVDATA)"),
    name_filter: z.string().describe("Optional file name filter (partial match)").optional(),
    max_rows:    z.number().int().min(1).max(2000).describe("Max rows (default 200)").optional(),
  },
}, async ({ library, name_filter, max_rows = 200 }) => {
  try {
    const lib   = safeObjName(library, "library");
    const extra = name_filter ? `AND TABLE_NAME LIKE '%${name_filter.toUpperCase()}%'` : "";
    const sql   = `SELECT TABLE_NAME, TABLE_TEXT, TABLE_TYPE FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = '${lib}' ${extra} ORDER BY TABLE_NAME FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("describe_file", {
  description: "Show complete field/column structure of an IBM i file.",
  inputSchema: {
    library:   z.string().describe("Library name"),
    file_name: z.string().describe("File/table name (e.g. CSTMAST)"),
  },
}, async ({ library, file_name }) => {
  try {
    const lib = safeObjName(library, "library");
    const fil = safeObjName(file_name, "file");
    const sql = `SELECT COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, IS_NULLABLE, COLUMN_TEXT FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = '${lib}' AND TABLE_NAME = '${fil}' ORDER BY ORDINAL_POSITION`;
    return ok(fmtRows(await execSql(sql, 500), 500));
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_file_keys", {
  description: "Show key fields (primary key / access paths) for an IBM i file.",
  inputSchema: {
    library:   z.string().describe("Library name"),
    file_name: z.string().describe("File/table name"),
  },
}, async ({ library, file_name }) => {
  try {
    const lib = safeObjName(library, "library");
    const fil = safeObjName(file_name, "file");
    const sql = `SELECT INDEX_NAME, COLUMN_NAME, COLUMN_POSITION, ORDERING FROM QSYS2.SYSKEYS WHERE INDEX_SCHEMA = '${lib}' AND INDEX_NAME = '${fil}' ORDER BY COLUMN_POSITION`;
    return ok(fmtRows(await execSql(sql)));
  } catch (e) { return err(String(e)); }
});

server.registerTool("search_files_by_field", {
  description: "Find all files containing a specific field name across one or all libraries.",
  inputSchema: {
    field_name: z.string().describe("Field name to search for (partial match, e.g. ACCTNO)"),
    library:    z.string().describe("Library to search, or *ALL for all libraries").optional(),
    max_rows:   z.number().int().min(1).max(500).describe("Max results (default 100)").optional(),
  },
}, async ({ field_name, library = "*ALL", max_rows = 100 }) => {
  try {
    const libC = library !== "*ALL" ? `AND TABLE_SCHEMA = '${safeObjName(library, "library")}'` : "";
    const sql  = `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, LENGTH, COLUMN_TEXT FROM QSYS2.SYSCOLUMNS WHERE COLUMN_NAME LIKE '%${field_name.toUpperCase()}%' ${libC} ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("list_objects", {
  description: "List objects (programs, files, data areas, etc.) in a library filtered by type and name.",
  inputSchema: {
    library:     z.string().describe("Library name"),
    obj_type:    z.string().describe("Object type: *ALL, *PGM, *SRVPGM, *MODULE, *FILE, *DTAARA, *CMD").optional(),
    name_filter: z.string().describe("Object name filter (supports * wildcard)").optional(),
    max_rows:    z.number().int().min(1).max(2000).describe("Max results (default 200)").optional(),
  },
}, async ({ library, obj_type = "*ALL", name_filter = "*ALL", max_rows = 200 }) => {
  try {
    const lib   = safeObjName(library, "library");
    const typeC = obj_type    !== "*ALL" ? `AND OBJECT_TYPE = '${obj_type.replace("*","")}'`                              : "";
    const nameC = name_filter !== "*ALL" ? `AND OBJECT_NAME LIKE '${name_filter.replace("*","%").toUpperCase()}%'` : "";
    const sql   = `SELECT OBJECT_SCHEMA, OBJECT_NAME, OBJECT_TYPE, OBJECT_TEXT FROM QSYS2.OBJECT_STATISTICS WHERE OBJECT_SCHEMA = '${lib}' ${typeC} ${nameC} FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

// ===== GROUP 3 — Source Code Management =====

server.registerTool("list_source_members", {
  description: "List source members in a source physical file (e.g. QRPGLESRC, QCLLESRC).",
  inputSchema: {
    library:       z.string().describe("Library name (e.g. FSVPGM)"),
    source_file:   z.string().describe("Source file name (e.g. QRPGLESRC, QCLLESRC)"),
    member_filter: z.string().describe("Member name filter (supports * wildcard, or *ALL)").optional(),
    max_rows:      z.number().int().min(1).max(2000).describe("Max rows (default 200)").optional(),
  },
}, async ({ library, source_file, member_filter = "*ALL", max_rows = 200 }) => {
  try {
    const lib    = safeObjName(library, "library");
    const spf    = safeObjName(source_file, "source_file");
    const filter = member_filter === "*ALL" ? "" : member_filter.replace("*", "%").toUpperCase();
    const nameC  = filter ? `AND SOURCE_MEMBER LIKE '${filter}'` : "";
    const sql    = `SELECT SOURCE_MEMBER, SOURCE_TYPE, SOURCE_TEXT, LAST_CHANGE_DATE FROM QSYS2.MEMBER_INFO WHERE SOURCE_FILE_LIBRARY = '${lib}' AND SOURCE_FILE = '${spf}' ${nameC} ORDER BY SOURCE_MEMBER FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("view_source_member", {
  description: "View source code of a specific member. Uses EBCDIC\u2192UTF-8 conversion.",
  inputSchema: {
    library:     z.string().describe("Library name (e.g. FSVPGM)"),
    source_file: z.string().describe("Source physical file (e.g. QRPGLESRC, QCLLESRC)"),
    member:      z.string().describe("Source member name (e.g. AR002)"),
    max_lines:   z.number().int().min(1).max(5000).describe("Max lines (default 500)").optional(),
  },
}, async ({ library, source_file, member, max_lines = 500 }) => {
  try {
    const lib      = safeObjName(library, "library");
    const spf      = safeObjName(source_file, "source_file");
    const mbr      = safeObjName(member, "member");
    const qsysPath = `/QSYS.LIB/${lib}.LIB/${spf}.FILE/${mbr}.MBR`;
    const cmd      = `/QOpenSys/usr/bin/iconv -f IBM-037 -t UTF-8 "${qsysPath}" 2>/dev/null | head -${max_lines}`;
    return ok((await exec(cmd, getEnv().sqlTimeoutMs)) || "(empty member)");
  } catch (e) { return err(String(e)); }
});

server.registerTool("search_source_members", {
  description: "Search source member names across a library by name pattern or type.",
  inputSchema: {
    library:        z.string().describe("Library to search in"),
    member_pattern: z.string().describe("Member name pattern (partial match)").optional(),
    source_type:    z.string().describe("Source type filter (e.g. RPGLE, CLLE, DSPF, PF)").optional(),
    max_rows:       z.number().int().min(1).max(500).describe("Max results (default 100)").optional(),
  },
}, async ({ library, member_pattern, source_type, max_rows = 100 }) => {
  try {
    const lib     = safeObjName(library, "library");
    const clauses = [];
    if (member_pattern) clauses.push(`SOURCE_MEMBER LIKE '%${member_pattern.toUpperCase()}%'`);
    if (source_type)    clauses.push(`SOURCE_TYPE = '${source_type.toUpperCase()}'`);
    const where   = clauses.length ? "AND " + clauses.join(" AND ") : "";
    const sql     = `SELECT SOURCE_FILE_LIBRARY, SOURCE_FILE, SOURCE_MEMBER, SOURCE_TYPE, SOURCE_TEXT FROM QSYS2.MEMBER_INFO WHERE SOURCE_FILE_LIBRARY = '${lib}' ${where} ORDER BY SOURCE_MEMBER FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_program_info", {
  description: "Get detailed information about a compiled program object.",
  inputSchema: {
    library:      z.string().describe("Library name"),
    program_name: z.string().describe("Program name"),
  },
}, async ({ library, program_name }) => {
  try {
    const lib = safeObjName(library, "library");
    const pgm = safeObjName(program_name, "program");
    const sql = `SELECT PROGRAM_SCHEMA, PROGRAM_NAME, PROGRAM_TYPE, CREATION_TIMESTAMP, SOURCE_FILE, SOURCE_LIBRARY, SOURCE_MEMBER, PROGRAM_LANGUAGE FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_SCHEMA = '${lib}' AND PROGRAM_NAME = '${pgm}'`;
    return ok(fmtRows(await execSql(sql)));
  } catch (e) { return err(String(e)); }
});

// ===== GROUP 3b — Source CRUD (write / create / delete / search) =====

server.registerTool("write_source_member", {
  description: "Write (replace) source code in an existing SRCPF member. Always backs up the previous version to /tmp/mcp_backup/ before overwriting.",
  inputSchema: {
    library:     z.string().describe("Library name (e.g. SASHILIB)"),
    source_file: z.string().describe("Source physical file (e.g. QRPGLESRC)"),
    member:      z.string().describe("Member name to write"),
    content:     z.string().describe("Complete source code content (UTF-8 text)"),
  },
}, async ({ library, source_file, member, content }) => {
  try {
    const lib = safeObjName(library, "library");
    const spf = safeObjName(source_file, "source_file");
    const mbr = safeObjName(member, "member");
    const qsys = `/QSYS.LIB/${lib}.LIB/${spf}.FILE/${mbr}.MBR`;
    const ts = Date.now();
    const bkp = `/tmp/mcp_backup/${lib}_${spf}_${mbr}_${ts}.txt`;
    const tmp = `/tmp/mcp_write_${ts}.txt`;
    // Ensure backup dir exists
    await exec(`mkdir -p /tmp/mcp_backup`);
    // Backup current member
    await exec(`system "CPYTOSTMF FROMMBR('${qsys}') TOSTMF('${bkp}') STMFOPT(*REPLACE) STMFCCSID(1208)" 2>&1`).catch(() => {/* member may be new/empty */});
    // Write new content via SFTP
    await sftpWrite(tmp, content);
    // Copy into SRCPF member
    await exec(`system "CPYFRMSTMF FROMSTMF('${tmp}') TOMBR('${qsys}') MBROPT(*REPLACE) STMFCCSID(*STMF)" 2>&1`);
    // Cleanup temp file
    await exec(`rm -f ${tmp}`).catch(() => {});
    return ok(`Member ${lib}/${spf}(${mbr}) written successfully.\nBackup saved: ${bkp}`);
  } catch (e) { return err(String(e)); }
});

server.registerTool("create_source_member", {
  description: "Create a new source member in a SRCPF with initial content.",
  inputSchema: {
    library:     z.string().describe("Library name"),
    source_file: z.string().describe("Source physical file (e.g. QRPGLESRC)"),
    member:      z.string().describe("New member name"),
    source_type: z.string().describe("Source type (RPGLE, CLLE, PF, LF, DSPF, PRTF, CMD, SQLRPGLE, etc.)"),
    text:        z.string().describe("Member description text").optional(),
    content:     z.string().describe("Initial source code content (UTF-8)").optional(),
  },
}, async ({ library, source_file, member, source_type, text, content }) => {
  try {
    const lib  = safeObjName(library, "library");
    const spf  = safeObjName(source_file, "source_file");
    const mbr  = safeObjName(member, "member");
    const typ  = source_type.toUpperCase();
    const desc = text ? ` TEXT('${text.replace(/'/g, "''")}')` : "";
    // Add the member
    await exec(`system "ADDPFM FILE(${lib}/${spf}) MBR(${mbr}) SRCTYPE(${typ})${desc}" 2>&1`);
    // Write content if provided
    if (content) {
      const qsys = `/QSYS.LIB/${lib}.LIB/${spf}.FILE/${mbr}.MBR`;
      const tmp = `/tmp/mcp_create_${Date.now()}.txt`;
      await sftpWrite(tmp, content);
      await exec(`system "CPYFRMSTMF FROMSTMF('${tmp}') TOMBR('${qsys}') MBROPT(*REPLACE) STMFCCSID(*STMF)" 2>&1`);
      await exec(`rm -f ${tmp}`).catch(() => {});
    }
    return ok(`Member ${lib}/${spf}(${mbr}) created as ${typ}.`);
  } catch (e) { return err(String(e)); }
});

server.registerTool("delete_source_member", {
  description: "Delete a source member from a SRCPF. Backs up to /tmp/mcp_backup/ before deletion.",
  inputSchema: {
    library:     z.string().describe("Library name"),
    source_file: z.string().describe("Source physical file"),
    member:      z.string().describe("Member to delete"),
  },
}, async ({ library, source_file, member }) => {
  try {
    const lib = safeObjName(library, "library");
    const spf = safeObjName(source_file, "source_file");
    const mbr = safeObjName(member, "member");
    const qsys = `/QSYS.LIB/${lib}.LIB/${spf}.FILE/${mbr}.MBR`;
    const bkp = `/tmp/mcp_backup/${lib}_${spf}_${mbr}_${Date.now()}.txt`;
    await exec(`mkdir -p /tmp/mcp_backup`);
    await exec(`system "CPYTOSTMF FROMMBR('${qsys}') TOSTMF('${bkp}') STMFOPT(*REPLACE) STMFCCSID(1208)" 2>&1`).catch(() => {});
    await exec(`system "RMVM FILE(${lib}/${spf}) MBR(${mbr})" 2>&1`);
    return ok(`Member ${lib}/${spf}(${mbr}) deleted.\nBackup: ${bkp}`);
  } catch (e) { return err(String(e)); }
});

server.registerTool("search_source_content", {
  description: "Search for a text pattern within source code in a SRCPF. Searches across all members or a specific member.",
  inputSchema: {
    library:     z.string().describe("Library name"),
    source_file: z.string().describe("Source physical file (e.g. QRPGLESRC)"),
    pattern:     z.string().describe("Text pattern to search for (case-insensitive)"),
    member:      z.string().describe("Specific member to search, or *ALL for all members").optional(),
    max_results: z.number().int().min(1).max(500).describe("Max matching lines (default 100)").optional(),
  },
}, async ({ library, source_file, pattern, member = "*ALL", max_results = 100 }) => {
  try {
    const lib = safeObjName(library, "library");
    const spf = safeObjName(source_file, "source_file");
    const safePat = pattern.replace(/"/g, '\\"').replace(/'/g, "'");
    if (member !== "*ALL") {
      const mbr = safeObjName(member, "member");
      const qsys = `/QSYS.LIB/${lib}.LIB/${spf}.FILE/${mbr}.MBR`;
      const result = await exec(`/QOpenSys/usr/bin/iconv -f IBM-037 -t UTF-8 "${qsys}" 2>/dev/null | grep -in "${safePat}" | head -${max_results}`);
      return ok(result || "(no matches)");
    }
    // Search all members
    const cmd = `for f in /QSYS.LIB/${lib}.LIB/${spf}.FILE/*.MBR; do r=$(/QOpenSys/usr/bin/iconv -f IBM-037 -t UTF-8 "$f" 2>/dev/null | grep -in "${safePat}" | head -5); if [ -n "$r" ]; then echo "=== $(basename $f .MBR) ==="; echo "$r"; fi; done | head -${max_results * 2}`;
    const result = await exec(cmd, getEnv().sqlTimeoutMs);
    return ok(result || "(no matches)");
  } catch (e) { return err(String(e)); }
});

// ===== GROUP 4 — SQL Query Execution =====

server.registerTool("run_sql", {
  description: "Execute any SQL statement with parameterized query support using db2util. Supports SELECT, INSERT, UPDATE, DELETE, CALL, CREATE, ALTER. Use ? placeholders and pass values in params array. Returns CSV output. For DML/DDL, set allow_modify=true.",
  inputSchema: {
    sql:          z.string().describe("SQL statement with ? placeholders (e.g. 'SELECT * FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?')"),
    params:       z.array(z.string()).describe("Parameter values for ? placeholders, in order").optional(),
    allow_modify: z.boolean().describe("Set true for INSERT/UPDATE/DELETE/CREATE/ALTER/DROP (default false)").optional(),
    max_rows:     z.number().int().min(1).max(5000).describe("Max rows (default 200)").optional(),
  },
}, async ({ sql, params = [], allow_modify = false, max_rows = 200 }) => {
  try {
    const t = sql.trim().toUpperCase();
    const isModify = !t.startsWith("SELECT") && !t.startsWith("WITH") && !t.startsWith("VALUES");
    if (isModify && !allow_modify)
      return err("This is a modifying statement. Set allow_modify=true to execute INSERT/UPDATE/DELETE/DDL.");
    return ok(fmtRows(await execSqlParam(sql, params, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("run_sql_query", {
  description: "Execute any SQL SELECT query against IBM i DB2. Library list is automatically prepended.",
  inputSchema: {
    sql:      z.string().describe("SQL SELECT statement to execute"),
    max_rows: z.number().int().min(1).max(1000).describe("Max rows (default 200)").optional(),
  },
}, async ({ sql, max_rows = 200 }) => {
  try {
    const t = sql.trim().toUpperCase();
    if (!t.startsWith("SELECT") && !t.startsWith("WITH") && !t.startsWith("VALUES"))
      return err("Only SELECT/WITH/VALUES queries allowed.");
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("search_data_in_file", {
  description: "Search records in any IBM i file with up to 3 field/value filters.",
  inputSchema: {
    library:   z.string().describe("Library name"),
    file_name: z.string().describe("File/table name"),
    field1: z.string().describe("First field name to filter on").optional(),
    value1: z.string().describe("Value to match for field1").optional(),
    field2: z.string().describe("Second field name to filter on").optional(),
    value2: z.string().describe("Value to match for field2").optional(),
    field3: z.string().describe("Third field name to filter on").optional(),
    value3: z.string().describe("Value to match for field3").optional(),
    max_rows: z.number().int().min(1).max(500).describe("Max records (default 50)").optional(),
  },
}, async ({ library, file_name, field1, value1, field2, value2, field3, value3, max_rows = 50 }) => {
  try {
    const lib     = safeObjName(library, "library");
    const fil     = safeObjName(file_name, "file");
    const clauses: string[] = [];
    if (field1 && value1) clauses.push(`${field1.toUpperCase()} = '${value1}'`);
    if (field2 && value2) clauses.push(`${field2.toUpperCase()} = '${value2}'`);
    if (field3 && value3) clauses.push(`${field3.toUpperCase()} = '${value3}'`);
    const where   = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const sql     = `SELECT * FROM ${lib}.${fil} ${where} FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("describe_sql_object", {
  description: "Show metadata for an IBM i database object (TABLE, VIEW, PROCEDURE, etc.).",
  inputSchema: {
    object_name:    z.string().describe("Object name"),
    object_library: z.string().describe("Library where the object lives").optional(),
    object_type:    z.enum(["TABLE","VIEW","INDEX","PROCEDURE","FUNCTION","TRIGGER","ALIAS","SEQUENCE"]).describe("Object type (default TABLE)").optional(),
  },
}, async ({ object_name, object_library = "QSYS2", object_type = "TABLE" }) => {
  try {
    const obj = safeObjName(object_name, "object");
    const lib = safeObjName(object_library, "library");
    const sql = object_type === "TABLE"
      ? `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_TEXT FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = '${lib}' AND TABLE_NAME = '${obj}'`
      : `SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, CAST(ROUTINE_DEFINITION AS VARCHAR(4000)) AS DEF FROM QSYS2.SYSROUTINES WHERE ROUTINE_SCHEMA = '${lib}' AND ROUTINE_NAME = '${obj}'`;
    return ok(fmtRows(await execSql(sql)));
  } catch (e) { return err(String(e)); }
});

// ===== GROUP 5 — CL Command Execution =====

server.registerTool("execute_cl_command", {
  description: "Execute a CL command on IBM i via SSH. Library list is prepended automatically.",
  inputSchema: {
    command:          z.string().describe("CL command to execute (e.g. DSPLIB QGPL)"),
    add_library_list: z.boolean().describe("Prepend configured library list (default true)").optional(),
  },
}, async ({ command, add_library_list = true }) => {
  try {
    const prefix = add_library_list ? libListPrefix() : "";
    const safe   = command.replace(/"/g, '\\"');
    return ok((await exec(`${prefix}system "${safe}" 2>&1`)) || "(no output)");
  } catch (e) { return err(String(e)); }
});

server.registerTool("execute_pase_command", {
  description: "Execute a raw PASE/shell command on IBM i (advanced use).",
  inputSchema: {
    command: z.string().describe("Shell command to execute in IBM i PASE environment"),
  },
}, async ({ command }) => {
  try { return ok((await exec(command)) || "(no output)"); }
  catch (e) { return err(String(e)); }
});

// ===== GROUP 6 — Job & System Monitoring =====

server.registerTool("list_active_jobs", {
  description: "List currently active jobs on IBM i.",
  inputSchema: {
    user_filter:      z.string().describe("Filter by user name, or *ALL").optional(),
    subsystem_filter: z.string().describe("Filter by subsystem name, or *ALL").optional(),
    max_rows:         z.number().int().min(1).max(200).describe("Max jobs (default 50)").optional(),
  },
}, async ({ user_filter = "*ALL", subsystem_filter = "*ALL", max_rows = 50 }) => {
  try {
    const uC  = user_filter      !== "*ALL" ? `AND AUTHORIZATION_NAME = '${user_filter.toUpperCase()}'`  : "";
    const sC  = subsystem_filter !== "*ALL" ? `AND SUBSYSTEM = '${subsystem_filter.toUpperCase()}'`       : "";
    const sql = `SELECT JOB_NAME, AUTHORIZATION_NAME, JOB_STATUS, SUBSYSTEM, CPU_TIME, FUNCTION FROM QSYS2.ACTIVE_JOB_INFO WHERE 1=1 ${uC} ${sC} ORDER BY CPU_TIME DESC FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_job_log", {
  description: "Get recent messages from a specific IBM i job log.",
  inputSchema: {
    job_name:     z.string().describe("Fully qualified job name in format NUMBER/USER/NAME"),
    max_rows:     z.number().int().min(1).max(500).describe("Max log entries (default 100)").optional(),
    min_severity: z.number().int().min(0).max(99).describe("Min severity: 0=info, 20=warning, 30=error").optional(),
  },
}, async ({ job_name, max_rows = 100, min_severity = 0 }) => {
  try {
    const parts = job_name.split("/");
    if (parts.length !== 3) return err("Job name must be NUMBER/USER/NAME");
    const [jobNbr, jobUser, jobName] = parts;
    const sql = `SELECT MESSAGE_TIMESTAMP, MESSAGE_ID, MESSAGE_TYPE, MESSAGE_SEVERITY, MESSAGE_TEXT FROM QSYS2.JOBLOG_INFO('${jobName}', '${jobUser}', '${jobNbr}') WHERE MESSAGE_SEVERITY >= ${min_severity} ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("check_message_queue", {
  description: "Check messages in a message queue (e.g. QSYSOPR, QHST) for system alerts.",
  inputSchema: {
    queue_name:    z.string().describe("Message queue name (e.g. QSYSOPR, QHST)").optional(),
    queue_library: z.string().describe("Message queue library (default QSYS)").optional(),
    max_rows:      z.number().int().min(1).max(200).describe("Max messages (default 50)").optional(),
    min_severity:  z.number().int().min(0).max(99).describe("Min severity (0=all, 30=errors)").optional(),
  },
}, async ({ queue_name = "QSYSOPR", queue_library = "QSYS", max_rows = 50, min_severity = 0 }) => {
  try {
    const q    = safeObjName(queue_name, "queue");
    const qlib = safeObjName(queue_library, "queue_library");
    return ok(fmtRows(await exec(`system "DSPMSG MSGQ(${qlib}/${q}) SEV(${min_severity})" 2>&1 | head -${max_rows * 3}`), max_rows * 3));
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_system_disk_usage", {
  description: "Check disk usage and ASP utilization.",
  inputSchema: {},
}, async () => {
  try {
    return ok(fmtRows(await execSql(`SELECT ASP_NUMBER, RESOURCE_NAME, ASP_TYPE, TOTAL_CAPACITY, TOTAL_CAPACITY_AVAILABLE FROM QSYS2.ASP_INFO`)));
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_system_values", {
  description: "Read IBM i system values (date/time format, security settings, etc.).",
  inputSchema: {
    sysval_filter: z.string().describe("Filter by system value name (e.g. QDATE, QTIME, or *ALL)").optional(),
    max_rows:      z.number().int().min(1).max(200).describe("Max values (default 50)").optional(),
  },
}, async ({ sysval_filter = "*ALL", max_rows = 50 }) => {
  try {
    const where = sysval_filter !== "*ALL" ? `WHERE SYSTEM_VALUE_NAME LIKE '%${sysval_filter.toUpperCase()}%'` : "";
    const sql   = `SELECT SYSTEM_VALUE_NAME, CURRENT_NUMERIC_VALUE, CURRENT_CHARACTER_VALUE FROM QSYS2.SYSTEM_VALUE_INFO ${where} FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_sql_history", {
  description: "View recent SQL statements executed on the IBM i system.",
  inputSchema: {
    job_filter: z.string().describe("Filter by job name (partial match), or empty for all").optional(),
    max_rows:   z.number().int().min(1).max(200).describe("Max statements (default 50)").optional(),
  },
}, async ({ job_filter = "", max_rows = 50 }) => {
  try {
    const jobC = job_filter ? `WHERE JOB_NAME LIKE '%${job_filter.toUpperCase()}%'` : "";
    const sql  = `SELECT JOB_NAME, QUERY_USE_TIME, QUERY_READS, STATEMENT_TEXT FROM QSYS2.SQL_ACTIVITY ${jobC} ORDER BY QUERY_USE_TIME DESC FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

// ===== GROUP 7 — Impact Analysis & Auditing =====

server.registerTool("find_programs_using_file", {
  description: "Find all programs that reference a specific file — impact analysis for schema changes.",
  inputSchema: {
    file_name:    z.string().describe("File name to find references for (partial match)"),
    file_library: z.string().describe("Library containing the file").optional(),
    max_rows:     z.number().int().min(1).max(500).describe("Max results (default 100)").optional(),
  },
}, async ({ file_name, file_library, max_rows = 100 }) => {
  try {
    const libC = file_library ? `AND OBJECT_SCHEMA = '${safeObjName(file_library, "file_library")}'` : "";
    const sql  = `SELECT PROGRAM_SCHEMA, PROGRAM_NAME, OBJECT_SCHEMA, OBJECT_NAME, OBJECT_TYPE FROM QSYS2.PROGRAM_INFO WHERE OBJECT_NAME LIKE '%${file_name.toUpperCase()}%' ${libC} FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_table_changes", {
  description: "Retrieve recent INSERT/UPDATE/DELETE changes via DB2 journal — for auditing.",
  inputSchema: {
    journal_library: z.string().describe("Library containing the journal"),
    journal_name:    z.string().describe("Journal name (e.g. QSJJRN, FSRJRN)"),
    file_name:       z.string().describe("File to audit"),
    file_library:    z.string().describe("Library containing the file"),
    hours:           z.number().int().min(1).max(720).describe("Look back this many hours (default 24)").optional(),
    max_rows:        z.number().int().min(1).max(500).describe("Max journal entries (default 100)").optional(),
  },
}, async ({ journal_library, journal_name, file_name, file_library, hours = 24, max_rows = 100 }) => {
  try {
    const jlib = safeObjName(journal_library, "journal_library");
    const jrn  = safeObjName(journal_name, "journal");
    const flib = safeObjName(file_library, "file_library");
    const fil  = safeObjName(file_name, "file");
    const sql  = `SELECT ENTRY_TIMESTAMP, JOURNAL_CODE, ENTRY_TYPE, JOB_NAME, USER_NAME FROM TABLE(QSYS2.DISPLAY_JOURNAL(JOURNAL_LIBRARY => '${jlib}', JOURNAL_NAME => '${jrn}', OBJECT_SCHEMA => '${flib}', OBJECT_NAME => '${fil}', STARTING_TIMESTAMP => CURRENT_TIMESTAMP - ${hours} HOURS)) WHERE JOURNAL_CODE IN ('R') ORDER BY ENTRY_TIMESTAMP DESC FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("get_library_list", {
  description: "Show the current job's library list.",
  inputSchema: {},
}, async () => {
  try {
    return ok(fmtRows(await execSql(`SELECT ORDINAL_POSITION, SCHEMA_NAME, SCHEMA_TEXT, TYPE FROM QSYS2.LIBRARY_LIST_INFO ORDER BY ORDINAL_POSITION`)));
  } catch (e) { return err(String(e)); }
});

server.registerTool("read_data_area", {
  description: "Read a data area (*DTAARA) — commonly used for configuration and control values.",
  inputSchema: {
    library:   z.string().describe("Library containing the data area(s)"),
    area_name: z.string().describe("Data area name, or *ALL for all data areas in the library").optional(),
  },
}, async ({ library, area_name = "*ALL" }) => {
  try {
    const lib = safeObjName(library, "library");
    if (area_name === "*ALL") {
      return ok(fmtRows(await execSql(`SELECT DATA_AREA_SCHEMA, DATA_AREA_NAME, DATA_AREA_TYPE, LENGTH, DATA_AREA_VALUE FROM QSYS2.DATA_AREA_INFO WHERE DATA_AREA_SCHEMA = '${lib}'`)));
    }
    const da = safeObjName(area_name, "area");
    return ok((await exec(`system "RTVDTAARA DTAARA(${lib}/${da})" 2>&1`)) || "(empty)");
  } catch (e) { return err(String(e)); }
});

// ===== GROUP 8 — IFS File Operations =====

server.registerTool("list_ifs_directory", {
  description: "List contents of an IFS directory on IBM i.",
  inputSchema: {
    path:     z.string().describe("IFS directory path (e.g. /home/SHOLON, /tmp)"),
    max_rows: z.number().int().min(1).max(500).describe("Max entries (default 100)").optional(),
  },
}, async ({ path, max_rows = 100 }) => {
  try {
    return ok(await exec(`ls -la "${path}" 2>&1 | head -${max_rows + 2}`));
  } catch (e) { return err(String(e)); }
});

server.registerTool("read_ifs_file", {
  description: "Read an IFS stream file with EBCDIC→UTF-8 fallback.",
  inputSchema: {
    path:      z.string().describe("Full IFS path to the file"),
    max_lines: z.number().int().min(1).max(5000).describe("Max lines (default 500)").optional(),
  },
}, async ({ path, max_lines = 500 }) => {
  try {
    return ok((await exec(`cat "${path}" 2>&1 | head -${max_lines}`)) || "(empty file)");
  } catch (e) { return err(String(e)); }
});

server.registerTool("write_ifs_file", {
  description: "Write content to an IFS stream file via SFTP.",
  inputSchema: {
    path:    z.string().describe("Full IFS path to write"),
    content: z.string().describe("File content (UTF-8)"),
  },
}, async ({ path, content }) => {
  try {
    await sftpWrite(path, content);
    return ok(`Written to ${path} (${content.length} bytes)`);
  } catch (e) { return err(String(e)); }
});

// ===== GROUP 9 — Spool File Operations =====

server.registerTool("list_spool_files", {
  description: "List spool files for a user.",
  inputSchema: {
    user:     z.string().describe("User profile").optional(),
    max_rows: z.number().int().min(1).max(200).describe("Max results (default 50)").optional(),
  },
}, async ({ user, max_rows = 50 }) => {
  try {
    const u = (user ?? getEnv().user).toUpperCase();
    const sql = `SELECT SPOOLED_FILE_NAME, JOB_NAME, FILE_NUMBER, TOTAL_PAGES, STATUS, CREATE_TIMESTAMP FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE JOB_USER = '${u}' ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST ${max_rows} ROWS ONLY`;
    return ok(fmtRows(await execSql(sql, max_rows), max_rows));
  } catch (e) { return err(String(e)); }
});

server.registerTool("view_spool_file", {
  description: "View spool file content by copying to temp IFS file.",
  inputSchema: {
    spooled_file: z.string().describe("Spool file name"),
    job_name:     z.string().describe("Job name NUMBER/USER/NAME"),
    file_number:  z.number().int().describe("Spool file number"),
    max_lines:    z.number().int().min(1).max(5000).describe("Max lines (default 500)").optional(),
  },
}, async ({ spooled_file, job_name, file_number, max_lines = 500 }) => {
  try {
    const splf = safeObjName(spooled_file, "spool_file");
    const parts = job_name.split("/");
    if (parts.length !== 3) return err("Job name must be NUMBER/USER/NAME");
    const tmp = `/tmp/mcp_spool_${Date.now()}.txt`;
    await exec(`system "CPYSPLF FILE(${splf}) TOFILE(*TOSTMF) TOSTMF('${tmp}') JOB(${parts[0]}/${parts[1]}/${parts[2]}) SPLNBR(${file_number}) STMFOPT(*REPLACE)" 2>&1`);
    const content = await exec(`cat "${tmp}" 2>&1 | head -${max_lines}`);
    await exec(`rm -f "${tmp}"`).catch(() => {});
    return ok(content || "(empty spool file)");
  } catch (e) { return err(String(e)); }
});

// ===== GROUP 10 — Program Build & Execute =====

server.registerTool("compile_program", {
  description: "Compile IBM i program from SRCPF member. Auto-detects source type. Returns compile errors only.",
  inputSchema: {
    library:        z.string().describe("Target library for compiled object"),
    source_library: z.string().describe("Library containing the source"),
    source_file:    z.string().describe("Source physical file (e.g. QRPGLESRC)"),
    member:         z.string().describe("Source member name"),
    compile_type:   z.string().describe("Override: RPGLE, SQLRPGLE, CLLE, PF, LF, DSPF, PRTF, CMD").optional(),
    options:        z.string().describe("Extra compile params (e.g. DBGVIEW(*LIST))").optional(),
  },
}, async ({ library, source_library, source_file, member, compile_type, options = "" }) => {
  try {
    const tgtLib = safeObjName(library, "library");
    const srcLib = safeObjName(source_library, "source_library");
    const srcFil = safeObjName(source_file, "source_file");
    const mbr    = safeObjName(member, "member");
    let srcType = compile_type?.toUpperCase();
    if (!srcType) {
      const r = await execSql(`SELECT SOURCE_TYPE FROM QSYS2.MEMBER_INFO WHERE SOURCE_FILE_LIBRARY='${srcLib}' AND SOURCE_FILE='${srcFil}' AND SOURCE_MEMBER='${mbr}'`);
      srcType = r.split("\n").filter(l => l.trim())[0]?.replace(/"/g, "").trim().toUpperCase();
    }
    if (!srcType) return err("Cannot determine source type. Specify compile_type.");
    const m = COMPILE_MAP[srcType];
    if (!m) return err(`Unknown type '${srcType}'. Supported: ${Object.keys(COMPILE_MAP).join(", ")}`);
    const objType = srcType === "SQLRPGLE" ? " OBJTYPE(*PGM)" : "";
    const cl = `${m.cmd} ${m.objKey}(${tgtLib}/${mbr}) SRCFILE(${srcLib}/${srcFil}) SRCMBR(${mbr})${objType} ${options}`.trim();
    const result = await exec(`${libSetup([tgtLib, srcLib])}system "${cl.replace(/"/g, '\\"')}" 2>&1`, getEnv().sqlTimeoutMs);
    const lines = result.split("\n");
    const errors = lines.filter(l => /\b(CPF|CPD|MCH|RNF|SQL)\d{4}\b/.test(l) || /severity [3-9]/i.test(l));
    if (errors.length > 0) return err(`Compile failed:\n${errors.join("\n")}`);
    return ok(`Compiled ${srcType} ${srcLib}/${srcFil}(${mbr}) → ${tgtLib}/${mbr} [${m.cmd}]\n${lines.filter(l => /CPC|complete/i.test(l)).join("\n") || "OK"}`);
  } catch (e) { return err(String(e)); }
});

server.registerTool("call_program", {
  description: "Call an IBM i program with optional parameters.",
  inputSchema: {
    library:    z.string().describe("Library containing the program"),
    program:    z.string().describe("Program name"),
    parameters: z.string().describe("Space-separated parameter values").optional(),
  },
}, async ({ library, program, parameters = "" }) => {
  try {
    const lib = safeObjName(library, "library");
    const pgm = safeObjName(program, "program");
    const parms = parameters ? ` PARM(${parameters})` : "";
    const result = await exec(`${libSetup([lib])}system "CALL PGM(${lib}/${pgm})${parms}" 2>&1`, getEnv().sqlTimeoutMs);
    return ok(result || "(program completed with no output)");
  } catch (e) { return err(String(e)); }
});

server.registerTool("submit_job", {
  description: "Submit a batch job on IBM i using SBMJOB.",
  inputSchema: {
    command:   z.string().describe("CL command to submit"),
    job_name:  z.string().describe("Job name for the submitted job").optional(),
    job_queue: z.string().describe("Job queue (default QBATCH)").optional(),
  },
}, async ({ command, job_name, job_queue }) => {
  try {
    const safe = command.replace(/"/g, '\\"');
    let cl = `SBMJOB CMD(${safe})`;
    if (job_name)  cl += ` JOB(${safeObjName(job_name, "job_name")})`;
    if (job_queue) cl += ` JOBQ(${job_queue})`;
    const result = await exec(`${libSetup()}system "${cl.replace(/"/g, '\\"')}" 2>&1`);
    return ok(result || "(job submitted)");
  } catch (e) { return err(String(e)); }
});

// --- Start Server -----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
