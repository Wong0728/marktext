// @vitest-environment happy-dom

import type { Muya as MuyaType } from '../../../../muya';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Muya } from '../../../../muya';

// Invalid math now shows a gray .math-fallback placeholder carrying the
// original LaTeX source + KaTeX parse reason in its title tooltip, instead of
// a red .mu-math-error label or a localized "Invalid Mathematical Formula" /
// "公式错误" string. The placeholder keeps the document readable while the
// formula stays copyable from the title.

const bootedHosts: HTMLElement[] = [];
let originalVersion: string | undefined;
let hadVersion = false;

beforeEach(() => {
    hadVersion = 'MUYA_VERSION' in window;
    originalVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length)
        bootedHosts.pop()!.remove();
    document.getSelection()?.removeAllRanges();
    if (hadVersion)
        window.MUYA_VERSION = originalVersion as string;
    else
        delete (window as Partial<Window>).MUYA_VERSION;
});

function bootMuya(markdown: string): MuyaType {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new Muya(host, { markdown } as ConstructorParameters<typeof Muya>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);
    return muya;
}

describe('invalid math shows a gray placeholder with the source in title', () => {
    it('inline math `$\\frac{1}{$` shows .math-fallback with [公式] text, source + parse reason in title', () => {
        const muya = bootMuya('$\\frac{1}{$\n');
        const fallbackEl = muya.domNode.querySelector('.math-fallback');
        expect(fallbackEl).not.toBeNull();
        const title = fallbackEl!.getAttribute('title') ?? '';
        expect(title).toMatch(/parse error/i);
        expect(title).toContain('\\frac{1}{');
        expect(fallbackEl!.textContent ?? '').toContain('[公式]');
        expect(muya.domNode.textContent ?? '').not.toContain('Invalid Mathematical Formula');
    });

    it('block math `$$\\frac{1}{$$` shows .math-fallback with [公式] text, source + parse reason in title', () => {
        const muya = bootMuya('$$\n\\frac{1}{\n$$\n');
        const fallbackEl = muya.domNode.querySelector('.math-fallback');
        expect(fallbackEl).not.toBeNull();
        const title = fallbackEl!.getAttribute('title') ?? '';
        expect(title).toMatch(/parse error/i);
        expect(title).toContain('\\frac{1}{');
        expect(muya.domNode.textContent ?? '').not.toContain('Invalid Mathematical Formula');
    });
});
