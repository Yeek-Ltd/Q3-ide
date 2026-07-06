const fs = require('fs');
const f = 'D:/Code/QwenCodeIDE/vscode/out/vs/nls.js';
let c = fs.readFileSync(f, 'utf8');
const old = 'throw new Error(`!!! NLS MISSING: ${index} !!!`);';
const repl = 'return typeof fallback === "string" ? fallback : String(fallback ?? "");';
if (c.includes(old)) {
  c = c.replace(old, repl);
  fs.writeFileSync(f, c);
  console.log('nls.js patched successfully');
} else {
  console.log('Pattern not found - already patched or different format');
}
