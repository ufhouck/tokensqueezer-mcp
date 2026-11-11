# tokensqueezer-mcp

Companion local **Model Context Protocol (MCP)** bridge for the **[TokenSqueezer Figma Plugin](https://www.figma.com/community/plugin/1665050072562427069/)** (`v1.4.1`).

> **Requires the Figma Plugin:** Install **[TokenSqueezer on Figma Community](https://www.figma.com/community/plugin/1665050072562427069/)** to inspect, compress, and stream Figma frames into your AI coding agent.

`tokensqueezer-mcp` connects the Figma plugin to **Cursor, Claude Desktop, Claude Code, Windsurf, and Antigravity** over `localhost:3333` — streaming token-compressed UI code (60–90% fewer tokens across 9 formats), W3C DTCG design tokens, Light/Dark variable modes, WCAG 2.2 contrast audits, multimodal PNG previews, and bidirectional canvas annotations with **100% local-first privacy**.

---

## Quick Start (Zero-Terminal Setup)

### 1. Install the Figma Plugin
Open **[TokenSqueezer on Figma Community](https://www.figma.com/community/plugin/1665050072562427069/)** and run it inside Figma or Dev Mode.

### 2. Add to Your AI Editor's MCP Config
Paste into `~/.cursor/mcp.json`, Claude `claude_desktop_config.json`, Windsurf, or Antigravity `mcp_config.json`:

```json
{
  "mcpServers": {
    "tokensqueezer": {
      "command": "npx",
      "args": ["-y", "tokensqueezer-mcp@latest"]
    }
  }
}
```

When your AI editor loads or refreshes its MCP servers, `tokensqueezer-mcp` automatically starts a lightweight background HTTP listener on `http://localhost:3333` — **no manual terminal required**, even in editors that spawn MCP tools lazily on demand.

### 3. Send Context from Figma
In the TokenSqueezer Figma plugin:
1. Open **Settings → MCP Mode** (shows **✓ Connected**).
2. Select any frame or component and click **Send to MCP**.

---

## Optional CLI Commands

Run interactively in a terminal with live request logs:

```bash
npx -y tokensqueezer-mcp@latest
```

Stop the background `localhost:3333` listener manually at any time:

```bash
npx -y tokensqueezer-mcp@latest --stop
```

---

## Included MCP Capabilities

### 8 Tools
- **`get_figma_context`** — Retrieve squeezed design output in any of 9 formats (`jsx`, `shadcn`, `vue`, `svelte`, `md`, `html`, `tailwind`, `spec`, `dtcg`) with on-the-fly compression (`full`, `compact`, `sparse`) + multimodal PNG preview.
- **`get_design_spec`** — Structured `DESIGN.md` specification with YAML tokens, Light/Dark modes, and WCAG 2.2 audit.
- **`get_design_tokens`** — W3C Design Tokens Community Group (`tokens.json`) export.
- **`list_figma_components`** — Component sets, instances, variant properties, and full hierarchy paths.
- **`compare_selections`** — Token and layer diff between current and previous Figma selections.
- **`get_accessibility_report`** — WCAG 2.2 sRGB relative luminance contrast report.
- **`search_layers`** — Search layers by name, text content, or semantic category.
- **`add_figma_annotation`** — Write AI review notes directly back onto the selected Figma layer.

### 3 Prompts & 3 Resources
- **Prompts:** `implement_component`, `extract_design_tokens`, `audit_accessibility`
- **Resources:** `figma://current-selection`, `figma://design-tokens`, `figma://design-spec`

---

## Privacy & Security

- **Loopback Only:** Accepts connections strictly from `127.0.0.1` / `::1` (`localhost:3333`); external network requests are rejected (`403`).
- **Explicit Consent:** Design context is sent from Figma **only when you click "Send to MCP"**.
- **Local Cache:** Latest selection state is stored locally in `~/.tokensqueezer/` with user-only permissions (`0700` / `0600`), and the background listener automatically exits after 12 hours of inactivity.

---

- **Figma Plugin:** [https://www.figma.com/community/plugin/1665050072562427069/](https://www.figma.com/community/plugin/1665050072562427069/)
- **Author:** [Ufuk Aydin](https://ufukaydin.com) • MIT License
