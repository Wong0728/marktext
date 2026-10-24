import type Format from '../../block/base/format';
import type { CodeEmojiMathToken, ISyntaxRenderOptions, Token } from '../types';
import type Renderer from './index';
import { CLASS_NAMES } from '../../config';
import { renderMathOrThrow } from '../../utils/katex';
import { htmlToVNode } from '../../utils/snabbdom';

// The openers pandoc reads as display rather than inline math: `$$` from
// `tex_math_dollars`, `\[` and `\\[` from the two backslash extensions.
const DISPLAY_MATH_MARKERS = new Set(['$$', '\\[', '\\\\[']);

function isDisplayMarker(marker: string) {
    return DISPLAY_MATH_MARKERS.has(marker);
}

function isBlankOrDisplayMath(token: Token) {
    switch (token.type) {
        case 'inline_math':
            return isDisplayMarker(token.marker);
        case 'text':
            return token.content.trim() === '';
        case 'soft_line_break':
        case 'hard_line_break':
            return true;
        default:
            return false;
    }
}

// A display formula is drawn in display mode only in a paragraph that holds
// nothing but such formulas; next to other text, or in a heading or table cell,
// it stays inline. pandoc instead draws `\[…\]` in display mode wherever it
// appears, but `.katex-display` is a centred block, which would break the line
// around it — so muya keeps the rule it already applies to `$$…$$` (#4904).
function isDisplayMath(token: CodeEmojiMathToken, block: Format) {
    if (!isDisplayMarker(token.marker) || block.blockName !== 'paragraph.content')
        return false;

    const siblings = token.parent;
    const coversParagraph = siblings[0].range.start === 0
        && siblings[siblings.length - 1].range.end === block.text.length;

    return coversParagraph && siblings.every(isBlankOrDisplayMath);
}

export default function inlineMath(this: Renderer, {
    h,
    cursor,
    block,
    token,
    outerClass,
}: ISyntaxRenderOptions & { token: CodeEmojiMathToken }) {
    const className = this.getClassName(outerClass, block, token, cursor);
    const { start, end } = token.range;
    const { marker } = token;
    const displayMode = isDisplayMath(token, block);
    let mathSelector
        = className === CLASS_NAMES.MU_HIDE
            ? `span.${className}.${CLASS_NAMES.MU_MATH}`
            : `span.${CLASS_NAMES.MU_MATH}`;
    let markerSelector = `span.${className}.${CLASS_NAMES.MU_MATH_MARKER}`;
    if (displayMode) {
        mathSelector += `.${CLASS_NAMES.MU_DISPLAY_MATH}`;
        markerSelector += `.${CLASS_NAMES.MU_DISPLAY_MATH}`;
    }

    const startMarker = this.highlight(
        h,
        block,
        start,
        start + marker.length,
        token,
    );
    const endMarker = this.highlight(h, block, end - marker.length, end, token);
    const content = this.highlight(
        h,
        block,
        start + marker.length,
        end - marker.length,
        token,
    );

    const { content: math, type } = token;

    const { loadMathMap } = this;

    const key = JSON.stringify([math, type, displayMode]);
    let mathVnode = null;
    const previewSelector = `span.${CLASS_NAMES.MU_MATH_RENDER}`;
    // Inline math errors stay compact to keep the surrounding text baseline
    // (#4100, inline-math-align); surface the parse reason via the title.
    const errorTitle = '';
    if (loadMathMap.has(key)) {
        mathVnode = loadMathMap.get(key);
    }
    else {
        try {
            const html = renderMathOrThrow(math, {
                displayMode,
            });
            mathVnode = htmlToVNode(html);
            loadMathMap.set(key, mathVnode);
        }
        catch (err) {
            // Build the .math-fallback vNode via h() so the title/role/aria-label
            // attrs are applied by snabbdom's attributesModule. Routing the
            // renderMath HTML string through htmlToVNode instead drops these
            // attrs: toVNode attaches the temp wrapper's elm to the vNode, and
            // patch reuses that elm without re-running the attrs create hook.
            const message = err instanceof Error ? err.message : 'parse error';
            const fallbackTitle = `原始公式: ${math} | 错误: ${message}`;
            mathVnode = h('span.math-fallback', {
                attrs: {
                    'title': fallbackTitle,
                    'role': 'img',
                    'aria-label': '公式无法渲染',
                },
            }, '[公式]');
        }
    }

    return [
        h(markerSelector, startMarker),
        h(mathSelector, [
            h(
                `span.${CLASS_NAMES.MU_INLINE_RULE}.${CLASS_NAMES.MU_MATH_TEXT}`,
                {
                    attrs: { spellcheck: 'false' },
                },
                content,
            ),
            h(
                previewSelector,
                {
                    attrs: errorTitle
                        ? { contenteditable: 'false', title: errorTitle }
                        : { contenteditable: 'false' },
                    dataset: {
                        start: String(start + marker.length),
                        end: String(end - marker.length),
                    },
                },
                mathVnode,
            ),
        ]),
        h(markerSelector, endMarker),
    ];
}
