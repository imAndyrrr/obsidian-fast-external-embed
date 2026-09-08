# Fast External Embed

Embed external web pages and files outside your vault using familiar Obsidian embed syntax.

Fast External Embed is a desktop-only plugin for Obsidian. It lets you embed and link to files stored outside your vault (absolute paths, `file:///` URLs) and render external web pages, all using Obsidian's familiar embed and link syntax.

## Features

| Feature | Description |
|---------|-------------|
| External file embeds | Embed PDFs, images, audio, and video stored outside the vault via `![[C:/path]]` or `![](C:/path)`. |
| External file links | Open vault-external files with `[[C:/path]]` wiki links — Obsidian won't create empty notes. |
| Web page embeds | Render external HTTP(S) pages as responsive sandboxed iframes with `![](https://...)`. |
| Progressive PDF reader | Page-by-page lazy rendering with navigation and zoom controls for large PDFs. |
| Dual syntax support | Works with both `![[...]]` wiki embeds and standard Markdown `![](...)` image syntax. |
| View modes | Supports both Reading view and Live Preview. |
| Quick actions | Open local files in the system default app or reveal them in File Explorer. |

## Supported file types

| Category | Extensions |
|----------|-----------|
| PDF | `.pdf` |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp` |
| Video | `.mp4`, `.webm`, `.mkv`, `.mov` |
| Audio | `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, `.aac` |

Other file types will show an error card with a button to open them in the system default application.

## Usage

### External local files

Use an absolute path in a wiki embed:

```md
![[C:/Documents/reference.pdf]]
![[C:\Documents\reference.pdf]]
![[file:///C:/Documents/reference.pdf]]
```

You can also use standard Markdown image syntax for compatible files:

```md
![](C:/Documents/reference.pdf)
![800x600](C:/Documents/diagram.png)
```

### External local file links

You can also use normal wiki links (without the `!`) to open vault-external files:

```md
[[C:/path/to/file.pdf]]
[[C:/path/to/file.pdf|Open local PDF]]
```

Clicking these links opens the file with the system default application instead of creating an empty vault note. Windows absolute paths, `file:///` URLs, and Unix absolute paths are supported, including paths containing `#` (e.g. `C:/#Self/file.pdf`).

### External web pages

Use an external HTTP or HTTPS URL in Markdown image syntax:

```md
![](https://example.com)
![1200x700](https://example.com)
```

The page is rendered in an iframe. Some websites intentionally prohibit iframe embedding through their own security policy; those websites cannot be displayed inside Obsidian by any plugin.

### Size controls

Set an explicit size with the image alt text (applies to all embed types):

```md
![1200x700](https://example.com)
![800x600](C:/Documents/diagram.png)
```

Or use URL fragment parameters for finer control:

```md
![[C:/Documents/reference.pdf#page=3&height=80vh&width=90%]]
```

| Parameter | Applies to | Description |
|-----------|-----------|-------------|
| `page` | PDF | Jump to a specific page on load. |
| `height` | PDF, web pages | Set the embed height (e.g. `600px`, `80vh`). |
| `width` | PDF, web pages | Set the embed width (e.g. `800px`, `90%`). Defaults to `100%`. |

### PDF viewer controls

The built-in PDF reader includes a toolbar with:

- Previous / next page buttons and a page number input.
- Zoom in / zoom out buttons and a zoom percentage label (click to reset to 100%).
- Smooth scrolling across all pages with lazy rendering of distant pages.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Show header and quick actions | On | Display file name, URL, and action buttons above each embed. |
| PDF default height | `75vh` | Default height for PDF embeds. |
| Web/iframe default height | `550px` | Default height for external web page embeds. |
| Enable Live Preview support | On | Render embeds in edit mode when the cursor moves away. Requires a note or plugin reload after changing. |

## Performance

Local PDFs are served through a loopback-only, session-token-protected endpoint with HTTP byte-range support. Obsidian's bundled PDF.js renders pages as they approach the visible area, so you can scroll and continue reading without waiting for the complete file to load. This improves first-page latency and substantially reduces memory pressure for large scanned PDFs.

Pages far from the current scroll position are automatically evicted from the canvas, limiting memory usage in notes containing multiple or very large documents.

Other compatible local media types (images, audio, video) are loaded via short-lived in-memory Blob URLs with a bounded 200 MB LRU cache. Close the note or reload the plugin to release cached media data.

## How it works

- **PDFs**: The plugin starts a lightweight local HTTP server bound to `127.0.0.1` that supports HTTP Range requests. PDF.js requests only the byte ranges needed for visible pages, enabling instant page access even in multi-hundred-MB files.
- **Images / audio / video**: Files are read directly with Node.js `fs` and converted to Blob URLs for the browser renderer.
- **Web pages**: Rendered in sandboxed `<iframe>` elements with `allow-scripts`, `allow-forms`, and `allow-presentation`.
- **Local links**: A global click interceptor catches `[[C:/...]]` wiki links and routes them to the system default application via Electron's `shell.openPath`.

## Security and privacy

- Only use external local paths in notes you trust. An embedded path can cause Obsidian to read that local file for display.
- The local PDF endpoint binds only to `127.0.0.1`, uses an unguessable per-session token, and exposes only files explicitly registered by the plugin.
- External web pages run in a sandboxed iframe (`allow-scripts`, `allow-forms`, `allow-presentation`). The plugin does not upload local files or note contents.
- The plugin is desktop-only because it uses Node.js filesystem APIs and Electron shell APIs for files outside the vault.

## Installation

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest GitHub release](https://github.com/imAndyrrr/obsidian-fast-external-embed/releases).
2. Create `<vault>/.obsidian/plugins/fast-external-embed/` in your vault.
3. Copy the three downloaded files into that folder.
4. Enable **Fast External Embed** in **Settings → Community plugins** (after disabling Restricted Mode if needed).

### From Community plugins

Once the plugin is approved and listed in the official Obsidian Community Plugins directory, you can install it directly from **Settings → Community plugins** by searching for **Fast External Embed**.

## Development

```bash
npm install
npm run build
```

The compiled plugin entry point is `main.js`. Source files are in `src/`:

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin entry point, DOM scanning, link interception, and settings. |
| `src/renderer.ts` | Embed target parsing, media rendering, and the progressive PDF viewer. |
| `src/local-file-server.ts` | Loopback HTTP server with byte-range support for local PDF streaming. |

## License

This project is released under the [MIT License](LICENSE).
