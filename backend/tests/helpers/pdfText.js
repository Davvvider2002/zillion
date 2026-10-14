/**
 * Test-only: reads a PDF's positioned text the way the browser does (pdf.js), so the parser can be tested on the real sample file.
 * pdfjs-dist is a devDependency; it is not deployed with the functions.
 */
'use strict';
async function extractPdfPages(buffer) {
  const log = console.log, warn = console.warn;
  let pdfjs, doc;
  try { console.log = () => {}; console.warn = () => {}; pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  } finally { console.log = log; console.warn = warn; }
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    pages.push({ items: tc.items.map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width })) });
  }
  await doc.destroy();
  return pages;
}
module.exports = { extractPdfPages };
