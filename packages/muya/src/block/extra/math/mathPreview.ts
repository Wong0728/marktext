import type { Muya } from '../../../muya';
import type { IMathBlockState, TState } from '../../../state/types';
import { fromEvent } from 'rxjs';
import { CLASS_NAMES } from '../../../config';
import { escapeHTML } from '../../../utils';
import { renderMath } from '../../../utils/katex';
import logger from '../../../utils/logger';
import Parent from '../../base/parent';

const debug = logger('mathPreview:');

class MathPreview extends Parent {
    private _math: string;

    static override blockName = 'math-preview';

    static create(muya: Muya, state: IMathBlockState) {
        const mathBlock = new MathPreview(muya, state);

        return mathBlock;
    }

    override get path() {
        debug.warn('You can never call `get path` in htmlPreview');
        return [];
    }

    constructor(muya: Muya, { text }: IMathBlockState) {
        super(muya);
        this.tagName = 'div';
        this._math = text;
        this.classList = ['mu-math-preview'];
        this.attributes = {
            spellcheck: 'false',
            contenteditable: 'false',
        };
        this.createDomNode();
        this._attachDOMEvents();
        this.update();
    }

    override getState(): TState {
        debug.warn('You can never call `getState` in mathPreview');
        return {} as TState;
    }

    private _attachDOMEvents() {
        const clickObservable = fromEvent(this.domNode!, 'click');
        clickObservable.subscribe(this.clickHandler.bind(this));
    }

    clickHandler(event: Event) {
        event.preventDefault();
        event.stopPropagation();

        const cursorBlock = this.parent!.firstContentInDescendant();
        cursorBlock?.setCursor(0, 0);
    }

    update(math = this._math) {
        if (this._math !== math)
            this._math = math;

        const { i18n } = this.muya;

        if (math) {
            try {
                const html = renderMath(math, {
                    displayMode: true,
                });
                this.domNode!.innerHTML = html;
            }
            catch (err) {
                // Show the original LaTeX source instead of a localized error label
                // so the user can still see/copy the intended formula.
                const message = err instanceof Error ? err.message : i18n.t('Invalid Mathematical Formula');
                this.domNode!.innerHTML = `<div class="${CLASS_NAMES.MU_MATH_ERROR}" title="${escapeHTML(message)}">${escapeHTML(math)}</div>`;
            }
        }
        else {
            this.domNode!.innerHTML = `<div class="${CLASS_NAMES.MU_EMPTY}">&lt; ${i18n.t(
                'Empty Mathematical Formula',
            )} &gt;</div>`;
        }
    }
}

export default MathPreview;
