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

export const IMAGE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"
];

export class EmbedRenderer {
  private blobCache: Map<string, { url: string; size: number; timestamp: number }> = new Map();
  private maxCacheSize: number = 200 * 1024 * 1024; // 200MB 内存缓存上限
  private currentCacheSize: number = 0;
  private localFileServer = new LocalFileServer();
  private pdfPreviewSessions = new Set<{ destroy: () => void }>();

  constructor(
    private getSetting: (key: string) => any,
    private onEditSource?: (container: HTMLElement) => void
  ) {}

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

    let extension = path.extname(cleanTarget).toLowerCase();

    // 如果没有识别出普通后缀，针对无后缀图片 URL（如微信图片、各类 CDN 带参数的动态图片）进行智能识别
    if (!extension && (isHttp || isFileProtocol)) {
      const fullUrlLower = str.toLowerCase();
      const imageFormats = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
      for (const fmt of imageFormats) {
        // 匹配如 ?wx_fmt=png, &tp=webp, &format=jpg, /mmbiz_png/ 等
        const fmtRegex = new RegExp(`(?:[?&](?:wx_fmt|tp|format|f|ext)=|mmbiz_|/image/)(${fmt})(?:[&/#]|$)`, "i");
        if (fmtRegex.test(fullUrlLower)) {
          extension = `.${fmt}`;
          break;
        }
      }
    }

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

        if (this.onEditSource) {
          const editBtn = actions.createEl("button", {
            cls: "fast-external-embed-btn",
            text: "编辑源码",
          });
          editBtn.setAttribute("title", "在实时预览中修改此区块/链接");
          editBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.onEditSource!(container);
          });
        }
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

        // 使用 PDF.js 构建可滚动的按页阅读器。每一页在接近可见区域时才读取
        // 所需的文件区段并渲染，不再等待 Chromium 完整下载整个 PDF。
        void this.showProgressivePdfViewer(parsed, playableUrl, pdfHost);
      } else if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(parsed.extension)) {
        const img = body.createEl("img", {
          cls: "fast-external-embed-img",
          attr: { src: fullUrl },
          title: parsed.alt || "",
        });
        img.setAttribute("data-fast-embed-processed", "true");
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

  private async showProgressivePdfViewer(
    parsed: ParsedEmbedTarget,
    playableUrl: string,
    host: HTMLElement
  ): Promise<void> {
    let destroyed = false;
    let loadingTask: any = null;
    let documentProxy: any = null;
    let hostObserver: IntersectionObserver | null = null;
    let pageObserver: IntersectionObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let releaseHostWait: (() => void) | null = null;
    let disconnectTimer: number | null = null;
    let resizeTimer: number | null = null;
    let scrollFrame: number | null = null;
    let lastMeasuredWidth = 0;
    let zoom = 1;
    let baseAspectRatio = 1.414;
    let currentPage = 1;

    interface PageState {
      pageNumber: number;
      element: HTMLElement;
      surface: HTMLElement;
      status: HTMLElement;
      canvas: HTMLCanvasElement | null;
      renderTask: any;
      loading: Promise<void> | null;
      visible: boolean;
      lastVisibleAt: number;
      aspectRatio: number;
      renderedZoom: number | null;
    }

    const pageStates = new Map<number, PageState>();
    const toolbar = host.createDiv({ cls: "fast-external-pdf-toolbar" });
    const previousButton = toolbar.createEl("button", {
      cls: "fast-external-pdf-tool-button",
      attr: { "aria-label": "上一页", title: "上一页" },
    });
    setIcon(previousButton, "chevron-up");

    const pageInput = toolbar.createEl("input", {
      cls: "fast-external-pdf-page-input",
      type: "number",
      attr: { min: "1", value: "1", "aria-label": "当前页" },
    });
    const pageTotal = toolbar.createEl("span", {
      cls: "fast-external-pdf-page-total",
      text: "/ …",
    });

    const nextButton = toolbar.createEl("button", {
      cls: "fast-external-pdf-tool-button",
      attr: { "aria-label": "下一页", title: "下一页" },
    });
    setIcon(nextButton, "chevron-down");

    toolbar.createDiv({ cls: "fast-external-pdf-toolbar-spacer" });

    const zoomOutButton = toolbar.createEl("button", {
      cls: "fast-external-pdf-tool-button",
      attr: { "aria-label": "缩小", title: "缩小" },
    });
    setIcon(zoomOutButton, "zoom-out");
    const zoomLabel = toolbar.createEl("span", {
      cls: "fast-external-pdf-zoom-label",
      text: "100%",
    });
    const zoomInButton = toolbar.createEl("button", {
      cls: "fast-external-pdf-tool-button",
      attr: { "aria-label": "放大", title: "放大" },
    });
    setIcon(zoomInButton, "zoom-in");

    const scrollContainer = host.createDiv({
      cls: "fast-external-pdf-scroll",
    });
    const loadingStatus = scrollContainer.createDiv({
      cls: "fast-external-pdf-loading",
      text: "正在读取 PDF 目录…",
    });
    const pagesContainer = scrollContainer.createDiv({
      cls: "fast-external-pdf-pages",
    });

    const cancelPage = (state: PageState) => {
      try {
        state.renderTask?.cancel?.();
      } catch (_) {
        // Ignore cancellation races.
      }
      state.renderTask = null;
      state.loading = null;
    };

    const clearPage = (state: PageState) => {
      cancelPage(state);
      state.canvas?.remove();
      state.canvas = null;
      state.renderedZoom = null;
      state.status.removeClass("is-hidden");
      state.status.setText(`第 ${state.pageNumber} 页`);
    };

    const session = {
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        hostObserver?.disconnect();
        hostObserver = null;
        pageObserver?.disconnect();
        pageObserver = null;
        resizeObserver?.disconnect();
        resizeObserver = null;
        releaseHostWait?.();
        releaseHostWait = null;
        if (disconnectTimer !== null) {
          window.clearInterval(disconnectTimer);
          disconnectTimer = null;
        }
        if (resizeTimer !== null) {
          window.clearTimeout(resizeTimer);
          resizeTimer = null;
        }
        if (scrollFrame !== null) {
          window.cancelAnimationFrame(scrollFrame);
          scrollFrame = null;
        }
        for (const state of pageStates.values()) {
          cancelPage(state);
        }
        void loadingTask?.destroy?.();
        documentProxy = null;
        this.pdfPreviewSessions.delete(session);
      },
    };
    this.pdfPreviewSessions.add(session);
    disconnectTimer = window.setInterval(() => {
      if (!host.isConnected) session.destroy();
    }, 1_000);

    const waitUntilNearViewport = async () => {
      const rect = host.getBoundingClientRect();
      if (rect.bottom >= -800 && rect.top <= window.innerHeight + 800) return;
      if (!("IntersectionObserver" in window)) return;

      await new Promise<void>((resolve) => {
        releaseHostWait = resolve;
        hostObserver = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) resolve();
          },
          { rootMargin: "800px 0px" }
        );
        hostObserver.observe(host);
      });
      releaseHostWait = null;
      hostObserver?.disconnect();
      hostObserver = null;
    };

    const availablePageWidth = () =>
      Math.max(scrollContainer.clientWidth - 32, 320);

    const updatePlaceholderSize = (state: PageState) => {
      const width = availablePageWidth() * zoom;
      const height = width * state.aspectRatio;
      state.element.style.width = `${Math.round(width)}px`;
      state.element.style.minHeight = `${Math.round(height)}px`;
    };

    const updateAllPlaceholderSizes = () => {
      for (const state of pageStates.values()) updatePlaceholderSize(state);
    };

    const updateCurrentPage = (pageNumber: number) => {
      currentPage = Math.min(
        Math.max(pageNumber, 1),
        documentProxy?.numPages || 1
      );
      pageInput.value = String(currentPage);
      previousButton.disabled = currentPage <= 1;
      nextButton.disabled =
        !documentProxy || currentPage >= documentProxy.numPages;
    };

    const updateCurrentPageFromScroll = () => {
      scrollFrame = null;
      if (!documentProxy || pageStates.size === 0) return;

      const readingLine =
        scrollContainer.scrollTop + scrollContainer.clientHeight * 0.3;
      let closestPage = 1;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const state of pageStates.values()) {
        const pageCenter =
          state.element.offsetTop + state.element.offsetHeight * 0.5;
        const distance = Math.abs(pageCenter - readingLine);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPage = state.pageNumber;
        }
      }
      updateCurrentPage(closestPage);
    };

    scrollContainer.addEventListener("scroll", () => {
      if (scrollFrame !== null) return;
      scrollFrame = window.requestAnimationFrame(updateCurrentPageFromScroll);
    });

    const evictDistantPages = () => {
      const rendered = [...pageStates.values()].filter(
        (state) => state.canvas && !state.visible
      );
      if (rendered.length <= 8) return;

      rendered
        .sort((a, b) => {
          const distanceA = Math.abs(a.pageNumber - currentPage);
          const distanceB = Math.abs(b.pageNumber - currentPage);
          if (distanceA !== distanceB) return distanceB - distanceA;
          return a.lastVisibleAt - b.lastVisibleAt;
        })
        .slice(0, rendered.length - 8)
        .forEach(clearPage);
    };

    const renderPage = (state: PageState): Promise<void> => {
      if (
        destroyed ||
        !documentProxy ||
        state.loading ||
        state.renderedZoom === zoom
      ) {
        return state.loading || Promise.resolve();
      }

      state.loading = (async () => {
        clearPage(state);
        state.status.setText(`正在读取第 ${state.pageNumber} 页…`);

        const page = await documentProxy.getPage(state.pageNumber);
        if (destroyed || !state.element.isConnected) return;

        const baseViewport = page.getViewport({ scale: 1 });
        state.aspectRatio = baseViewport.height / baseViewport.width;
        updatePlaceholderSize(state);

        const cssWidth = availablePageWidth() * zoom;
        const cssScale = cssWidth / baseViewport.width;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const renderViewport = page.getViewport({
          scale: cssScale * pixelRatio,
        });

        const canvas = state.surface.createEl("canvas");
        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        canvas.style.width = `${Math.ceil(renderViewport.width / pixelRatio)}px`;
        canvas.style.height = `${Math.ceil(
          renderViewport.height / pixelRatio
        )}px`;

        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) throw new Error("无法创建 PDF 页面画布");

        state.canvas = canvas;
        state.renderTask = page.render({
          canvas,
          canvasContext,
          viewport: renderViewport,
          background: "rgb(255,255,255)",
        });
        await state.renderTask.promise;
        if (destroyed || state.canvas !== canvas) return;

        state.renderedZoom = zoom;
        state.status.addClass("is-hidden");
        state.lastVisibleAt = Date.now();
        state.renderTask = null;
        page.cleanup?.();
        evictDistantPages();
      })()
        .catch((error: any) => {
          if (error?.name !== "RenderingCancelledException" && !destroyed) {
            console.warn(
              `Fast External Embed could not render PDF page ${state.pageNumber}:`,
              error
            );
            state.status.setText(`第 ${state.pageNumber} 页载入失败`);
          }
        })
        .finally(() => {
          state.loading = null;
        });

      return state.loading;
    };

    const goToPage = (pageNumber: number) => {
      const state = pageStates.get(
        Math.min(Math.max(pageNumber, 1), documentProxy?.numPages || 1)
      );
      if (!state) return;
      updateCurrentPage(state.pageNumber);
      scrollContainer.scrollTo({
        top: Math.max(state.element.offsetTop - 8, 0),
        behavior: "smooth",
      });
      void renderPage(state);
    };

    const setZoom = (nextZoom: number) => {
      const bounded = Math.min(Math.max(nextZoom, 0.5), 2.5);
      if (Math.abs(bounded - zoom) < 0.001) return;
      zoom = bounded;
      zoomLabel.setText(`${Math.round(zoom * 100)}%`);
      for (const state of pageStates.values()) clearPage(state);
      updateAllPlaceholderSizes();
      for (const state of pageStates.values()) {
        if (state.visible) void renderPage(state);
      }
      requestAnimationFrame(() => goToPage(currentPage));
    };

    previousButton.addEventListener("click", (event) => {
      event.stopPropagation();
      goToPage(currentPage - 1);
    });
    nextButton.addEventListener("click", (event) => {
      event.stopPropagation();
      goToPage(currentPage + 1);
    });
    pageInput.addEventListener("change", (event) => {
      event.stopPropagation();
      const requested = Number.parseInt(pageInput.value, 10);
      if (Number.isFinite(requested)) goToPage(requested);
      else updateCurrentPage(currentPage);
    });
    zoomOutButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setZoom(zoom - 0.15);
    });
    zoomInButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setZoom(zoom + 0.15);
    });
    zoomLabel.addEventListener("click", (event) => {
      event.stopPropagation();
      setZoom(1);
    });

    try {
      await waitUntilNearViewport();
      if (destroyed || !host.isConnected) {
        session.destroy();
        return;
      }

      const pdfjsLib = await loadPdfJs();
      if (destroyed || !host.isConnected) {
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

      documentProxy = await loadingTask.promise;
      if (destroyed || !host.isConnected) {
        session.destroy();
        return;
      }

      const requestedPage = Number.parseInt(parsed.params.page || "1", 10);
      const initialPage = Math.min(
        Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1),
        documentProxy.numPages
      );
      currentPage = initialPage;
      pageInput.max = String(documentProxy.numPages);
      pageTotal.setText(`/ ${documentProxy.numPages}`);

      const firstPage = await documentProxy.getPage(initialPage);
      const firstViewport = firstPage.getViewport({ scale: 1 });
      baseAspectRatio = firstViewport.height / firstViewport.width;
      firstPage.cleanup?.();

      loadingStatus.remove();

      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber++) {
        const element = pagesContainer.createDiv({
          cls: "fast-external-pdf-page",
          attr: {
            "data-page-number": String(pageNumber),
            "aria-label": `第 ${pageNumber} 页`,
          },
        });
        const surface = element.createDiv({
          cls: "fast-external-pdf-page-surface",
        });
        const status = surface.createDiv({
          cls: "fast-external-pdf-page-status",
          text: `第 ${pageNumber} 页`,
        });
        const state: PageState = {
          pageNumber,
          element,
          surface,
          status,
          canvas: null,
          renderTask: null,
          loading: null,
          visible: false,
          lastVisibleAt: 0,
          aspectRatio: baseAspectRatio,
          renderedZoom: null,
        };
        pageStates.set(pageNumber, state);
        updatePlaceholderSize(state);
      }

      pageObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const pageNumber = Number.parseInt(
              (entry.target as HTMLElement).dataset.pageNumber || "",
              10
            );
            const state = pageStates.get(pageNumber);
            if (!state) continue;
            state.visible = entry.isIntersecting;
            if (entry.isIntersecting) {
              state.lastVisibleAt = Date.now();
              void renderPage(state);
            }
          }
          evictDistantPages();
        },
        {
          root: scrollContainer,
          rootMargin: "100% 0px",
          threshold: [0, 0.1, 0.25, 0.5, 0.75],
        }
      );
      for (const state of pageStates.values()) {
        pageObserver.observe(state.element);
      }

      resizeObserver = new ResizeObserver(() => {
        if (destroyed) return;
        const measuredWidth = scrollContainer.clientWidth;
        if (Math.abs(measuredWidth - lastMeasuredWidth) < 8) return;
        lastMeasuredWidth = measuredWidth;
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = null;
          for (const state of pageStates.values()) clearPage(state);
          updateAllPlaceholderSizes();
          for (const state of pageStates.values()) {
            if (state.visible) void renderPage(state);
          }
        }, 180);
      });
      lastMeasuredWidth = scrollContainer.clientWidth;
      resizeObserver.observe(scrollContainer);

      updateCurrentPage(initialPage);
      const initialState = pageStates.get(initialPage);
      if (initialState) {
        scrollContainer.scrollTop = Math.max(initialState.element.offsetTop - 8, 0);
        initialState.visible = true;
        await renderPage(initialState);
      }
    } catch (error) {
      if (!destroyed) {
        console.error("Fast External Embed PDF viewer error:", error);
        loadingStatus.setText(
          `无法载入 PDF：${(error as any)?.message || String(error)}`
        );
        loadingStatus.addClass("is-error");
      }
    }
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
