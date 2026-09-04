const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const files = [];
function walk(dir, exts) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, exts);
    else if (exts.some((e) => f.endsWith(e))) files.push(p);
  }
}
walk(path.join(__dirname, '..', 'web'), ['.js']);
walk(path.join(__dirname, '..', 'lib'), ['.js']);
walk(path.join(__dirname, '..', 'scripts'), ['.js']);
files.push(path.join(__dirname, '..', 'server.js'));
files.push(path.join(__dirname, '..', 'config.js'));
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) {
    bad++;
    console.log('✗ ' + path.relative(path.join(__dirname, '..'), f));
    console.log(String(e.stderr).split('\n').slice(0, 6).join('\n'));
  }
}
console.log(bad ? `\n${bad} 个文件语法错误` : `全部 ${files.length} 个 JS 文件语法通过`);
process.exit(bad ? 1 : 0);
