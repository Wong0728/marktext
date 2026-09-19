// @vitest-environment happy-dom
import type Content from '../../block/base/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya } from '../../muya';

// Copying a selection INSIDE a display-math block (#14: copy formula →
// Office). The editable leaf under a `math-block` holds the bare LaTeX body —
// the `$$` fences live on the block — so the same-block copy path used to
// emit literal TeX text and the MathML upgrade in `writeClipboardData` never
// triggered (the body rarely matches MATH_LIKE_REG). Now the same-block path
// re-fences the body and renders the html slot as standalone MathML, so
// "复制为富文本" pastes a native Word equation.

const hosts: HTMLElement[] = [];
beforeEach(() => {
    window.MUYA_VERSION = 'test';
});
afterEach(() => {
    while (hosts.length)
        hosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
});

function boot(md: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown: md } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    hosts.push(muya.domNode);
    return muya;
}

function selectRange(leaf: Content, start: number, end: number) {
    const muya = leaf.muya;
    muya.editor.activeContentBlock = leaf;
    muya.editor.selection.setSelection(
        { offset: start, block: leaf, path: leaf.path },
        { offset: end, block: leaf, path: leaf.path },
    );
}

describe('same-block copy inside a display-math block', () => {
    it('fences the body and renders MathML in the html slot', () => {
        const muya = boot('$$\nE=mc^2\n$$\n\nplain paragraph\n');
        const leaf = muya.editor.scrollPage!.firstContentInDescendant()!;
        selectRange(leaf, 0, leaf.text.length);

        const { html, text } = muya.editor.clipboard.getClipboardData();

        expect(text).toBe('$$\nE=mc^2\n$$');
        expect(html).toContain('<math');
        expect(html).not.toContain('$$');
    });

    it('renders MathML for a partial selection of the body', () => {
        const muya = boot('$$\nE=mc^2\n$$\n');
        const leaf = muya.editor.scrollPage!.firstContentInDescendant()!;
        selectRange(leaf, 0, 4);

        const { html, text } = muya.editor.clipboard.getClipboardData();

        expect(text).toBe('$$\nE=mc\n$$');
        expect(html).toContain('<math');
    });

    it('leaves non-math same-block copies unchanged', () => {
        const muya = boot('$$\nE=mc^2\n$$\n\nplain paragraph\n');
        const paragraph = muya.editor.scrollPage!.lastContentInDescendant()!;
        selectRange(paragraph, 0, paragraph.text.length);

        const { html, text } = muya.editor.clipboard.getClipboardData();

        expect(text).toBe('plain paragraph');
        expect(html).not.toContain('<math');
    });

    it('keeps an empty selection (bare caret) copying nothing', () => {
        const muya = boot('$$\nE=mc^2\n$$\n');
        const leaf = muya.editor.scrollPage!.firstContentInDescendant()!;
        selectRange(leaf, 0, 0);

        const { text } = muya.editor.clipboard.getClipboardData();

        expect(text).toBe('');
    });
});
