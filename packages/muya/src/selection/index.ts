import type TableBodyCell from '../block/gfm/table/cell';
import type { Muya } from '../muya';
import type { IAnchorFocusInfo, IImageSelectionData, ISelection } from './types';
import {
    getCursorCoords,
    getCursorYOffset,
    getSelectionStart,
} from './cursorCoords';
import ImageSelection from './ImageSelection';
import TableRectSelection from './TableRectSelection';
import TextSelection from './TextSelection';
import { SelectionType } from './types';

// A block node reference (content leaf or parent container) as returned on
// the selection endpoints.
type IBlockRef = NonNullable<ReturnType<Selection['getSelection']>>['anchor']['block'];

class Selection {
    static getCursorYOffset(paragraph: HTMLElement) {
        return getCursorYOffset(paragraph);
    }

    static getCursorCoords(preferEnd = false) {
        return getCursorCoords(preferEnd);
    }

    static getSelectionStart() {
        return getSelectionStart();
    }

    private _text: TextSelection;
    private _image: ImageSelection;
    private _table: TableRectSelection;

    constructor(private _muya: Muya) {
        this._text = new TextSelection(this._muya, this);
        this._image = new ImageSelection(this._muya, this);
        this._image.attach();
        this._table = TableRectSelection.create(this._muya);
    }

    get type(): SelectionType {
        if (this._image.selected)
            return SelectionType.IMAGE;
        if (this._table.hasSelection)
            return SelectionType.TABLE;
        return SelectionType.TEXT;
    }

    get current(): TextSelection | TableRectSelection | ImageSelection {
        switch (this.type) {
            case SelectionType.IMAGE: return this._image;
            case SelectionType.TABLE: return this._table;
            default: return this._text;
        }
    }

    get image(): IImageSelectionData | null {
        return this._image.selected;
    }

    get table(): TableRectSelection {
        return this._table;
    }

    get anchorBlock() {
        return this._text.anchorBlock;
    }

    get anchorPath() {
        return this._text.anchorPath;
    }

    get focusBlock() {
        return this._text.focusBlock;
    }

    get focusPath() {
        return this._text.focusPath;
    }

    get anchor() {
        return this._text.anchor;
    }

    get focus() {
        return this._text.focus;
    }

    get isSelectionInSameBlock() {
        return this._text.isSelectionInSameBlock;
    }

    selectImage(data: IImageSelectionData): void {
        this._image.selected = data;
        this._muya.editor.activeContentBlock = null;
        this.activate(SelectionType.IMAGE);
    }

    activate(type: SelectionType): void {
        if (type !== SelectionType.TEXT)
            this._text.collapse();
        if (type !== SelectionType.TABLE)
            this._table.clear();
        if (type !== SelectionType.IMAGE)
            this._image.clear();

        if (type !== SelectionType.TEXT) {
            this._muya.eventCenter.emit('selection-change', {
                kind: type,
            });
        }
    }

    clear(): void {
        this._text.collapse();
        this._table.clear();
        this._image.clear();
    }

    clearImage(): void {
        this._image.clear();
    }

    getSelection(): ISelection | null {
        return this._text.getSelection();
    }

    setSelection(anchor: IAnchorFocusInfo, focus: IAnchorFocusInfo): void {
        this._text.setSelection(anchor, focus);
    }

    selectAll(): void {
        const tableSelection = this._table;

        // A frozen rectangular table selection escalates: the whole table jumps
        // to the whole document; any partial rectangle (a single cell included)
        // grows to the whole table first.
        if (tableSelection.hasSelection) {
            if (tableSelection.isWholeTableSelected()) {
                tableSelection.clear();
                this._text.selectAllContent();
            }
            else {
                tableSelection.selectWholeTable();
            }
            return;
        }

        // Read the live DOM selection so the caret the user actually sees is
        // honored. selectAll is driven from the application menu, so the cached
        // endpoints may be stale — e.g. after a whole-document selection blurred
        // the editor and the user clicked back into a single block.
        const live = this.getSelection();
        const anchorBlock = live ? live.anchor.block : this._text.anchorBlock;
        const focusBlock = live ? live.focus.block : this._text.focusBlock;
        const anchorOffset = live ? live.anchor.offset : this._text.anchor?.offset;
        const focusOffset = live ? live.focus.offset : this._text.focus?.offset;

        // A caret or selection contained in a single content block.
        if (anchorBlock && anchorBlock === focusBlock && anchorOffset != null && focusOffset != null) {
            // Inside one table cell: freeze it as a 1x1 rectangle.
            if (anchorBlock.blockName === 'table.cell.content') {
                const cellBlock = anchorBlock.closestBlock('table.cell') as TableBodyCell | null;
                if (cellBlock) {
                    tableSelection.selectSingleCell(cellBlock);
                    return;
                }
            }

            // A partial selection grows to the whole block; a full-block
            // selection falls through to the whole document.
            if (Math.abs(focusOffset - anchorOffset) < anchorBlock.text.length) {
                const path = anchorBlock.path;
                this._text.setSelection(
                    { offset: 0, block: anchorBlock, path },
                    { offset: anchorBlock.text.length, block: anchorBlock, path },
                );
                return;
            }
        }

        // Spanning multiple blocks, or a single block already fully selected.
        this._text.selectAllContent();
    }

    /**
     * The markdown source text covered by the current text selection
     * (empty string when nothing is selected). Exact within one content
     * leaf; a best-effort concatenation across leaves/blocks otherwise —
     * sufficient for status displays like a selection word count (#2791).
     */
    getSelectedText(): string {
        const sel = this.getSelection();
        if (!sel)
            return '';

        const { anchor, focus } = sel;
        const anchorBlock = anchor.block;
        const focusBlock = focus.block;
        if (anchorBlock == null || focusBlock == null)
            return '';

        if (anchorBlock === focusBlock) {
            const start = Math.min(anchor.offset, focus.offset);
            const end = Math.max(anchor.offset, focus.offset);
            return (anchorBlock as { text?: string }).text?.substring(start, end) ?? '';
        }

        try {
            const anchorFirst = this._isBeforeInDocument(
                anchorBlock.outMostBlock!,
                focusBlock.outMostBlock!,
            );
            const startBlock = anchorFirst ? anchorBlock : focusBlock;
            const endBlock = anchorFirst ? focusBlock : anchorBlock;
            const startOffset = anchorFirst ? anchor.offset : focus.offset;
            const endOffset = anchorFirst ? focus.offset : anchor.offset;
            // Both endpoints inside the same outmost container: the head part
            // must skip leaves up to and including the start leaf.
            const sameOutmost = anchorBlock.outMostBlock === focusBlock.outMostBlock;

            const parts: string[] = [];
            // Tail of the boundary leaf, plus any later leaves of its block.
            parts.push(...this._leafTextsFrom(startBlock.outMostBlock!, startBlock, startOffset));
            // Whole outmost blocks strictly between the two boundaries.
            let node: IBlockRef | null = sameOutmost ? null : startBlock.outMostBlock!.next;
            while (node != null && node !== endBlock.outMostBlock) {
                parts.push(...this._leafTextsFrom(node, null, 0));
                node = node.next;
            }
            // Head of the end boundary up to the caret.
            parts.push(
                ...this._leafTextsUntil(
                    endBlock.outMostBlock!,
                    endBlock,
                    endOffset,
                    sameOutmost ? startBlock : null,
                ),
            );

            return parts.filter(p => p.length > 0).join('\n');
        }
        catch {
            return '';
        }
    }

    // Whether `a` precedes `b` in document order (outmost-block level).
    private _isBeforeInDocument(a: IBlockRef, b: IBlockRef): boolean {
        let node: IBlockRef | null = a;
        for (let i = 0; i < 10_000 && node != null; i++) {
            if (node === b)
                return true;
            node = node.next;
        }
        return false;
    }

    // Leaf texts of `outmost` from `boundary` (inclusive, from `offset` when
    // given) onwards. `boundary == null` means the whole block.
    private _leafTextsFrom(outmost: IBlockRef, boundary: IBlockRef, offset: number): string[] {
        const leaves: string[] = [];
        let pastBoundary = boundary == null;
        const walk = (block: unknown): void => {
            const b = block as { children?: unknown[]; text?: string };
            if (Array.isArray(b.children)) {
                for (const child of b.children)
                    walk(child);
                return;
            }
            const text = typeof b.text === 'string' ? b.text : '';
            if (!pastBoundary) {
                if (block === boundary) {
                    pastBoundary = true;
                    leaves.push(text.substring(offset));
                }
                return;
            }
            leaves.push(text);
        };
        walk(outmost);
        return leaves;
    }

    // Leaf texts of `outmost` up to and including `boundary`, truncated to
    // `offset` on the boundary leaf. When `startAfter` is given (both
    // endpoints share the same outmost block), leaves up to and including it
    // are skipped so text before the selection start is not counted twice.
    private _leafTextsUntil(
        outmost: IBlockRef,
        boundary: IBlockRef,
        offset: number,
        startAfter: IBlockRef | null = null,
    ): string[] {
        const leaves: string[] = [];
        let pastStart = startAfter == null;
        const walk = (block: unknown): void => {
            const b = block as { children?: unknown[]; text?: string };
            if (Array.isArray(b.children)) {
                for (const child of b.children)
                    walk(child);
                return;
            }
            if (!pastStart) {
                if (block === startAfter)
                    pastStart = true;
                return;
            }
            const text = typeof b.text === 'string' ? b.text : '';
            if (block === boundary) {
                leaves.push(text.substring(0, offset));
                return;
            }
            leaves.push(text);
        };
        walk(outmost);
        return leaves;
    }
}

export function getCursorReference() {
    const rect = getCursorCoords();

    if (!rect)
        return null;

    return {
        getBoundingClientRect() {
            return rect;
        },
        clientWidth: rect.width,
        clientHeight: rect.height,
    };
}

export default Selection;
