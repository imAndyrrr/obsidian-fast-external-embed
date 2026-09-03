import { Notice, setIcon } from "obsidian";
import * as path from "path";
import * as fs from "fs";

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
        // 利用 Chromium 原生 C++ PDF 引擎渲染
        const iframe = body.createEl("iframe", {
          cls: "fast-external-embed-pdf",
          attr: {
            src: fullUrl,
            frameborder: "0",
          },
        });
        iframe.style.setProperty("--fast-embed-pdf-height", customHeight);
        iframe.style.height = customHeight;
        if (customWidth !== "100%") iframe.style.width = customWidth;
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
            allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
            allowfullscreen: "true",
            sandbox: "allow-forms allow-presentation allow-same-origin allow-scripts allow-downloads allow-modals allow-popups",
          },
        });
        iframe.style.height = customHeight;
        iframe.style.width = customWidth;
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
