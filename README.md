<p align="center">
  <img src="https://raw.githubusercontent.com/krzysztofsurdy/snipaya-mcp/main/assets/snipaya-icon.png" width="128" height="128" alt="Snipaya app icon">
</p>

<h1 align="center">snipaya-mcp</h1>

<p align="center">
  <a href="https://github.com/krzysztofsurdy/snipaya-mcp/actions/workflows/ci.yml"><img src="https://github.com/krzysztofsurdy/snipaya-mcp/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://www.npmjs.com/package/snipaya-mcp"><img src="https://img.shields.io/npm/v/snipaya-mcp" alt="npm version"></a>
  <a href="https://github.com/krzysztofsurdy/snipaya-mcp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/krzysztofsurdy/snipaya-mcp" alt="MIT license"></a>
</p>

Connect any MCP client that speaks stdio to [Snipaya](https://snipaya.app), the image and screenshot annotator for macOS. Your assistant can read the canvas, add arrows, text, shapes and callouts, redact sensitive data, crop, and export, while you watch the result in Snipaya.

Snipaya has an MCP server built in, served over Streamable HTTP on `127.0.0.1`. `snipaya-mcp` is a thin bridge for clients that only start local stdio servers: it forwards every MCP message between the client and Snipaya, unchanged.

<!-- Demo GIF: replace with docs/demo.gif once recorded -->
<!-- ![snipaya-mcp demo](docs/demo.gif) -->

## Requirements

- [Snipaya](https://snipaya.app) for macOS. It comes with a 14-day free trial.
- Node.js 20 or newer (for the `npx` setup).

## Turn on the MCP server in Snipaya

The server is off by default.

1. Open Snipaya, then **Settings > AI Assistants**.
2. Turn on **Allow AI assistants**. The status changes to **Running**.

That is all the bridge needs. It reads the access token and port from the settings Snipaya saves on this Mac, so you do not have to copy them.

## Setup

### npx

```sh
npx -y snipaya-mcp
```

If Snipaya is not running but **Allow AI assistants** is on, the bridge opens Snipaya in the background and waits up to 10 seconds for its server.

To override what Snipaya saved, set these variables or flags. Flags win over variables, and variables win over the saved settings.

| Variable | Flag | Default | |
| --- | --- | --- | --- |
| `SNIPAYA_MCP_TOKEN` | `--token` | Token Snipaya saved | Access token from **Settings > AI Assistants**. |
| `SNIPAYA_MCP_URL` | `--url` | `http://127.0.0.1:<saved port>/mcp`, else `http://127.0.0.1:47321/mcp` | Server URL from Snipaya. Only `127.0.0.1` and `localhost` are accepted. |
| `SNIPAYA_MCP_NO_LAUNCH` | | | Set to `1` to never open Snipaya. The bridge then fails with `Cannot reach Snipaya` while Snipaya is closed. |

Prefer the environment variable over `--token`: command-line flags are visible to other processes on the Mac.

### JSON config

For clients configured with an `mcpServers` JSON file:

```json
{
  "mcpServers": {
    "snipaya": {
      "command": "npx",
      "args": ["-y", "snipaya-mcp"]
    }
  }
}
```

For a custom setup, pass the values in `env` instead:

```json
{
  "mcpServers": {
    "snipaya": {
      "command": "npx",
      "args": ["-y", "snipaya-mcp"],
      "env": {
        "SNIPAYA_MCP_TOKEN": "<access token>",
        "SNIPAYA_MCP_URL": "<server url>"
      }
    }
  }
}
```

If your client supports Streamable HTTP servers directly, you do not need this bridge: use **Copy MCP config** in Snipaya instead.

### MCP Bundle (.mcpb)

1. Download `snipaya-mcp-<version>.mcpb` from the [latest release](https://github.com/krzysztofsurdy/snipaya-mcp/releases/latest).
2. Open it with an MCP client that supports MCP Bundles, or drag it into the client's extensions settings.
3. Leave the token empty to use the one Snipaya saved, or paste the access token from Snipaya. Leave the URL at its default unless Snipaya shows a different one.

## Security model

- **Local only.** Snipaya's server listens on `127.0.0.1` and accepts only loopback `Host` headers and requests without an `Origin` header, so websites in your browser cannot reach it. The bridge refuses any URL whose host is not `127.0.0.1` or `localhost`, and never sends an `Origin` header.
- **Off by default.** Nothing listens until you turn on **Allow AI assistants**.
- **Token.** Every request carries `Authorization: Bearer <token>`. Snipaya generates the token, and **Regenerate** in Settings revokes the old one. The bridge never writes the token to its logs.
- **Saved settings.** Without `SNIPAYA_MCP_TOKEN`, the bridge reads the token and port from `~/Library/Application Support/Snipaya/mcp.json`, which Snipaya writes readable only by your macOS user. The bridge never writes to it.
- **Opening Snipaya.** Only on macOS and only when **Allow AI assistants** is on, the bridge first sends one request without the token to see whether Snipaya answers. If the connection is refused, it runs `open -g -b dev.snipaya.app` (no shell) and retries. Any other failure, such as a rejected token, never opens the app. `SNIPAYA_MCP_NO_LAUNCH=1` turns this off.
- **The bridge only forwards.** It adds no tools, stores nothing, and connects only to Snipaya. All actions run inside Snipaya, which shows connected assistants and recent activity in **Settings > AI Assistants**.

## Tools

The tools come from the Snipaya version you have installed. Snipaya 1.0 provides:

| Tool | Title |
| --- | --- |
| `snipaya_get_canvas` | Get canvas |
| `snipaya_render` | Render canvas |
| `snipaya_add_image` | Add image |
| `snipaya_add_arrow` | Add arrow or line |
| `snipaya_add_shape` | Add shape |
| `snipaya_add_text` | Add text |
| `snipaya_add_step` | Add step number |
| `snipaya_add_emoji` | Add emoji |
| `snipaya_add_freehand` | Add freehand stroke |
| `snipaya_add_magnifier` | Add magnifier |
| `snipaya_add_callout` | Add callout |
| `snipaya_add_spotlight` | Add spotlight |
| `snipaya_add_measure` | Add measurement |
| `snipaya_pick_color` | Pick color |
| `snipaya_read_text` | Read text |
| `snipaya_redact` | Redact sensitive data |
| `snipaya_update_items` | Update elements |
| `snipaya_delete_items` | Delete elements |
| `snipaya_select` | Select elements |
| `snipaya_arrange` | Arrange images |
| `snipaya_set_crop` | Set crop |
| `snipaya_undo` | Undo |
| `snipaya_redo` | Redo |
| `snipaya_tabs` | Manage tabs |
| `snipaya_export` | Export image |
| `snipaya_list_destinations` | List export destinations |
| `snipaya_export_to` | Export to destination |
| `snipaya_save_project` | Save project |

## Troubleshooting

The bridge writes one line to stderr (never stdout, which carries the protocol) and returns the same text as an MCP error to your client.

| Message | Fix |
| --- | --- |
| `Snipaya's settings were not found` | Install Snipaya, open it once and turn on **Allow AI assistants**. Or set `SNIPAYA_MCP_TOKEN`. |
| `Snipaya's MCP server is off` | Turn on **Allow AI assistants** in **Settings > AI Assistants**. |
| `Snipaya's settings ... cannot be read` or `hold no valid token` | Open Snipaya, which rewrites its settings, then check **Allow AI assistants**. Or set `SNIPAYA_MCP_TOKEN`. |
| `Cannot open Snipaya` | Snipaya is not installed in a place macOS can find. Install it from [snipaya.app](https://snipaya.app) or open it yourself. |
| `Opened Snipaya, but its MCP server did not answer` | Open **Settings > AI Assistants** and fix the error shown under the status. |
| `Cannot reach Snipaya at ...` | Open Snipaya and turn on **Allow AI assistants**. If the status shows an error, fix that first. Check that the URL matches **Server URL**. |
| `Snipaya rejected the token` | The token changed, for example after **Regenerate**. Remove `SNIPAYA_MCP_TOKEN` to use the saved token, or copy the current one. |
| `Snipaya ended the session` | Snipaya restarted or the token changed. Restart the snipaya server in your client. |
| `Refusing <host>` | The URL must point to `127.0.0.1` or `localhost`. Copy **Server URL** from Snipaya. |

Run `npx -y snipaya-mcp --help` to see the options.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test          # builds, then runs the bridge over stdio against a local test server
npm run pack:mcpb # builds snipaya-mcp-<version>.mcpb with the official mcpb CLI
```

## License

[MIT](LICENSE)
