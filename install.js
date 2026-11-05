#!/usr/bin/env node
'use strict';
/**
 * Instalador do Histórico de Requisições do Claude Code (plugin + extensão do VS Code).
 *
 *   npx -y --allow-git=all github:marco3079/skill-git-claude-code                 instala ou atualiza
 *   npx -y --allow-git=all github:marco3079/skill-git-claude-code --desinstalar   remove (o histórico gravado é mantido)
 *
 * --allow-git=all: o npm 12 bloqueia pacotes vindos do git sem essa opção (nas versões antigas ela é ignorada).
 *
 * CLAUDE_HISTORICO_SOURCE=<pasta ou owner/repo> troca a origem do marketplace (útil para testar localmente).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = 'marco3079/skill-git-claude-code';
const SOURCE = process.env.CLAUDE_HISTORICO_SOURCE || REPO;
const MARKETPLACE = 'historico-requisicoes';
// historico: hooks, CLI e skills; historico-painel: painel ao lado do chat (desktop e VS Code)
const PLUGINS = ['historico', 'historico-painel'];
const EXT_ID = 'marco3079.claude-request-history';
// IDs usados por versões anteriores da extensão: saem na instalação para não ficarem duas
const OLD_EXT_IDS = ['bottomup.claude-request-history'];
const VSIX = path.join(__dirname, 'dist', 'claude-request-history.vsix');
const IS_WIN = process.platform === 'win32';

const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = s => console.log(`${c(32, '✔')} ${s}`);
const warn = s => console.log(`${c(33, '!')} ${s}`);
const info = s => console.log(`${c(36, '›')} ${s}`);

function quote(a) { return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a; }

function run(cmd, args) {
  // comandos sem caminho no Windows costumam ser .cmd (code.cmd, claude.cmd): precisam do shell
  const shell = IS_WIN && !path.isAbsolute(cmd);
  const r = shell
    ? spawnSync([cmd, ...args].map(quote).join(' '), { shell: true, encoding: 'utf8', windowsHide: true })
    : spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { code: r.error ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function works(cmd) { return run(cmd, ['--version']).code === 0; }

/** CLI do Claude: no PATH ou o binário que vem dentro da extensão do VS Code. */
function findClaude() {
  if (works('claude')) return 'claude';
  const exe = IS_WIN ? 'claude.exe' : 'claude';
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].map(d => path.join(os.homedir(), d, 'extensions'));
  const found = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter(d => d.startsWith('anthropic.claude-code-')); } catch (_) { continue; }
    for (const d of dirs) {
      const bin = path.join(root, d, 'resources', 'native-binary', exe);
      if (fs.existsSync(bin)) found.push({ bin, mtime: fs.statSync(bin).mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.length && works(found[0].bin) ? found[0].bin : null;
}

function findCode() {
  return ['code', 'code-insiders', 'cursor', 'windsurf'].find(works) || null;
}

function otherCopies() {
  try {
    const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const f = path.join(config, 'plugins', 'installed_plugins.json');
    const keys = Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).plugins || {});
    return keys.filter(k => PLUGINS.some(p => k.startsWith(`${p}@`)) && !k.endsWith(`@${MARKETPLACE}`));
  } catch (_) { return []; }
}

// ---------------------------------------------------------------------------

function installPlugins(claude) {
  if (!claude) {
    warn('Não encontrei o CLI do Claude Code. No chat do Claude, rode estes comandos:');
    console.log(`    /plugin marketplace add ${REPO}`);
    for (const p of PLUGINS) console.log(`    /plugin install ${p}@${MARKETPLACE}`);
    return false;
  }
  let r = run(claude, ['plugin', 'marketplace', 'add', SOURCE]);
  if (r.code !== 0) {
    // já adicionado antes: só atualiza
    r = run(claude, ['plugin', 'marketplace', 'update', MARKETPLACE]);
    if (r.code !== 0) { warn(`Falha ao adicionar o marketplace:\n${r.out}`); return false; }
  }
  ok(`Marketplace "${MARKETPLACE}" pronto (${SOURCE})`);
  let all = true;
  for (const p of PLUGINS) {
    r = run(claude, ['plugin', 'install', `${p}@${MARKETPLACE}`]);
    if (r.code !== 0 || /already/i.test(r.out)) {
      const u = run(claude, ['plugin', 'update', `${p}@${MARKETPLACE}`]);
      if (r.code !== 0 && u.code !== 0) { warn(`Falha ao instalar o plugin "${p}":\n${r.out}\n${u.out}`); all = false; continue; }
    }
    ok(`Plugin "${p}" instalado no Claude Code`);
  }
  for (const k of otherCopies()) {
    warn(`Há outra cópia instalada (${k}); remova para não rodar em dobro: claude plugin uninstall ${k}`);
  }
  return all;
}

function installExtension(code) {
  if (!fs.existsSync(VSIX)) { warn(`Arquivo da extensão não encontrado: ${VSIX}`); return false; }
  if (!code) {
    warn('Não encontrei o comando "code" do VS Code. Instale a extensão manualmente:');
    console.log(`    VS Code → Extensões → "..." → Instalar do VSIX… → ${VSIX}`);
    return false;
  }
  const installed = run(code, ['--list-extensions']).out.toLowerCase().split(/\r?\n/);
  for (const old of OLD_EXT_IDS) {
    if (installed.includes(old)) { run(code, ['--uninstall-extension', old]); ok(`Versão antiga da extensão removida (${old})`); }
  }
  const r = run(code, ['--install-extension', VSIX, '--force']);
  if (r.code !== 0) { warn(`Falha ao instalar a extensão:\n${r.out}`); return false; }
  ok(`Extensão "Claude Request History" instalada (${code})`);
  return true;
}

function uninstall(claude, code) {
  if (claude) {
    for (const p of PLUGINS) run(claude, ['plugin', 'uninstall', `${p}@${MARKETPLACE}`]);
    run(claude, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
    ok('Plugins e marketplace removidos do Claude Code');
  } else {
    for (const p of PLUGINS) warn(`No chat do Claude: /plugin uninstall ${p}@${MARKETPLACE}`);
  }
  if (code) {
    for (const id of [EXT_ID, ...OLD_EXT_IDS]) run(code, ['--uninstall-extension', id]);
    ok('Extensão removida do VS Code');
  }
  info(`O histórico gravado continua em ${path.join(os.homedir(), '.claude', 'request-history')} (apague se quiser).`);
}

function main() {
  console.log(c(1, '\nHistórico de Requisições do Claude Code\n'));
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { warn(`Node.js ${process.versions.node} é antigo; use o 18 ou mais novo.`); process.exitCode = 1; return; }
  if (!works('git')) warn('git não encontrado no PATH: o plugin precisa dele para gravar o histórico (https://git-scm.com).');

  const claude = findClaude();
  const code = findCode();
  if (process.argv.includes('--desinstalar') || process.argv.includes('--uninstall')) {
    uninstall(claude, code);
    return;
  }
  const p = installPlugins(claude);
  const e = installExtension(code);
  console.log('');
  if (p && e) {
    ok('Tudo pronto. Para ativar:');
    console.log('    1. Recarregue o VS Code: Ctrl+Shift+P → "Developer: Reload Window"');
    console.log('    2. Abra uma conversa nova do Claude Code');
    console.log('    3. O painel "Histórico" abre ao lado do chat (ou digite /historico-painel);');
    console.log('       no editor do VS Code também há o botão do histórico no topo e o Ctrl+Alt+H');
  } else {
    warn('Instalação incompleta: siga os avisos acima.');
    process.exitCode = 1;
  }
}

main();
