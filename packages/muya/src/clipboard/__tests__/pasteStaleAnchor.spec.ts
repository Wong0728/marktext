// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type { Muya } from '../../muya';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaClass } from '../../muya';
import { SelectionCaretType, SelectionDirection } from '../../selection/types';

// Rapid double-paste race guard: applyPaste suspends at its awaits (image
// hook, HTML normalization). If a concurrent paste / undo detaches the
// snapshotted anchor in the meantime, the post-await `anchorBlock.getCursor()`
// returns null (the selection now points elsewhere) and the stale paste must
// be abandoned instead of throwing on the destructuring.

vi.mock('../../utils/prism/index', () => ({
    default: {},
    walkTokens: () => null,
    loadedLanguages: new Set(),
    transformAliasToOrigin: (s: string) => s,
    loadLanguage: () => null,
    search: () => [],
}));

// normalizePastedHTML uses DOMPurify which needs a richer DOM than happy-dom
// gives; we only paste plain-text markdown here, so pass the html through.
vi.mock('../../utils/paste', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../utils/paste')>();
    return { ...actual, normalizePastedHTML: async (html: string) => html };
});

const bootedHosts: HTMLElement[] = [];
let hadVersion = false;
let originalVersion: string | undefined;

beforeEach(() => {
    hadVersion = 'MUYA_VERSION' in window;
    originalVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length)
        bootedHosts.pop()!.remove();
    if (hadVersion)
        window.MUYA_VERSION = originalVersion as string;
    else
        delete (window as Partial<Window>).MUYA_VERSION;
});

function bootMuya(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new MuyaClass(host, { markdown } as ConstructorParameters<typeof MuyaClass>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);
    return muya;
}

function contentBlocks(muya: Muya): Content[] {
    const out: Content[] = [];
    let c: Content | null = muya.editor.scrollPage!.firstContentInDescendant();
    while (c) {
        out.push(c);
        c = c.nextContentInContext() ?? null;
    }
    return out;
}

function selectionFor(block: Content, offset: number) {
    const path = block.path;
    return {
        anchor: { offset, block, path },
        focus: { offset, block, path },
        isCollapsed: true,
        isSelectionInSameBlock: true,
        direction: SelectionDirection.FORWARD,
        type: SelectionCaretType.RANGE,
    };
}

function pasteEvent(text: string) {
    return {
        preventDefault() {},
        stopPropagation() {},
        clipboardData: {
            getData: (t: string) => (t === 'text/plain' ? text : ''),
            files: [],
            items: [],
        },
    } as unknown as ClipboardEvent;
}

describe('paste — stale anchor after the async pipeline suspends', () => {
    it('abandons the paste when the anchor no longer owns the selection', async () => {
        const muya = bootMuya('foobar\n\nsecond\n');
        const blocks = contentBlocks(muya);
        const anchor = blocks[0];
        const elsewhere = blocks[1];

        // First read resolves the paste's anchor; every later read (the
        // cursor checks after the awaits) sees the caret moved on by the
        // concurrent operation, exactly as in a rapid double-paste.
        let calls = 0;
        muya.editor.selection.getSelection = () => {
            const sel = calls++ === 0
                ? selectionFor(anchor, 0)
                : selectionFor(elsewhere, 0);
            return sel as ReturnType<Muya['editor']['selection']['getSelection']>;
        };

        const pending = muya.editor.clipboard.pasteHandler(pasteEvent('hello'), 'hello', '');

        await expect(pending).resolves.toBeUndefined();
        expect(muya.getMarkdown()).toBe('foobar\n\nsecond\n');
    });
});
