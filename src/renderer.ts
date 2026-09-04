import { loadPdfJs, Notice, setIcon } from "obsidian";
import * as path from "path";
import * as fs from "fs";
import { LocalFileServer } from "./local-file-server";

export interface ParsedEmbedTarget {
  isExternal: boolean;
  isHttp: boolean;
  cleanTarget: string;
  rawTarget: string;
  hash: string;
  params: Record<string, string>;
  extension: string;
  alt?: string;
  dimensions?: { width?: string; height?: string };
}

export class EmbedRenderer {
  private blobCache: Map<string, { url: string; size: number; timestamp: number }> = new Map();
  private maxCacheSize: number = 200 * 1024 * 1024; // 200MB 内存缓存上限
  private currentCacheSize: number = 0;
  private localFileServer = new LocalFileServer();
  private pdfPreviewSessions = new Set<{ destroy: () => void }>();

  constructor(private getSetting: (key: string) => any) {}

  /**
   * 解析嵌入目标文本
   */
  public parseTarget(target: string, altText?: string): ParsedEmbedTarget | null {
    if (!target) return null;
    let str = target.trim();

    // 如果是 Obsidian 报错信息："找不到“...”" 或 "Unable to find "...""
    const notFoundMatch = str.match(/^(?:找不到[“"]|Unable to find ["'])([^”"']+)[”"']/);
    if (notFoundMatch) {
      str = notFoundMatch[1].trim();
    }

    // 去除多余的引号
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
      str = str.slice(1, -1).trim();
    }

    const isHttp = /^https?:\/\//i.test(str);
    const isFileProtocol = /^file:\/\/\/?/i.test(str);
    const isWinAbsolute = /^[a-zA-Z]:[\\\/]/.test(str);
    const isUnixAbsolute = str.startsWith("/") && !str.startsWith("//");

    if (!isHttp && !isFileProtocol && !isWinAbsolute && !isUnixAbsolute) {
      return null;
    }

    // 分离 hash 与参数（例如 #page=3&height=500px）
    // 注意：文件夹名称中可能含有 #（如 C:/#Self/...），所以 hash 只能位于文件名末尾，且通常形如 #page=... 或在已有文件扩展名之后！
    let cleanTarget = str;
    let hash = "";
    const params: Record<string, string> = {};

    // 优先匹配标准参数 hash：如 .pdf#page=2 或末尾的 #page=... / #height=...
    const hashParamMatch = str.match(/#([a-zA-Z0-9_\-]+=[^#]*)$/);
    if (hashParamMatch) {
      const idx = hashParamMatch.index!;
      cleanTarget = str.substring(0, idx);
      hash = str.substring(idx + 1);
      const parts = hash.split("&");
      for (const part of parts) {
        const [k, v] = part.split("=");
        if (k) params[k.trim().toLowerCase()] = v ? decodeURIComponent(v.trim()) : "";
      }
    } else {
      // 寻找最后一个路径分隔符之后出现的 '#'
      const lastSlash = Math.max(str.lastIndexOf("/"), str.lastIndexOf("\\"));
      const hashIndex = str.indexOf("#", lastSlash === -1 ? 0 : lastSlash);
      // 只有当 # 后面紧跟的是常见参数名（如 page, height, width）或者出现在已有扩展名之后时才作为 hash
      if (hashIndex !== -1 && (hashIndex > lastSlash + 1)) {
        const potentialHash = str.substring(hashIndex + 1);
        if (/^(page|height|width)=/i.test(potentialHash) || /\.[a-zA-Z0-9]{2,5}#/i.test(str)) {
          cleanTarget = str.substring(0, hashIndex);
          hash = potentialHash;
          const parts = hash.split("&");
          for (const part of parts) {
            const [k, v] = part.split("=");
            if (k) params[k.trim().toLowerCase()] = v ? decodeURIComponent(v.trim()) : "";
          }
        }
      }
    }

    // 清理本地文件路径
    if (isFileProtocol) {
      cleanTarget = cleanTarget.replace(/^file:\/\/\/?/i, "");
      if (/^[a-zA-Z]:/.test(cleanTarget)) {
        cleanTarget = cleanTarget.replace(/^\//, "");
      }
    }

    try {
      cleanTarget = decodeURIComponent(cleanTarget);
    } catch (_) {
      // ignore decode error
    }

    if (!isHttp) {
      cleanTarget = path.normalize(cleanTarget);
    }

    // 解析 alt 中的尺寸（例如 ![600x400](url) 或 ![600](url)）
    const dimensions: { width?: string; height?: string } = {};
    if (altText) {
      const dimMatch = altText.match(/^(\d+)(?:x(\d+))?$/);
      if (dimMatch) {
        if (dimMatch[1]) dimensions.width = `${dimMatch[1]}px`;
        if (dimMatch[2]) dimensions.height = `${dimMatch[2]}px`;
        else dimensions.width = `${dimMatch[1]}px`;
      }
    }

    const extension = path.extname(cleanTarget).toLowerCase();

    return {
      isExternal: true,
      isHttp,
      cleanTarget,
      rawTarget: target,
      hash,
      params,
      extension,
      alt: altText,
      dimensions,
    };
  }

  /**
   * 渲染外部资源到指定容器
   */
  public async render(parsed: ParsedEmbedTarget, container: HTMLElement) {
    container.empty();
    container.addClass("fast-external-embed-container");

    const showHeader = this.getSetting("showHeader") ?? true;
    const defaultHeight = parsed.extension === ".pdf"
      ? (this.getSetting("pdfDefaultHeight") || "75vh")
      : (this.getSetting("iframeDefaultHeight") || "500px");

    const customHeight = parsed.dimensions?.height || parsed.params.height || defaultHeight;
    const customWidth = parsed.dimensions?.width || parsed.params.width || "100%";

    // 创建顶部信息栏（可开关）
    if (showHeader) {
      const header = container.createEl("div", { cls: "fast-external-embed-header" });
      const titleEl = header.createEl("div", { cls: "fast-external-embed-title" });

      const iconEl = titleEl.createEl("span");
      this.setIconByExtension(iconEl, parsed.extension, parsed.isHttp);

      const displayName = !parsed.isHttp
        ? path.basename(parsed.cleanTarget)
        : (parsed.alt || parsed.cleanTarget);
      titleEl.createEl("span", { text: displayName });

      const actions = header.createEl("div", { cls: "fast-external-embed-actions" });

      // 按钮：系统外部默认程序打开
      if (!parsed.isHttp) {
        const openBtn = actions.createEl("button", {
          cls: "fast-external-embed-btn",
          text: "打开原文件",
        });
        openBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openInSystemDefault(parsed.cleanTarget);
        });

        // 按钮：在文件资源管理器中定位
        const locateBtn = actions.createEl("button", {
          cls: "fast-external-embed-btn",
          text: "定位",
        });
        locateBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.showInExplorer(parsed.cleanTarget);
        });
      } else {
        const reloadBtn = actions.createEl("button", {
          cls: "fast-external-embed-btn",
          text: "刷新",
        });
        reloadBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const iframe = container.querySelector("iframe");
          if (iframe) iframe.src = iframe.src;
        });

        const browserBtn = actions.createEl("button", {
          cls: "fast-external-embed-btn",
          text: "在浏览器中打开",
        });
        browserBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          window.open(parsed.cleanTarget, "_blank");
        });
      }
    }

    const body = container.createEl("div", { cls: "fast-external-embed-body" });

    try {
      const playableUrl = await this.resolvePlayableUrl(parsed);
      const fullUrl = parsed.hash ? `${playableUrl}#${parsed.hash}` : playableUrl;

      if (parsed.extension === ".pdf") {
        const pdfHost = body.createDiv({ cls: "fast-external-pdf-host" });
        pdfHost.style.height = customHeight;
        if (customWidth !== "100%") pdfHost.style.width = customWidth;

        // Chromium 的完整 PDF 阅读器在后台载入；PDF.js 先按需读取并显示当前页，
        // 避免非线性化的大 PDF 在完整传输前长时间只显示空白区域。
        const iframe = pdfHost.createEl("iframe", {
          cls: "fast-external-embed-pdf",
          attr: {
            frameborder: "0",
            loading: "lazy",
          },
        });
        iframe.style.setProperty("--fast-embed-pdf-height", customHeight);
        iframe.style.height = "100%";

        const preview = pdfHost.createDiv({
          cls: "fast-external-pdf-preview",
        });
        const previewStatus = preview.createDiv({
          cls: "fast-external-pdf-preview-status",
          text: "正在按需读取当前页…",
        });

        void this.showProgressivePdfPreview(
          parsed,
          playableUrl,
          fullUrl,
          iframe,
          preview,
          previewStatus
        );
      } else if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(parsed.extension)) {
        const img = body.createEl("img", {
          cls: "fast-external-embed-img",
          attr: { src: fullUrl },
          title: parsed.alt || "",
        });
        if (parsed.dimensions?.width) img.style.width = parsed.dimensions.width;
      } else if ([".mp4", ".webm", ".mkv", ".mov"].includes(parsed.extension)) {
        const video = body.createEl("video", {
          cls: "fast-external-embed-media",
          attr: { controls: "true", src: fullUrl },
        });
        if (parsed.dimensions?.width) video.style.width = parsed.dimensions.width;
      } else if ([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"].includes(parsed.extension)) {
        body.createEl("audio", {
          cls: "fast-external-embed-media",
          attr: { controls: "true", src: fullUrl },
        });
      } else if (parsed.isHttp) {
        // 普通外部网页直接作为响应式 iframe 嵌入
        const iframe = body.createEl("iframe", {
          cls: "fast-external-embed-iframe",
          attr: {
            src: fullUrl,
            frameborder: "0",
            allow: "autoplay; fullscreen; picture-in-picture",
            allowfullscreen: "true",
            sandbox: "allow-forms allow-presentation allow-scripts",
          },
        });
        iframe.style.height = customHeight;
        // 让外层 image-embed/image-wrapper 容器也撑满可用宽度
        const imgEmbed = container.closest(".image-embed") as HTMLElement | null;
        const imgWrapper = container.closest(".image-wrapper") as HTMLElement | null;
        if (imgEmbed) {
          imgEmbed.addClass("fast-external-embed-host");
        }
        if (imgWrapper) {
          imgWrapper.addClass("fast-external-embed-host");
        }
        if (customWidth !== "100%") iframe.style.width = customWidth;
      } else {
        body.createEl("div", {
          cls: "fast-external-embed-error",
          text: `不支持直接嵌入此文件类型 (${parsed.extension})，请点击上方按钮用系统程序打开。`,
        });
      }
    } catch (err: any) {
      body.createEl("div", {
        cls: "fast-external-embed-error",
        text: `无法加载外部资源: ${err.message || err}`,
      });
    }
  }

  /**
   * 获取可以直接供浏览器渲染的 URL
   */
  private async resolvePlayableUrl(parsed: ParsedEmbedTarget): Promise<string> {
    if (parsed.isHttp) {
      return parsed.cleanTarget;
    }

    const filePath = parsed.cleanTarget;
    if (parsed.extension === ".pdf") {
      return this.localFileServer.getFileUrl(
        filePath,
        this.getMimeType(parsed.extension)
      );
    }

    // 检查缓存
    const cached = this.blobCache.get(filePath);
    if (cached) {
      cached.timestamp = Date.now();
      return cached.url;
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`路径不是文件: ${filePath}`);
    }

    // 读取文件生成高性能 Blob URL
    const buffer = await fs.promises.readFile(filePath);
    const mimeType = this.getMimeType(parsed.extension);
    const blob = new Blob([buffer], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    // 缓存管理
    this.manageCache(filePath, blobUrl, buffer.byteLength);

    return blobUrl;
  }

  private manageCache(filePath: string, url: string, size: number) {
    while (this.currentCacheSize + size > this.maxCacheSize && this.blobCache.size > 0) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.blobCache.entries()) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const item = this.blobCache.get(oldestKey)!;
        URL.revokeObjectURL(item.url);
        this.currentCacheSize -= item.size;
        this.blobCache.delete(oldestKey);
      } else {
        break;
      }
    }

    this.blobCache.set(filePath, { url, size, timestamp: Date.now() });
    this.currentCacheSize += size;
  }

  public cleanup() {
    this.localFileServer.cleanup();
    for (const session of this.pdfPreviewSessions) {
      session.destroy();
    }
    this.pdfPreviewSessions.clear();
    for (const item of this.blobCache.values()) {
      URL.revokeObjectURL(item.url);
    }
    this.blobCache.clear();
    this.currentCacheSize = 0;
  }

  public openInSystemDefault(filePath: string) {
    try {
      const electron = (window as any).require("electron");
      electron.shell.openPath(filePath).then((err: string) => {
        if (err) {
          new Notice(`打开失败: ${err}`);
        }
      });
    } catch (e) {
      new Notice("系统操作不可用");
    }
  }

  public showInExplorer(filePath: string) {
    try {
      const electron = (window as any).require("electron");
      electron.shell.showItemInFolder(filePath);
    } catch (e) {
      new Notice("定位失败");
    }
  }

  private setIconByExtension(el: HTMLElement, ext: string, isHttp: boolean) {
    if (ext === ".pdf") setIcon(el, "file-text");
    else if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) setIcon(el, "image");
    else if ([".mp4", ".webm", ".mkv"].includes(ext)) setIcon(el, "video");
    else if ([".mp3", ".wav", ".ogg", ".flac"].includes(ext)) setIcon(el, "audio-file");
    else if (isHttp) setIcon(el, "globe");
    else setIcon(el, "file");
  }

  private async showProgressivePdfPreview(
    parsed: ParsedEmbedTarget,
    playableUrl: string,
    fullUrl: string,
    iframe: HTMLIFrameElement,
    preview: HTMLElement,
    status: HTMLElement
  ): Promise<void> {
    let destroyed = false;
    let loadingTask: any = null;
    let renderTask: any = null;
    let visibilityObserver: IntersectionObserver | null = null;
    let releaseVisibilityWait: (() => void) | null = null;
    let disconnectTimer: number | null = null;
    const session = {
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        visibilityObserver?.disconnect();
        visibilityObserver = null;
        releaseVisibilityWait?.();
        releaseVisibilityWait = null;
        if (disconnectTimer !== null) {
          window.clearInterval(disconnectTimer);
          disconnectTimer = null;
        }
        try {
          renderTask?.cancel?.();
        } catch (_) {
          // Ignore cancellation races.
        }
        void loadingTask?.destroy?.();
        preview.remove();
        this.pdfPreviewSessions.delete(session);
      },
    };
    this.pdfPreviewSessions.add(session);
    disconnectTimer = window.setInterval(() => {
      if (!preview.isConnected || !iframe.isConnected) session.destroy();
    }, 1_000);

    let previewRendered = false;
    try {
      const rect = preview.getBoundingClientRect();
      const isNearViewport =
        rect.bottom >= -800 && rect.top <= window.innerHeight + 800;
      if (!isNearViewport && "IntersectionObserver" in window) {
        await new Promise<void>((resolve) => {
          releaseVisibilityWait = resolve;
          visibilityObserver = new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) resolve();
            },
            { rootMargin: "800px 0px" }
          );
          visibilityObserver.observe(preview);
        });
        releaseVisibilityWait = null;
        visibilityObserver?.disconnect();
        visibilityObserver = null;
      }
      if (destroyed || !preview.isConnected) {
        session.destroy();
        return;
      }

      const pdfjsLib = await loadPdfJs();
      if (destroyed || !preview.isConnected) {
        session.destroy();
        return;
      }

      loadingTask = pdfjsLib.getDocument({
        url: playableUrl,
        disableRange: false,
        disableStream: true,
        disableAutoFetch: true,
        rangeChunkSize: 256 * 1024,
        withCredentials: false,
        wasmUrl: new URL("lib/pdfjs/wasm/", window.location.href).href,
      });

      const pdfDocument = await loadingTask.promise;
      if (destroyed || !preview.isConnected) {
        session.destroy();
        return;
      }

      const requestedPage = Number.parseInt(parsed.params.page || "1", 10);
      const pageNumber = Math.min(
        Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1),
        pdfDocument.numPages
      );
      const page = await pdfDocument.getPage(pageNumber);
      if (destroyed || !preview.isConnected) {
        session.destroy();
        return;
      }

      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(preview.clientWidth - 32, 320);
      const cssScale = Math.min(availableWidth / baseViewport.width, 2);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const renderViewport = page.getViewport({
        scale: cssScale * pixelRatio,
      });

      const canvasWrap = preview.createDiv({
        cls: "fast-external-pdf-preview-canvas-wrap",
      });
      const canvas = canvasWrap.createEl("canvas");
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      canvas.style.width = `${Math.ceil(renderViewport.width / pixelRatio)}px`;
      canvas.style.height = `${Math.ceil(renderViewport.height / pixelRatio)}px`;

      const canvasContext = canvas.getContext("2d");
      if (!canvasContext) throw new Error("无法创建 PDF 预览画布");

      renderTask = page.render({
        canvas,
        canvasContext,
        viewport: renderViewport,
        background: "rgb(255,255,255)",
      });
      await renderTask.promise;
      if (destroyed || !preview.isConnected) {
        session.destroy();
        return;
      }

      previewRendered = true;
      preview.addClass("is-ready");
      status.setText(
        `第 ${pageNumber} / ${pdfDocument.numPages} 页 · 完整阅读器正在后台载入`
      );
    } catch (error) {
      if (!destroyed) {
        console.warn(
          "Fast External Embed progressive PDF preview unavailable:",
          error
        );
      }
    }

    if (destroyed) return;
    if (!iframe.isConnected) {
      session.destroy();
      return;
    }

    const fullTransfer = this.localFileServer.waitForNextFullTransfer(
      parsed.cleanTarget
    );
    iframe.src = fullUrl;

    if (!previewRendered) {
      session.destroy();
      return;
    }

    await Promise.race([
      fullTransfer,
      new Promise<void>((resolve) => window.setTimeout(resolve, 90_000)),
    ]);
    if (destroyed || !preview.isConnected) return;

    await new Promise<void>((resolve) => window.setTimeout(resolve, 700));
    preview.addClass("is-complete");
    window.setTimeout(() => session.destroy(), 220);
  }

  private getMimeType(ext: string): string {
    const map: Record<string, string> = {
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".bmp": "image/bmp",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".flac": "audio/flac",
    };
    return map[ext] || "application/octet-stream";
  }
}
