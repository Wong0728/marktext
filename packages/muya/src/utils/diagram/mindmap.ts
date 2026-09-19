import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

const transformer = new Transformer();

function renderMindmap(target: HTMLElement, code: string) {
    const { root } = transformer.transform(code);
    target.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    target.appendChild(svg);
    Markmap.create(svg, { autoFit: true }, root);
}

export default renderMindmap;
