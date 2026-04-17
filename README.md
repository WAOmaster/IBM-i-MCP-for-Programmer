# PUB400 IBM i MCP Server

This is an MCP (Model Context Protocol) server designed specifically for IBM i Programmers. It enables Gen AI agents (like Claude) to directly interact with IBM i objects, source code, DB2 databases, and system commands via SSH. It is pre-configured and optimized for the `PUB400.COM` public IBM i environment.

## Overview

The **PUB400 IBM i MCP Server** bridges the gap between modern AI assistants and legacy/modern IBM i systems. By exposing a comprehensive suite of tools, an AI agent can assist you with understanding, debugging, modifying, and interacting with RPGLE, CL, DB2 SQL, and the IBM i system itself.

## Features

This MCP server provides a wide array of tools grouped into the following categories:

*   **Connection & Configuration:** Configure credentials for `dev` and `test` environments, and test SSH connectivity.
*   **Library & Object Management:** List libraries and files, describe DB2 file structures, view key fields (access paths), search files by fields, and list system objects.
*   **Source Code Management:** List, read, search, and manage source physical file members (`QRPGLESRC`, `QCLLESRC`, etc.). Handles EBCDIC ↔ UTF-8 conversions transparently.
*   **Source CRUD:** Safely create, update, and delete source members with automatic backups to `/tmp/mcp_backup/`.
*   **SQL Query Execution:** Execute SELECT queries and parameterized modifying statements (INSERT, UPDATE, DELETE, DDL) using `db2util`.
*   **CL & PASE Command Execution:** Run traditional CL commands (with library list support) or raw PASE shell commands.
*   **Job & System Monitoring:** List active jobs, read job logs, check message queues (`QSYSOPR`), view disk usage, and inspect system values.
*   **Impact Analysis:** Find programs referencing specific files for schema change analysis.

## Prerequisites

*   **Node.js**: v18 or higher recommended.
*   An active account on [PUB400.COM](https://pub400.com/) (or another IBM i server with SSH access enabled).
*   An MCP-compatible client (e.g., Claude Desktop, Cursor).

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd IBM-i-MCP-for-Programmer
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Configuration

1. Copy the `.env.template` file to `.env`:
   ```bash
   cp .env.template .env
   ```

2. Open `.env` and fill in your IBM i credentials:
   ```env
   IBMI_ENV=dev
   IBMI_HOST=PUB400.COM
   IBMI_PORT=2222
   IBMI_USER=YOUR_USER
   IBMI_PASSWORD=YOUR_PASSWORD
   IBMI_LIBRARY_LIST=YOURLIB,QGPL
   ```
   *Note: Passwords can also be configured dynamically through the AI assistant once the server is connected, using the `configure_connection` tool.*

## Running the Server

Start the server using Node:

```bash
npm start
```
*(Note: As an MCP server, starting it directly in the terminal will wait for standard input. It is meant to be run via an MCP client.)*

### Development Mode

Run the TypeScript compiler in watch mode:

```bash
npm run dev
```

## IDE / Claude Desktop Integration

To use this server with Claude Desktop, add it to your `claude_desktop_config.json`:

### Windows (`%APPDATA%\Claude\claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "pub400-ibmi": {
      "command": "node",
      "args": [
        "F:/Dev/IBM-i-MCP-for-Programmer/build/index.js"
      ]
    }
  }
}
```

### macOS (`~/Library/Application Support/Claude/claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "pub400-ibmi": {
      "command": "node",
      "args": [
        "/path/to/IBM-i-MCP-for-Programmer/build/index.js"
      ]
    }
  }
}
```
*Make sure to change the path to point to your local project directory.*

## Architecture

*   **Language**: TypeScript
*   **MCP SDK**: `@modelcontextprotocol/sdk`
*   **SSH Integration**: `ssh2` package for persistent connection pooling.
*   **DB2 Access**: Utilizes `/QOpenSys/pkgs/bin/db2util` over SSH for executing SQL statements.
*   **EBCDIC Translation**: Leverages `/QOpenSys/usr/bin/iconv` for source member reading/searching.
