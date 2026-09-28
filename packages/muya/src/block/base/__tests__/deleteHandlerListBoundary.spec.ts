// @vitest-environment happy-dom

import type { Muya } from '../../../muya';
import type Format from '../format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaClass } from '../../../muya';

vi.mock('../../../utils/prism/index', () => ({
    default: {},
    walkTokens: () => null,
    loadedLanguages: new Set(),
    transformAliasToOrigin: (s: string) => s,
    loadLanguage: () => null,
    search: () => [],
}));

// `Format.deleteHandler` (Delete at the end of a block merges the next
// paragraph in). When the merge crosses a container boundary, the trailing
// siblings of the merged-in paragraph may only travel with the merge when they
// come from a SIBLING container (item next to item in one list, #1845). A
// top-level paragraph merging into a list item dissolves by itself: its later
// top-level siblings are unrelated blocks and must stay top-level.

const bootedHosts: HTMLElement[] = [];
let hadVersion = false;
let originalVersion: string | undefined;

beforeEach(() => {
    hadVersion = 'MUYA_VERSION' in window;
    originalVersion = window.MUYA_VERSION;
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length) {
        const host = bootedHosts.pop()!;
        host.remove();
    }
    document.getSelection()?.removeAllRanges();
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

// Park the caret at the end of the document's first content leaf and fire the
// Delete handler.
function deleteForwardAtEndOfFirstBlock(muya: Muya): void {
    const content = muya.editor.scrollPage!.firstContentInDescendant() as unknown as Format;
    content.setCursor(content.text.length, content.text.length, true);
    content.deleteHandler({ preventDefault: () => {} } as unknown as KeyboardEvent);
}

describe('deleteHandler — merging across a list boundary', () => {
    it('keeps following top-level blocks top-level when a list item merges a paragraph', async () => {
        // Blank lines keep `follow A` / `follow B` as top-level paragraphs:
        // without them the loader lazy-continues the lines into the list item.
        const muya = bootMuya('- item\n\nfollow A\n\nfollow B\n');
        deleteForwardAtEndOfFirstBlock(muya);

        // `follow A` merges into the item; `follow B` must NOT be pulled into
        // the list item — previously every top-level block after the merged
        // paragraph became item content and the structure change persisted.
        // (The serializer keeps a blank line after the list so `follow B` does
        // not lazy-continue into the item on reload.)
        // json1 ops flush to the document state on the next animation frame.
        await vi.waitFor(() => {
            expect(muya.getMarkdown()).toBe('- itemfollow A\n\nfollow B\n');
        });
    });

    it('still pulls the next item\'s nested list along when merging item-to-item (#1845)', async () => {
        const muya = bootMuya('- one\n- two\n  - nested\n');
        deleteForwardAtEndOfFirstBlock(muya);

        // `two` merges into `one`; the nested sublist under item two travels
        // into item one (otherwise it is left as the sole child of an emptied
        // item and serializes with a doubled bullet).
        await vi.waitFor(() => {
            expect(muya.getMarkdown()).toBe('- onetwo\n  - nested\n');
        });
    });
});
