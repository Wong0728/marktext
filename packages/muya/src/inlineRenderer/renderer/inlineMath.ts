import type { CodeEmojiMathToken, ISyntaxRenderOptions } from '../types';
import type Renderer from './index';
import { CLASS_NAMES } from '../../config';
import { renderMathOrThrow } from '../../utils/katex';
import { htmlToVNode } from '../../utils/snabbdom';

export default function inlineMath(this: Renderer, {
    h,
    cursor,
    block,
    token,
    outerClass,
}: ISyntaxRenderOptions & { token: CodeEmojiMathToken }) {
    const className = this.getClassName(outerClass, block, token, cursor);
    const mathSelector
        = className === CLASS_NAMES.MU_HIDE
            ? `span.${className}.${CLASS_NAMES.MU_MATH}`
            : `span.${CLASS_NAMES.MU_MATH}`;

    const { start, end } = token.range;
    const { marker } = token;

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

    const { content: math, type, displayMode: tokenDisplayMode } = token;

    const { loadMathMap } = this;

    const displayMode = tokenDisplayMode ?? false;
    const key = `${math}_${type}_${displayMode}`;
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
        h(`span.${className}.${CLASS_NAMES.MU_MATH_MARKER}`, startMarker),
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
        h(`span.${className}.${CLASS_NAMES.MU_MATH_MARKER}`, endMarker),
    ];
}
