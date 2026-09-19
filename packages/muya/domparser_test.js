const { JSDOM } = require('jsdom')

const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>T</title></head>
<body>
<article class="markdown-body">
<p>Inline <code>code</code> here.</p>
<pre><code class="language-python">def f():
    pass
</code></pre>
<table>
<thead><tr><th>A</th><th>B</th></tr></thead>
<tbody><tr><td>1</td><td>2</td></tr></tbody>
</table>
</article>
</body>
</html>`

const dom = new JSDOM(html)
const doc = dom.window.document
const result = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
console.log(result)
