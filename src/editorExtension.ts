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
    this.renderer.render(this.parsed, container);
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

        // 获取当前光标所在的行号范围，光标所在行保持原文本不渲染，方便用户编辑
        const cursorLineStart = state.doc.lineAt(selection.from).from;
        const cursorLineEnd = state.doc.lineAt(selection.to).to;

        for (const { from, to } of view.visibleRanges) {
          const text = state.sliceDoc(from, to);

          // 正则 1: 匹配 ![[...]]
          const wikiRegex = /!\[\[(.*?)\]\]/g;
          let match: RegExpExecArray | null;
          while ((match = wikiRegex.exec(text)) !== null) {
            const matchStart = from + match.index;
            const matchEnd = matchStart + match[0].length;

            // 如果光标在该行，跳过替换
            if (selection.from <= matchEnd && selection.to >= matchStart) {
              continue;
            }
            if (matchStart >= cursorLineStart && matchEnd <= cursorLineEnd) {
              continue;
            }

            const target = match[1];
            const parsed = renderer.parseTarget(target);
            if (parsed) {
              const widget = Decoration.replace({
                widget: new FastExternalEmbedWidget(parsed, renderer),
                block: true,
              });
              builder.add(matchStart, matchEnd, widget);
            }
          }

          // 正则 2: 匹配 ![alt](url)
          const mdRegex = /!\[(.*?)\]\((.*?)\)/g;
          while ((match = mdRegex.exec(text)) !== null) {
            const matchStart = from + match.index;
            const matchEnd = matchStart + match[0].length;

            // 如果光标在该行，跳过替换
            if (selection.from <= matchEnd && selection.to >= matchStart) {
              continue;
            }
            if (matchStart >= cursorLineStart && matchEnd <= cursorLineEnd) {
              continue;
            }

            const altText = match[1];
            const target = match[2];
            const parsed = renderer.parseTarget(target, altText);
            if (parsed) {
              const widget = Decoration.replace({
                widget: new FastExternalEmbedWidget(parsed, renderer),
                block: true,
              });
              builder.add(matchStart, matchEnd, widget);
            }
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
