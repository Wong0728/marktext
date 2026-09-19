import { mml2omml } from 'mathml2omml';
import { ommlToRtf } from './ommlToRtf';

/**
 * Clipboard HTML (the MathML-mode rich-copy render) → RTF.
 *
 * Word prefers RTF over HTML on paste, and RTF is the only format it turns
 * into native, editable equations — so the rich-text copy carries the same
 * rendered content a third time as RTF, with every `<math>` element converted
 * MathML → OMML → `{\mmath{\*\moMath ...}}`. HTML-only targets (browsers,
 * email) and plain-text targets are unaffected: they keep using the other two
 * clipboard slots.
 *
 * The walker is deliberately small — headings/bold/italic/code and paragraphs
 * are enough for prose copied out of a markdown editor. Anything it doesn't
 * recognise degrades to its text content.
 */

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'TR']);

// KaTeX wraps its standalone MathML in `<span class="katex">`; the LaTeX
// source annotation inside must not reach mml2omml (it emits a console
// warning and is not rendered by Word anyway — Word ignores it, but the
// converter's output is cleaner without it).
function mathElementToRtf(math: Element): string {
    try {
        const clone = math.cloneNode(true) as Element;
        clone.querySelectorAll('annotation').forEach(a => a.remove());
        const mml = new XMLSerializer().serializeToString(clone);
        const omml = mml2omml(mml);
        return ommlToRtf(omml);
    }
    catch {
        return '';
    }
}

function escapeText(text: string): string {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0)!;
        if (ch === '\\' || ch === '{' || ch === '}') {
            out += `\\${ch}`;
        }
        else if (code < 128) {
            out += ch;
        }
        else {
            const signed = code > 32767 ? code - 65536 : code;
            out += `\\uc1\\u${signed} ?`;
        }
    }
    return out;
}

function wrapInline(tag: string, content: string): string {
    return content ? `{${tag}${content}}` : '';
}

function emitChildren(node: Node): string {
    let out = '';
    for (const child of node.childNodes) {
        out += emitNode(child);
    }
    return out;
}

function emitNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return escapeText(node.nodeValue ?? '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
    }

    const element = node as Element;

    if (element.tagName === 'MATH') {
        return mathElementToRtf(element);
    }
    // KaTeX's outer span (or any wrapper) is transparent.
    if (element.tagName === 'SPAN') {
        return emitChildren(element);
    }
    if (element.tagName === 'BR') {
        return '\\line ';
    }

    switch (element.tagName) {
        case 'B':
        case 'STRONG':
            return wrapInline('\\b ', emitChildren(element));
        case 'I':
        case 'EM':
            return wrapInline('\\i ', emitChildren(element));
        case 'U':
            return wrapInline('\\ul ', emitChildren(element));
        case 'S':
        case 'DEL':
        case 'STRIKE':
            return wrapInline('\\strike ', emitChildren(element));
        default:
            break;
    }

    const content = emitChildren(element);
    if (BLOCK_TAGS.has(element.tagName)) {
        return `${content}\\par\r\n`;
    }
    return content;
}

export function htmlToRtf(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let content = emitChildren(doc.body ?? doc);

    // Trim trailing paragraph breaks so the RTF does not end with empty lines.
    content = content.replace(/(?:\\par\r\n)+$/i, '');

    return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\\f0\\fs22 ${content}}`;
}
