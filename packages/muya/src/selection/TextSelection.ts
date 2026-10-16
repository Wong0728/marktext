import type Content from '../block/base/content';
import type Format from '../block/base/format';
import type { TBlockPath } from '../block/types';
import type { Muya } from '../muya';
import type { Nullable } from '../types';
import type Selection from './index';
import type { IAnchorFocusInfo, INodeOffset, ISelection } from './types';
import { BLOCK_DOM_PROPERTY } from '../config';
import { isHTMLElement, isMouseEvent } from '../utils';
import logger from '../utils/logger';
import {
    buildSelectionAffiliation,
    endpointBlockInfo,
} from './affiliation';
import { getCursorCoords } from './cursorCoords';
import {
    compareParagraphsOrder,
    findContentDOM,
    getLegalOffset,
    getNodeAndOffset,
    getOffsetOfParagraph,
} from './dom';
import { SelectionCaretType, SelectionDirection, SelectionType } from './types';

const debug = logger('selection:');

// The browser can clone an `mu-content` span during native edit behavior
// (e.g. an un-cancelled Enter while an IME composition is active — see
// docs/ime-composition-delete-broken.md). The clone lacks the
// `BLOCK_DOM_PROPERTY` backlink. While a composition owns the DOM the clone
// cannot be removed safely, so the block is read from an adjacent real
// content node instead; once the composition ends, `_healOrphanClones` drops
// the clone and re-renders the real block from state.
function resolveOrphanSiblingBlock(domNode: HTMLElement): Content | undefined {
    const parent = domNode.parentElement;
    if (!parent)
        return undefined;

    for (const sibling of parent.children) {
        if (sibling !== domNode && isHTMLElement(sibling) && sibling.classList.contains('mu-content')) {
            const block = sibling[BLOCK_DOM_PROPERTY] as Content | undefined;
            if (block)
                return block;
        }
    }

    return undefined;
}

function computeDirection(
    anchorBlock: Content,
    focusBlock: Content,
    anchorOffset: number,
    focusOffset: number,
    isSelectionInSameBlock: boolean,
): SelectionDirection {
    if (isSelectionInSameBlock) {
        return anchorOffset < focusOffset
            ? SelectionDirection.FORWARD
            : SelectionDirection.BACKWARD;
    }

    return compareParagraphsOrder(anchorBlock.domNode!, focusBlock.domNode!)
        ? SelectionDirection.FORWARD
        : SelectionDirection.BACKWARD;
}

function computeCaretType(
    anchorBlock: Nullable<Content>,
    focusBlock: Nullable<Content>,
    isCollapsed: boolean,
): SelectionCaretType {
    if (!anchorBlock && !focusBlock)
        return SelectionCaretType.NONE;

    return isCollapsed ? SelectionCaretType.CARET : SelectionCaretType.RANGE;
}

class TextSelection {
    public anchorPath: TBlockPath = [];
    public anchorBlock: Nullable<Content> = null;
    public focusPath: TBlockPath = [];
    public focusBlock: Nullable<Content> = null;
    public anchor: Nullable<INodeOffset> = null;
    public focus: Nullable<INodeOffset> = null;

    private _doc: Document = document;

    private _selectInfo: {
        isSelect: boolean;
        selection: { anchor: IAnchorFocusInfo; focus: IAnchorFocusInfo } | null;
    } = {
        isSelect: false,
        selection: null,
    };

    constructor(private _muya: Muya, private _selection: Selection) {
        this._listenSelectActions();
    }

    private get _scrollPage() {
        return this._muya.editor.scrollPage;
    }

    private get _isCollapsed() {
        const { anchorBlock, focusBlock, anchor, focus } = this;

        if (anchor == null || focus == null)
            return false;

        return anchorBlock === focusBlock && anchor.offset === focus.offset;
    }

    get isSelectionInSameBlock() {
        const { anchorBlock, focusBlock, anchor, focus } = this;

        if (anchor == null || focus == null)
            return false;

        return anchorBlock === focusBlock;
    }

    private get _direction() {
        const {
            anchor,
            focus,
            anchorBlock,
            focusBlock,
            isSelectionInSameBlock,
            _isCollapsed: isCollapsed,
        } = this;
        if (anchor == null || focus == null || !anchorBlock || !focusBlock)
            return SelectionDirection.NONE;

        if (isCollapsed)
            return SelectionDirection.NONE;

        return computeDirection(
            anchorBlock,
            focusBlock,
            anchor.offset,
            focus.offset,
            isSelectionInSameBlock,
        );
    }

    private get _type() {
        const { anchorBlock, focusBlock, _isCollapsed: isCollapsed } = this;

        return computeCaretType(anchorBlock, focusBlock, isCollapsed);
    }

    collapse(): void {
        this.anchor = null;
        this.focus = null;
        this.anchorBlock = null;
        this.focusBlock = null;
        this.anchorPath = [];
        this.focusPath = [];
        this._updateSelection();
        this._emitSelectionChange();
    }

    selectAllContent() {
        const { _scrollPage: scrollPage } = this;
        const aBlock = scrollPage?.firstContentInDescendant();
        const fBlock = scrollPage?.lastContentInDescendant();

        if (aBlock == null || fBlock == null)
            return;

        this.setSelection(
            { offset: 0, block: aBlock, path: aBlock.path },
            { offset: fBlock.text.length, block: fBlock, path: fBlock.path },
        );
        const activeEle = this._doc.activeElement;
        if (isHTMLElement(activeEle) && activeEle.classList.contains('mu-content'))
            activeEle.blur();
    }

    getSelection(): ISelection | null {
        const selection = this._doc.getSelection();

        if (!selection)
            return null;

        const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;

        if (!anchorNode || !focusNode)
            return null;

        const anchorDomNode = findContentDOM(anchorNode);
        const focusDomNode = findContentDOM(focusNode);

        if (!anchorDomNode || !focusDomNode)
            return null;

        // An orphan clone poisons every coordinate read through it: an offset
        // measured inside the clone is relative to the clone, and committing
        // it via `setCursor` parks the caret at a wrong — often zero —
        // position of the real block. Repair the DOM here, then re-read a
        // clean selection for the event that triggered the heal.
        if (this._healOrphanClones(anchorDomNode, focusDomNode))
            return this.getSelection();

        const anchorBlock
            = (anchorDomNode[BLOCK_DOM_PROPERTY] as Content | undefined)
                ?? resolveOrphanSiblingBlock(anchorDomNode);
        const focusBlock
            = (focusDomNode[BLOCK_DOM_PROPERTY] as Content | undefined)
                ?? resolveOrphanSiblingBlock(focusDomNode);
        // Any orphan clone that can be healed was already removed above, so
        // this fallback only serves the IME-composition window (and the rare
        // clone with no adjacent real content node). Callers must treat null
        // as "skip this event", never as "detach from the engine".
        if (!anchorBlock || !focusBlock) {
            debug.warn('selection resolves to content node(s) without a block backlink; returning null');
            return null;
        }

        if (!anchorBlock.outMostBlock || !focusBlock.outMostBlock)
            return null;

        const anchorPath = anchorBlock.path;
        const focusPath = focusBlock.path;

        const aOffset = getOffsetOfParagraph(anchorNode, anchorDomNode) + anchorOffset;
        const fOffset = getOffsetOfParagraph(focusNode, focusDomNode) + focusOffset;
        const anchor = { offset: aOffset };
        const focus = { offset: fOffset };

        const isCollapsed = anchorBlock === focusBlock && anchor.offset === focus.offset;
        const isSelectionInSameBlock = anchorBlock === focusBlock;

        const direction = computeDirection(
            anchorBlock,
            focusBlock,
            anchor.offset,
            focus.offset,
            isSelectionInSameBlock,
        );
        const type = computeCaretType(anchorBlock, focusBlock, isCollapsed);

        return {
            anchor: { offset: anchor.offset, block: anchorBlock, path: anchorPath },
            focus: { offset: focus.offset, block: focusBlock, path: focusPath },
            isCollapsed,
            isSelectionInSameBlock,
            direction,
            type,
        };
    }

    setSelection(anchor: IAnchorFocusInfo, focus: IAnchorFocusInfo) {
        this.anchor = { offset: anchor.offset };
        this.anchorBlock = anchor.block;
        this.anchorPath = anchor.path;
        this.focus = { offset: focus.offset };
        this.focusBlock = focus.block;
        this.focusPath = focus.path;
        this._updateSelection();
        this._emitSelectionChange();
    }

    // The block's text state never contains a browser-cloned `mu-content`
    // span, so state is the source of truth: drop the clone, re-render the
    // real block, and collapse the native caret into it. During an active IME
    // composition the browser owns the real span's DOM (re-rendering now would
    // cancel the session), so healing is deferred — the tolerant adopt path in
    // `getSelection` serves that window, and the first event after
    // compositionend repairs the DOM. Returns true when a heal happened, in
    // which case the caller must re-read the selection.
    private _healOrphanClones(anchorDomNode: HTMLElement, focusDomNode: HTMLElement): boolean {
        let healedBlock: Content | null = null;

        for (const domNode of [anchorDomNode, focusDomNode]) {
            if (domNode[BLOCK_DOM_PROPERTY] || !domNode.isConnected)
                continue;

            const realBlock = resolveOrphanSiblingBlock(domNode);
            if (!realBlock || realBlock.isComposed)
                continue;

            const parent = domNode.parentElement;
            if (!parent)
                continue;

            for (const child of [...parent.children]) {
                if (
                    isHTMLElement(child)
                    && child.classList.contains('mu-content')
                    && !child[BLOCK_DOM_PROPERTY]
                ) {
                    debug.warn(`healed orphan mu-content clone, discarded text: "${child.textContent}"`);
                    child.remove();
                }
            }

            realBlock.update();
            healedBlock ??= realBlock;
        }

        if (!healedBlock)
            return false;

        // The native selection died with the removed clone. Park it at a known
        // good position (block start) so the re-read — and the event dispatch
        // that follows — see a valid, correctly coordinated selection.
        const { node, offset } = getNodeAndOffset(healedBlock.domNode!, 0);
        const range = this._doc.createRange();
        range.setStart(node, getLegalOffset(node, offset));
        range.collapse(true);
        const selection = this._doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        return true;
    }

    private _emitSelectionChange() {
        const { _isCollapsed: isCollapsed, isSelectionInSameBlock, _direction: direction, _type: type } = this;
        const anchorBlock = this.anchorBlock ?? null;
        const focusBlock = this.focusBlock ?? null;

        // Follow the caret (focus end) for forward selections so typewriter
        // scrolling tracks the cursor rather than the selection start.
        const cursorCoords = getCursorCoords(direction === SelectionDirection.FORWARD);
        // Duck-type the Format block — a value import of Format here would
        // create a selection -> format circular dependency.
        const anchorBlockRef = anchorBlock as Format | null;
        const formats
            = isSelectionInSameBlock
                && anchorBlockRef
                && typeof anchorBlockRef.getFormatsInRange === 'function'
                ? anchorBlockRef.getFormatsInRange().formats
                : [];

        const affiliation = buildSelectionAffiliation(anchorBlock, focusBlock);

        this._muya.eventCenter.emit('selection-change', {
            anchor: this.anchor,
            focus: this.focus,
            anchorBlock,
            anchorPath: this.anchorPath,
            focusBlock,
            focusPath: this.focusPath,
            isCollapsed,
            isSelectionInSameBlock,
            direction,
            type,
            kind: SelectionType.TEXT,
            selectedImage: this._selection.image,
            cursorCoords,
            formats,
            affiliation,
            anchorBlockInfo: endpointBlockInfo(anchorBlock),
            focusBlockInfo: endpointBlockInfo(focusBlock),
        });
    }

    private _listenSelectActions() {
        const { eventCenter, domNode } = this._muya;

        const handleMousedown = () => {
            this._selectInfo = {
                isSelect: true,
                selection: null,
            };
        };

        const handleMouseupOrLeave = () => {
            if (this._selectInfo.selection)
                this.setSelection(this._selectInfo.selection.anchor, this._selectInfo.selection.focus);

            this._selectInfo = {
                isSelect: false,
                selection: null,
            };
        };

        const handleMousemoveOrClick = (event: Event) => {
            if (!isMouseEvent(event))
                return;

            const { type, shiftKey } = event;
            if (type === 'mousemove' && !this._selectInfo.isSelect)
                return;

            if (type === 'click' && !shiftKey)
                return;

            const selection = this.getSelection();
            if (!selection)
                return;

            const { anchor, focus, isSelectionInSameBlock } = selection;

            if (isSelectionInSameBlock) {
                return;
            }

            const anchorBlock = anchor.block;
            const focusBlock = focus.block;
            const endpointAnchor = { offset: anchor.offset, block: anchorBlock, path: anchorBlock.path };
            const endpointFocus = { offset: focus.offset, block: focusBlock, path: focusBlock.path };

            if (type === 'mousemove')
                this._selectInfo.selection = { anchor: endpointAnchor, focus: endpointFocus };
            else
                this.setSelection(endpointAnchor, endpointFocus);
        };

        eventCenter.attachDOMEvent(domNode, 'mousedown', handleMousedown);
        eventCenter.attachDOMEvent(domNode, 'mousemove', handleMousemoveOrClick);
        eventCenter.attachDOMEvent(domNode, 'mouseup', handleMouseupOrLeave);
        eventCenter.attachDOMEvent(domNode, 'mouseleave', handleMouseupOrLeave);
        eventCenter.attachDOMEvent(domNode, 'click', handleMousemoveOrClick);
    }

    private _selectRange(range: Range) {
        const selection = this._doc.getSelection();

        if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    private _select(
        startNode: Node,
        startOffset: number,
        endNode?: Node,
        endOffset?: number,
    ) {
        const range = this._doc.createRange();
        range.setStart(startNode, getLegalOffset(startNode, startOffset));
        if (endNode && typeof endOffset === 'number')
            range.setEnd(endNode, getLegalOffset(endNode, endOffset));
        else
            range.collapse(true);

        this._selectRange(range);

        return range;
    }

    private _setFocus(focusNode: Node, focusOffset: number) {
        const selection = this._doc.getSelection();
        if (selection)
            selection.extend(focusNode, getLegalOffset(focusNode, focusOffset));
    }

    // Keep a cached endpoint offset inside its block's text. An offset past
    // the text (handed over by a conversion, a stale handler, or a restored
    // selection for a since-shortened block) parks the DOM caret at the block
    // end via `getLegalOffset`, but the cache keeps the overshoot — the next
    // read/edit would splice at a phantom position. Clamping here, at the
    // single bottleneck every `setSelection` flows through, keeps the cached
    // offset and the DOM range consistent.
    private _clampOffsetToBlockText(endpoint: Nullable<INodeOffset>, block: Nullable<Content>): void {
        if (endpoint && block && endpoint.offset > block.text.length)
            endpoint.offset = block.text.length;
    }

    private _updateSelection() {
        const {
            anchor,
            focus,
            anchorBlock,
            anchorPath,
            focusBlock,
            focusPath,
            _scrollPage: scrollPage,
        } = this;

        if (!anchor || !focus) {
            const selection = this._doc.getSelection();

            if (selection)
                selection.removeAllRanges();

            return;
        }

        this._clampOffsetToBlockText(anchor, anchorBlock);
        this._clampOffsetToBlockText(focus, focusBlock);

        const anchorParagraph = anchorBlock
            ? anchorBlock.domNode
            : scrollPage?.queryBlock([...anchorPath]);
        const focusParagraph = focusBlock
            ? focusBlock.domNode
            : scrollPage?.queryBlock([...focusPath]);

        // getNodeAndOffset expects a DOM Node. The fallback branch can hand
        // back a Parent/Content block (from scrollPage.queryBlock); narrow to
        // an actual Node here, preserving the existing not-found behavior.
        if (!(anchorParagraph instanceof Node) || !(focusParagraph instanceof Node)) {
            debug.warn('could not resolve cached selection to DOM nodes; DOM range not updated');
            return;
        }
        const { node: anchorNode, offset: anchorOffset } = getNodeAndOffset(
            anchorParagraph,
            anchor.offset,
        );
        const { node: focusNode, offset: focusOffset } = getNodeAndOffset(
            focusParagraph,
            focus.offset,
        );

        this._select(anchorNode, anchorOffset);
        this._setFocus(focusNode, focusOffset);
    }
}

export default TextSelection;
