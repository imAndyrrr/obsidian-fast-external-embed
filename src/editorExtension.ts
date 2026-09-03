import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { EmbedRenderer, ParsedEmbedTarget } from "./renderer";

class FastExternalEmbedWidget extends WidgetType {
  constructor(
    private parsed: ParsedEmbedTarget,
    private renderer: EmbedRenderer
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.classList.add("fast-external-embed-live-widget");
    try {
      this.renderer.render(this.parsed, container);
    } catch (e) {
      console.error("Fast External Embed toDOM error:", e);
      container.textContent = "无法渲染外部资源";
    }
    return container;
  }

  eq(other: FastExternalEmbedWidget): boolean {
    return (
      this.parsed.rawTarget === other.parsed.rawTarget &&
      this.parsed.alt === other.parsed.alt
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export function buildEditorExtension(renderer: EmbedRenderer) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const state = view.state;
        const selection = state.selection.main;

        interface PendingDecoration {
          from: number;
          to: number;
          widget: Decoration;
        }
        const pending: PendingDecoration[] = [];

        for (const { from, to } of view.visibleRanges) {
          const text = state.sliceDoc(from, to);

          // 正则 1: 匹配 ![[...]]
          const wikiRegex = /!\[\[(.*?)\]\]/g;
          let match: RegExpExecArray | null;
          while ((match = wikiRegex.exec(text)) !== null) {
            const matchStart = from + match.index;
            const matchEnd = matchStart + match[0].length;

            // 只有当光标精确位于该链接内部时才显示为纯文本，否则直接渲染 Widget
            if (selection.from <= matchEnd && selection.to >= matchStart) {
              continue;
            }

            const target = match[1];
            const parsed = renderer.parseTarget(target);
            if (parsed) {
              const widget = Decoration.replace({
                widget: new FastExternalEmbedWidget(parsed, renderer),
              });
              pending.push({ from: matchStart, to: matchEnd, widget });
            }
          }

          // 正则 2: 匹配 ![alt](url)
          const mdRegex = /!\[(.*?)\]\((.*?)\)/g;
          while ((match = mdRegex.exec(text)) !== null) {
            const matchStart = from + match.index;
            const matchEnd = matchStart + match[0].length;

            // 只有当光标精确位于该链接内部时才显示为纯文本，否则直接渲染 Widget
            if (selection.from <= matchEnd && selection.to >= matchStart) {
              continue;
            }

            const altText = match[1];
            const target = match[2];
            const parsed = renderer.parseTarget(target, altText);
            if (parsed) {
              const widget = Decoration.replace({
                widget: new FastExternalEmbedWidget(parsed, renderer),
              });
              pending.push({ from: matchStart, to: matchEnd, widget });
            }
          }
        }

        // 必须按坐标严格从小到大排序，并确保区间互不重叠，否则 RangeSetBuilder 会抛出异常导致 CodeMirror 崩溃
        pending.sort((a, b) => a.from - b.from);
        let lastTo = -1;
        for (const item of pending) {
          if (item.from >= lastTo) {
            builder.add(item.from, item.to, item.widget);
            lastTo = item.to;
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
