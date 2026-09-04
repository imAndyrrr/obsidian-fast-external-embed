# Fast External Embed

Embed external web pages and files outside your vault using familiar Obsidian embed syntax.

Fast External Embed is a desktop-only plugin. It adds support for absolute local paths and `file:///` URLs in native wiki embeds, and renders external web pages from standard Markdown image embeds as responsive iframes.

## Features

- Embed PDFs, images, audio, and video stored outside the vault.
- Render external web pages with `![](https://...)`.
- Use either `![[...]]` or standard Markdown image syntax.
- Use Chromium's built-in PDF viewer rather than a JavaScript PDF renderer.
- Control the default height for PDFs and web pages in the plugin settings.
- Open a local file with its system default application or reveal it in File Explorer.
- Support Reading view and Live Preview.

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

Supported embedded file types include PDF, common image formats, common audio formats, and common video formats.

### External web pages

Use an external HTTP or HTTPS URL in Markdown image syntax:

```md
![](https://example.com)
![1200x700](https://example.com)
```

The page is rendered in an iframe. Some websites intentionally prohibit iframe embedding through their own security policy; those websites cannot be displayed inside Obsidian by any plugin.

### Size controls

Set an explicit size with the image alt text:

```md
![1200x700](https://example.com)
```

Or add a height parameter to a local file:

```md
![[C:/Documents/reference.pdf#page=3&height=80vh]]
```

## Performance

Local PDFs are served through a loopback-only, session-token-protected endpoint with HTTP byte-range support. A range-loaded preview displays the requested page first, while Chromium's complete PDF viewer continues loading in the background. The plugin no longer has to copy the complete PDF into an in-memory Blob before anything can be displayed, which improves first-page latency and substantially reduces memory pressure for large PDFs.

PDFs outside the visible area are deferred until they approach the viewport, reducing unnecessary work in notes containing multiple embeds.

Other compatible local media types currently continue to use short-lived in-memory Blob URLs. Close the note or reload the plugin to release cached local media data.

## Security and privacy

- Only use external local paths in notes you trust. An embedded path can cause Obsidian to read that local file for display.
- The local PDF endpoint binds only to `127.0.0.1`, uses an unguessable per-session token, and exposes only files explicitly registered by the plugin.
- External web pages run in a sandboxed iframe. The plugin does not upload local files or note contents.
- The plugin is desktop-only because it uses local filesystem APIs for files outside the vault.

## Installation

### Community plugins

After the plugin has been approved by Obsidian, install it from **Settings → Community plugins** and search for **Fast External Embed**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the matching GitHub release.
2. Create `<vault>/.obsidian/plugins/fast-external-embed/`.
3. Copy the three downloaded files into that folder.
4. Enable **Fast External Embed** in **Settings → Community plugins**.

## Development

```bash
npm install
npm run build
```

The compiled plugin entry point is `main.js`.

## License

This project is released under the [MIT License](LICENSE).
