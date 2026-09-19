const createDOMPurify = require('dompurify')
const { JSDOM } = require('jsdom')

const { window } = new JSDOM('')
const DOMPurify = createDOMPurify(window)

const EXPORT_DOMPURIFY_CONFIG_OLD = {
  FORBID_ATTR: ['contenteditable'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['data-align'],
  USE_PROFILES: {
    html: true,
    svg: true,
    svgFilters: true,
    mathMl: false,
  },
  RETURN_TRUSTED_TYPE: false,
}

const EXPORT_DOMPURIFY_CONFIG_NEW = {
  FORBID_ATTR: ['contenteditable'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['data-align'],
  USE_PROFILES: {
    html: true,
    svg: true,
    svgFilters: true,
    mathMl: true,
  },
  RETURN_TRUSTED_TYPE: false,
}

const html = `<article class="markdown-body">
<p>Inline <code>code</code> here.</p>
<pre><code class="language-python">def f():
    pass
</code></pre>
<table>
<thead><tr><th>A</th><th>B</th></tr></thead>
<tbody><tr><td>1</td><td>2</td></tr></tbody>
</table>
<p>Math: <span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">x</span></span></p>
</article>`

console.log('OLD (mathMl:false):')
console.log(DOMPurify.sanitize(html, EXPORT_DOMPURIFY_CONFIG_OLD))
console.log('\nNEW (mathMl:true):')
console.log(DOMPurify.sanitize(html, EXPORT_DOMPURIFY_CONFIG_NEW))
