'use strict';
// Copia o motor compartilhado para a extensão e gera o .vsix:  node tools/build.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const ext = path.join(root, 'vscode-extension');
fs.mkdirSync(path.join(ext, 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'plugin', 'scripts', 'core.js'), path.join(ext, 'lib', 'core.js'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
// --no-dependencies: a extensão não tem dependências npm (e o `npm list` do vsce falha no npm 12)
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(ext, 'LICENSE'));
// nome fixo: o instalador (install.js) e o README apontam para dist/claude-request-history.vsix
execSync('npx --yes @vscode/vsce@3 package --no-dependencies -o ../dist/claude-request-history.vsix',
  { cwd: ext, stdio: 'inherit' });
