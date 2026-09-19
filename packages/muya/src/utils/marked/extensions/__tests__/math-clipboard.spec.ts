// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { getClipBoardHtml } from '../../getClipboardHtml';

// The rich-text clipboard renders math as standalone MathML so Word /
// Word online paste it as a native equation object, while non-math content
// is unchanged. `math` must be enabled for the extension to run at all.
const BASE_OPTIONS = { math: true, frontMatter: true };

describe('clipboard HTML — mathRenderMode: mathml', () => {
    it('block math renders as <math> MathML', () => {
        const html = getClipBoardHtml('$$x^2 + y^2 = z^2$$', {
            ...BASE_OPTIONS,
            mathRenderMode: 'mathml',
        });
        expect(html).toContain('<math');
        expect(html).not.toContain('$$');
    });

    it('inline math renders as <math> MathML', () => {
        const html = getClipBoardHtml('Euler: $e^{i\\pi} + 1 = 0$ done', {
            ...BASE_OPTIONS,
            mathRenderMode: 'mathml',
        });
        expect(html).toContain('<math');
        expect(html).toContain('Euler:');
        expect(html).toContain('done');
    });

    it('non-math content is unchanged by mathml mode', () => {
        const src = '# 标题\n\n中文段落，含 **加粗** 与 $ 5 元现金文本。';
        const plain = getClipBoardHtml(src, { ...BASE_OPTIONS, mathRenderMode: 'plain' });
        const mathml = getClipBoardHtml(src, { ...BASE_OPTIONS, mathRenderMode: 'mathml' });
        expect(mathml).toBe(plain);
        expect(mathml).not.toContain('<math');
    });

    it('unparsable formulas fall back to the LaTeX source instead of error markup', () => {
        const html = getClipBoardHtml('$$\\thisIsNotACommand{x}$$', {
            ...BASE_OPTIONS,
            mathRenderMode: 'mathml',
        });
        expect(html).not.toContain('<math');
        expect(html).toContain('\\thisIsNotACommand{x}');
    });
});
