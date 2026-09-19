const { JSDOM } = require('jsdom')

const prepareHtmlForDocx = (html) => {
  const doc = new JSDOM(html).window.document

  for (const wrapper of doc.querySelectorAll('.katex-display')) {
    const math = wrapper.querySelector('.katex-mathml > math')
    if (!math) continue
    const div = doc.createElement('div')
    div.appendChild(math)
    wrapper.replaceWith(div)
  }

  for (const katex of doc.querySelectorAll('.katex')) {
    const math = katex.querySelector('.katex-mathml > math')
    if (!math) continue
    katex.replaceWith(math)
  }

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}

const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>T</title></head>
<body>
<article class="markdown-body">
<h1>Test</h1>
<p>Inline <code>code</code> and math <span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">x</span></span>.</p>
<table>
<thead><tr><th>A</th><th>B</th></tr></thead>
<tbody><tr><td>1</td><td>2</td></tr></tbody>
</table>
</article>
</body>
</html>`

const result = prepareHtmlForDocx(html)
console.log(result)
