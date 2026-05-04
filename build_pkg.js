// 打包脚本
const path = require('path');

const vscePath = path.join(__dirname, 'node_modules', '@vscode/vsce', 'out', 'main.js');
const vsce = require(vscePath);
const argv = ['node', 'vsce', 'package'];

console.log('Running vsce from:', __dirname);
try {
  vsce(argv);
} catch (err) {
  console.error('vsce error:', err.message);
  process.exit(1);
}
console.log('Done');
