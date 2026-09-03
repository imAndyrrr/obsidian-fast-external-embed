import {
  App,
  MarkdownPostProcessorContext,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { EmbedRenderer } from "./renderer";
import { buildEditorExtension } from "./editorExtension";

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

  async onload() {
    await this.loadSettings();

    this.renderer = new EmbedRenderer((key: string) => (this.settings as any)[key]);

    // 1. 注册 Reading View（阅读模式）后处理器
    this.registerMarkdownPostProcessor((element: HTMLElement, context: MarkdownPostProcessorContext) => {
      this.processReadingMode(element, context);
    });

    // 2. 注册 Live Preview（实时预览）CodeMirror 6 扩展
    if (this.settings.enableLivePreview) {
      this.registerEditorExtension(buildEditorExtension(this.renderer));
    }

    // 3. 注册设置面板
    this.addSettingTab(new FastExternalEmbedSettingTab(this.app, this));

    console.log("Fast External Embed 插件已就绪");
  }

  onunload() {
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
   * 处理阅读模式下的 DOM 元素
   */
  private processReadingMode(element: HTMLElement, context: MarkdownPostProcessorContext) {
    // 1. 处理 ![[...]] 语法生成的 internal-embed
    const internalEmbeds = element.querySelectorAll<HTMLElement>(".internal-embed");
    internalEmbeds.forEach((embedEl) => {
      const src = embedEl.getAttribute("src");
      const alt = embedEl.getAttribute("alt") || undefined;
      if (!src) return;

      const parsed = this.renderer.parseTarget(src, alt);
      if (parsed) {
        this.renderer.render(parsed, embedEl);
      }
    });

    // 2. 处理 ![](...) 标准 Markdown 语法生成的 img 标签
    const imgs = element.querySelectorAll<HTMLImageElement>("img");
    imgs.forEach((img) => {
      const src = img.getAttribute("src");
      const alt = img.getAttribute("alt") || undefined;
      if (!src) return;

      const parsed = this.renderer.parseTarget(src, alt);
      if (parsed) {
        // 如果是普通网页、PDF、视频或音频，img 标签无法正确显示，替换为原生容器
        const nonImgExts = [".pdf", ".mp4", ".webm", ".mkv", ".mov", ".mp3", ".wav", ".ogg", ".flac", ".m4a"];
        if (parsed.isHttp || nonImgExts.includes(parsed.extension)) {
          const container = document.createElement("div");
          img.replaceWith(container);
          this.renderer.render(parsed, container);
        }
      }
    });
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

    containerEl.createEl("h2", { text: "Fast External Embed 设置" });

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
