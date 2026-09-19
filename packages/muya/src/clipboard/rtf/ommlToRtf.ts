/**
 * OMML (Office Math Markup) → RTF math groups.
 *
 * Word's native clipboard carries equations as RTF `{\mmath{\*\moMath ...}}`
 * groups — each OMML element maps to a control word `\m` + the OMML element
 * name with its case preserved (verified against Word's own RTF output:
 * m:sSup → \msSup, m:f → {\mf{\mfPr...}{\mnum...}{\mden...}}, text runs are
 * `{\mr <text>}`). Word's RTF parser is tolerant of missing property groups,
 * so we emit the structural elements and runs and skip property/attribute
 * wrappers (except n-ary operand characters, where dropping the character
 * would change the meaning of the formula).
 */

const NARY_LIMLOC_DEFAULT = 'undOvr';

function escapeRtfText(text: string): string {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0)!;
        if (ch === '\\' || ch === '{' || ch === '}') {
            out += `\\${ch}`;
        }
        else if (ch === '\r' || ch === '\n') {
            // Real newlines never occur inside a math run.
            out += ' ';
        }
        else if (code < 128) {
            out += ch;
        }
        else {
            // \uN needs a literal fallback character; `?` is the conventional
            // one. Signed representation for code points above 32767.
            const signed = code > 32767 ? code - 65536 : code;
            out += `\\uc1\\u${signed} ?`;
        }
    }
    return out;
}

function elementVal(element: Element): string | null {
    return element.getAttribute('m:val') ?? element.getAttribute('val');
}

/**
 * Convert a property element's salient value (n-ary character, limits
 * placement) to RTF control words. Returns '' for properties Word can default.
 */
function emitProperty(element: Element): string {
    switch (element.localName) {
        case 'chr': {
            const val = elementVal(element);
            return val ? `{\\mchr ${escapeRtfText(val)}}` : '';
        }
        case 'limLoc': {
            const val = elementVal(element);
            return val && val !== NARY_LIMLOC_DEFAULT ? `{\\mlimLoc ${escapeRtfText(val)}}` : '';
        }
        case 'type': {
            const val = elementVal(element);
            return val && val !== 'bar' ? `{\\mtype ${escapeRtfText(val)}}` : '';
        }
        default:
            return '';
    }
}

function emitNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return escapeRtfText(node.nodeValue ?? '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
    }

    const element = node as Element;
    if (element.localName === 't') {
        // <m:t> holds the run text; children are text nodes only.
        return escapeRtfText(element.textContent ?? '');
    }

    // Property groups: only their salient values matter to Word.
    if (element.localName.endsWith('Pr')) {
        let out = '';
        for (const child of element.children) {
            out += emitProperty(child);
        }
        return out;
    }

    let children = '';
    for (const child of element.childNodes) {
        children += emitNode(child);
    }
    // An RTF control word followed by literal text needs a single space as
    // its delimiter (`{\mr x}`), otherwise the text merges into the word
    // (`\mrO` parses as one unknown control word). A `{` delimiter needs no
    // space.
    const needsDelimiter = children.length > 0 && !children.startsWith('{');
    return `{\\m${element.localName}${needsDelimiter ? ' ' : ''}${children}}`;
}

export function ommlToRtf(omml: string): string {
    const doc = new DOMParser().parseFromString(omml, 'application/xml');
    const root = doc.documentElement;
    if (!root || root.localName !== 'oMath') {
        return '';
    }

    let content = '';
    for (const child of root.children) {
        content += emitNode(child);
    }
    return `{\\mmath{\\*\\moMath${content}}}`;
}
