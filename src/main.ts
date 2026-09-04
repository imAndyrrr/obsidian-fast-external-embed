import {
  App,
  MarkdownPostProcessorContext,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { EmbedRenderer } from "./renderer";

interface FastExternalEmbedSettings {
  showHeader: boolean;
  pdfDefaultHeight: string;
  iframeDefaultHeight: string;
  enableLivePreview: boolean;
}

const DEFAULT_SETTINGS: FastExternalEmbedSettings = {
  showHeader: true,
  pdfDefaultHeight: "75vh",
  iframeDefaultHeight: "550px",
  enableLivePreview: true,
};

export default class FastExternalEmbedPlugin extends Plugin {
  settings: FastExternalEmbedSettings;
  renderer: EmbedRenderer;
  private observer: MutationObserver | null = null;
  private scanTimer: any = null;

  async onload() {
    await this.loadSettings();

    this.renderer = new EmbedRenderer((key: string) => (this.settings as any)[key]);

    // 1. 注册 Reading View（阅读模式）后处理器
    this.registerMarkdownPostProcessor((element: HTMLElement, context: MarkdownPostProcessorContext) => {
      this.scanAndReplaceEmbeds(element);
      this.scanAndEnhanceExternalLinks(element);
    });

    // 2. 启动轻量 DOM 监听，接管 Live Preview / 动态渲染中的未解析占位符
    if (this.settings.enableLivePreview) {
      this.startDOMObserver();
    }

    // 3. 全局拦截外部链接点击（防止点击 [[C:/...]] 或 file:/// 时在仓库内创建空白笔记）
    this.registerDomEvent(document, "click", (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      if (!target) return;
      const linkEl = target.closest<HTMLElement>(
        "a, .cm-link, .cm-hmd-internal-link, [data-href]"
      );
      if (!linkEl) return;

      const rawTarget = this.getExternalLinkTarget(linkEl);
      if (!rawTarget) return;

      const parsed = this.renderer.parseTarget(rawTarget);
      if (parsed && !parsed.isHttp) {
        evt.preventDefault();
        evt.stopPropagation();
        this.renderer.openInSystemDefault(parsed.cleanTarget);
      }
    }, true);

    // 4. 注册设置面板
    this.addSettingTab(new FastExternalEmbedSettingTab(this.app, this));

  }

  onunload() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    if (this.renderer) {
      this.renderer.cleanup();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * 监听 DOM 树变化，检测并替换未加载的外部嵌入元素
   */
  private startDOMObserver() {
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (let i = 0; i < mutation.addedNodes.length; i++) {
            const node = mutation.addedNodes[i];
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as HTMLElement;
              if (
                el.classList?.contains("internal-embed") ||
                el.classList?.contains("file-embed") ||
                el.matches?.("a, .cm-link, .cm-hmd-internal-link, [data-href]") ||
                el.querySelector?.(
                  ".internal-embed, .file-embed, img, a, .cm-link, .cm-hmd-internal-link, [data-href]"
                )
              ) {
                shouldScan = true;
                break;
              }
            }
          }
        }
        if (shouldScan) break;
      }

      if (shouldScan) {
        if (this.scanTimer) clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => {
        this.scanAndReplaceEmbeds(document.body);
        this.scanAndEnhanceExternalLinks(document.body);
      }, 50);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // 立即对当前界面执行一次扫描
    setTimeout(() => {
      this.scanAndReplaceEmbeds(document.body);
      this.scanAndEnhanceExternalLinks(document.body);
    }, 200);
  }

  /**
   * 扫描并替换 DOM 元素中的外部嵌入（同时支持阅读视图和实时预览）
   */
  private scanAndReplaceEmbeds(root: HTMLElement) {
    try {
    // 1. 处理 ![[...]] 语法生成的 internal-embed 或 file-embed（包括“找不到文件”报错元素）
    const embedEls = root.querySelectorAll<HTMLElement>(
      ".internal-embed:not([data-fast-embed-processed]), .file-embed:not([data-fast-embed-processed])"
    );

    embedEls.forEach((embedEl) => {
      let src = embedEl.getAttribute("src");
      const alt = embedEl.getAttribute("alt") || undefined;

      // 如果没有 src 属性，尝试从元素内的文字中提取路径（例如 找不到“C:/...”。）
      if (!src) {
        const text = embedEl.innerText || embedEl.textContent || "";
        const parsedFromText = this.renderer.parseTarget(text, alt);
        if (parsedFromText) {
          embedEl.setAttribute("data-fast-embed-processed", "true");
          // 移除 mod-empty-attachment 样式避免原生的空附件红框干扰
          embedEl.classList.remove("mod-empty-attachment");
          this.renderer.render(parsedFromText, embedEl);
          return;
        }
      }

      if (!src) return;

      const parsed = this.renderer.parseTarget(src, alt);
      if (parsed) {
        embedEl.setAttribute("data-fast-embed-processed", "true");
        embedEl.classList.remove("mod-empty-attachment");
        this.renderer.render(parsed, embedEl);
      }
    });

    // 2. 处理 ![](...) 外部网页、本地外部 PDF/音视频生成的不兼容 img 标签
    const imgs = root.querySelectorAll<HTMLImageElement>("img:not([data-fast-embed-processed])");
    imgs.forEach((img) => {
      const src = img.getAttribute("src");
      const alt = img.getAttribute("alt") || undefined;
      if (!src) return;

      const parsed = this.renderer.parseTarget(src, alt);
      if (parsed) {
        const nonImgExts = [".pdf", ".mp4", ".webm", ".mkv", ".mov", ".mp3", ".wav", ".ogg", ".flac", ".m4a"];
        if (parsed.isHttp || nonImgExts.includes(parsed.extension)) {
          img.setAttribute("data-fast-embed-processed", "true");
          const container = document.createElement("div");
          img.replaceWith(container);
          this.renderer.render(parsed, container);
        }
      }
    });
    } catch (err) {
      console.error("Fast External Embed scan error:", err);
    }
  }

  /**
   * 将 [[绝对路径]] 标记为外部文件链接。
   *
   * Obsidian 会把仓库外路径视作无法解析的内部链接；这里保留原来的文本，
   * 只补上可识别的样式与提示。实际打开操作由全局点击拦截统一交给系统默认程序。
   */
  private scanAndEnhanceExternalLinks(root: HTMLElement) {
    try {
      const links = root.querySelectorAll<HTMLElement>(
        [
          "a.internal-link:not([data-fast-external-link-processed])",
          "a[data-href]:not([data-fast-external-link-processed])",
          ".cm-hmd-internal-link:not([data-fast-external-link-processed])",
          ".cm-link:not([data-fast-external-link-processed])",
        ].join(", ")
      );

      links.forEach((linkEl) => {
        const rawTarget = this.getExternalLinkTarget(linkEl);
        if (!rawTarget) return;

        const parsed = this.renderer.parseTarget(rawTarget);
        if (!parsed || parsed.isHttp) return;

        linkEl.setAttribute("data-fast-external-link-processed", "true");
        linkEl.addClass("fast-external-file-link");
        linkEl.setAttribute("title", `用系统默认程序打开：${parsed.cleanTarget}`);
        linkEl.setAttribute("aria-label", `打开本地文件：${parsed.cleanTarget}`);
      });
    } catch (err) {
      console.error("Fast External Embed link scan error:", err);
    }
  }

  /**
   * 从阅读模式或 Live Preview 的链接元素提取 [[...]] 内的实际目标路径。
   * 支持 [[C:/file.pdf|显示名称]] 这样的别名语法。
   */
  private getExternalLinkTarget(linkEl: HTMLElement): string | null {
    const source =
      linkEl.getAttribute("data-href") ||
      linkEl.getAttribute("href");

    if (source) {
      return this.removeWikiLinkAlias(source);
    }

    // Live Preview 的别名链接只保留显示文字，例如 [[C:/file.pdf|打开 PDF]]
    // 会显示为 “打开 PDF”。此时从当前编辑行还原完整的 [[...]] 语法。
    const linkText = linkEl.textContent?.trim() || "";
    const lineTexts = [
      linkEl.closest(".cm-line")?.textContent || "",
      this.getSourceLineFromLivePreview(linkEl),
    ];

    for (const lineText of lineTexts) {
      const wikiTargets = [...lineText.matchAll(/\[\[([\s\S]*?)\]\]/g)]
        .map((match) => match[1].trim())
        .filter(Boolean);

      for (const wikiTarget of wikiTargets) {
        const aliasIndex = wikiTarget.lastIndexOf("|");
        const target = aliasIndex === -1
          ? wikiTarget
          : wikiTarget.slice(0, aliasIndex).trim();
        const alias = aliasIndex === -1
          ? ""
          : wikiTarget.slice(aliasIndex + 1).trim();

        if (
          wikiTargets.length === 1 ||
          target === linkText ||
          alias === linkText
        ) {
          return target || null;
        }
      }
    }

    return this.removeWikiLinkAlias(linkText);
  }

  /**
   * Live Preview 会将 [[路径|别名]] 的路径部分替换成不可见组件，
   * 因而 DOM 中只剩别名。通过 CodeMirror 的位置映射回到真实文档行，
   * 便可取回原始 wiki 链接。
   */
  private getSourceLineFromLivePreview(linkEl: HTMLElement): string {
    if (!linkEl.closest(".cm-editor")) return "";

    const editor = this.app.workspace.activeEditor?.editor as any;
    const cm = editor?.cm;
    if (!cm || typeof cm.posAtDOM !== "function") return "";

    try {
      const position = cm.posAtDOM(linkEl, 0);
      return cm.state.doc.lineAt(position).text || "";
    } catch (_) {
      return "";
    }
  }

  private removeWikiLinkAlias(source: string): string | null {
    let target = source.trim();
    const wikiMatch = target.match(/^\[\[([\s\S]+)\]\]$/);
    if (wikiMatch) target = wikiMatch[1].trim();

    const aliasIndex = target.lastIndexOf("|");
    if (aliasIndex !== -1) target = target.slice(0, aliasIndex).trim();

    return target || null;
  }
}

class FastExternalEmbedSettingTab extends PluginSettingTab {
  plugin: FastExternalEmbedPlugin;

  constructor(app: App, plugin: FastExternalEmbedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("显示顶部信息栏与快捷按钮")
      .setDesc("在嵌入内容上方显示文件名/网址、在默认应用中打开、定位文件或刷新按钮。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showHeader)
          .onChange(async (val) => {
            this.plugin.settings.showHeader = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("PDF 默认高度")
      .setDesc("嵌入 PDF 时的默认显示高度（例如 75vh, 600px）。也可以在语法中通过 #height=... 单独指定。")
      .addText((text) =>
        text
          .setPlaceholder("75vh")
          .setValue(this.plugin.settings.pdfDefaultHeight)
          .onChange(async (val) => {
            this.plugin.settings.pdfDefaultHeight = val.trim() || "75vh";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("网页/iframe 默认高度")
      .setDesc("使用 ![](https://...) 嵌入网页时的默认高度（例如 550px, 80vh）。")
      .addText((text) =>
        text
          .setPlaceholder("550px")
          .setValue(this.plugin.settings.iframeDefaultHeight)
          .onChange(async (val) => {
            this.plugin.settings.iframeDefaultHeight = val.trim() || "550px";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("启用实时预览（Live Preview）支持")
      .setDesc("在编辑模式下，当光标离开当前行时自动将嵌入语法渲染为内容视图。（修改后需重启或重新加载笔记）")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableLivePreview)
          .onChange(async (val) => {
            this.plugin.settings.enableLivePreview = val;
            await this.plugin.saveSettings();
          })
      );
  }
}
