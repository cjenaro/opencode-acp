# opencode-acp

ACP adapter for [opencode](https://opencode.ai) - enables ACP-compatible editors to use opencode as their coding agent.

## What is this?

This project implements an [Agent Client Protocol (ACP)](https://agentclientprotocol.com) adapter for opencode, allowing any ACP-compatible editor or IDE to use opencode as their AI coding assistant.

## Features

- 🔌 Works with ACP-compatible editors (Zed, Neovim, Emacs, etc.)
- 🤖 Full opencode capabilities via the opencode SDK
- 🛠️ Support for tool calls and file operations
- 💬 Real-time streaming responses
- 🎯 Multiple model support
- 🔧 MCP (Model Context Protocol) server support

## Installation

```bash
npm install -g opencode-acp
```

## Usage

### Prerequisites

Make sure you have opencode installed and configured. The adapter will connect to the opencode server (default: `http://localhost:4096`).

### With Zed

Add to your Zed settings:

```json
{
  "agents": {
    "opencode": {
      "command": "opencode-acp"
    }
  }
}
```

### With Neovim

Coming soon...

### With Emacs

Coming soon...

## Configuration

Environment variables:

- `OPENCODE_BASE_URL` - opencode server URL (default: `http://localhost:4096`)
- `OPENCODE_TIMEOUT` - Connection timeout in milliseconds (default: `5000`)

## Development

### Setup

```bash
git clone https://github.com/YOUR_USERNAME/opencode-acp.git
cd opencode-acp
bun install
```

### Build

```bash
bun run build
```

### Development Mode

```bash
bun run dev
```

### Testing

```bash
bun test
```

## How it Works

The adapter acts as a bridge between ACP clients and the opencode server:

```
┌─────────────┐         JSON-RPC         ┌──────────────┐        HTTP         ┌────────────┐
│             │◄──────── over stdio ─────►│              │◄────── API ────────►│            │
│ ACP Client  │                           │ opencode-acp │                     │  opencode  │
│  (Zed)      │                           │   (adapter)  │                     │   server   │
└─────────────┘                           └──────────────┘                     └────────────┘
```

1. The editor communicates with opencode-acp via JSON-RPC over stdin/stdout
2. opencode-acp translates ACP messages to opencode SDK calls
3. Responses from opencode are converted back to ACP format and sent to the editor

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

Apache-2.0

## Links

- [opencode](https://opencode.ai)
- [Agent Client Protocol](https://agentclientprotocol.com)
- [opencode SDK Documentation](https://opencode.ai/docs/sdk/)
