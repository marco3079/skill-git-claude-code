'use strict';
/**
 * Claude Request History — popup com o histórico de requisições gravado pelo plugin "historico" do Claude Code.
 * Lê ~/.claude/request-history/projects/<chave>/index.json e o repositório git sombra (via lib/core.js).
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./lib/core');

const SCHEME = 'claude-rh';
const POLL_MS = 1000;

let ctx;
let panel = null;
let statusItem;
let currentKey = null;
let lastStamp = '';
let lastSignal = 0;
let knownDone = null;

// ---------------------------------------------------------------------------
// projetos

function isInside(child, parent) {
  const c = core.normalizeDir(child);
  const p = core.normalizeDir(parent);
  return c === p || c.startsWith(p + '/');
}

let storesCache = { at: 0, list: [] };

/** Projetos com histórico que pertencem às pastas abertas nesta janela (cache de 5 s: roda a cada poll). */
function workspaceStores() {
  if (Date.now() - storesCache.at < 5000) return storesCache.list;
  storesCache = { at: Date.now(), list: scanStores() };
  return storesCache.list;
}

function scanStores() {
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  const out = [];
  for (const dir of folders) {
    const s = new core.Store(dir);
    if (s.exists()) out.push(s);
  }
  for (const p of core.listProjects()) {
    if (out.some(s => s.key === p.key)) continue;
    if (folders.some(f => isInside(p.project, f) || isInside(f, p.project))) out.push(new core.Store(p.project));
  }
  return out;
}

function currentStore() {
  const stores = workspaceStores();
  if (!stores.length) return null;
  let s = stores.find(x => x.key === currentKey);
  if (!s) {
    const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath;
    s = (active && stores.find(x => isInside(active, x.projectDir))) || stores[0];
    currentKey = s.key;
  }
  return s;
}

function storeByKey(key) {
  return workspaceStores().find(s => s.key === key) || null;
}

function stamp(file) {
  try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// estado enviado ao webview

function buildState() {
  const stores = workspaceStores();
  const store = currentStore();
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  const base = {
    projects: stores.map(s => ({ key: s.key, name: path.basename(s.projectDir), project: s.projectDir })),
    key: store ? store.key : null,
    folder: folders[0] || null,
  };
  if (!store) return Object.assign(base, { empty: true });
  const idx = store.load();
  if (!idx) return Object.assign(base, { empty: true });
  const t = core.computeTargets(idx);
  const running = idx.entries.find(e => store.isRunning(e));
  return Object.assign(base, {
    project: idx.project,
    name: path.basename(idx.project),
    disabled: idx.disabled,
    entries: idx.entries.slice(-800),
    head: idx.head,
    targets: { undo: t.undo ? t.undo.id : null, redo: t.redo ? t.redo.id : null },
    running: running ? running.id : null,
  });
}

function post(msg) {
  if (panel) panel.webview.postMessage(msg);
}

function refresh(force) {
  const store = currentStore();
  const st = store ? stamp(store.indexFile) : 'none';
  if (!force && st === lastStamp) return;
  lastStamp = st;
  const state = buildState();
  post({ type: 'state', state });
  updateStatus(state);
  notifyFinished(state);
}

// ---------------------------------------------------------------------------
// barra de status + notificação

function updateStatus(state) {
  if (!state.entries) { statusItem.hide(); return; }
  const reqs = state.entries.filter(e => e.kind === 'request');
  const last = reqs[reqs.length - 1];
  if (state.running) {
    const r = reqs.find(e => e.id === state.running);
    statusItem.text = `$(sync~spin) Claude #${r ? r.seq : ''}`;
  } else {
    statusItem.text = `$(git-commit) Claude${last ? ' #' + last.seq : ''}`;
  }
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Histórico de requisições** — ${state.name}\n\n`);
  if (last) md.appendMarkdown(`Última: #${last.seq} ${escapeMd(last.title)}\n\n`);
  md.appendMarkdown('Clique para abrir (Ctrl+Alt+H)');
  statusItem.tooltip = md;
  statusItem.show();
}

function escapeMd(s) { return String(s || '').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&'); }

function notifyFinished(state) {
  if (!state.entries) return;
  const done = state.entries.filter(e => e.kind === 'request' && e.status === 'done' && e.commit);
  const ids = new Set(done.map(e => e.id + e.commit));
  if (knownDone === null || knownDone.key !== state.key) { knownDone = { key: state.key, ids }; return; }
  const fresh = done.filter(e => !knownDone.ids.has(e.id + e.commit));
  knownDone.ids = ids;
  if (!fresh.length) return;
  const r = fresh[fresh.length - 1];
  const cfg = vscode.workspace.getConfiguration('claudeHistory');
  if (cfg.get('autoOpen')) openPanel();
  if (!cfg.get('notify') || panel && panel.visible) return;
  vscode.window.showInformationMessage(
    `Claude: requisição #${r.seq} concluída — ${r.fileCount} arquivo(s), +${r.add} −${r.del}`,
    'Ver histórico', 'Desfazer'
  ).then(choice => {
    if (choice === 'Ver histórico') openPanel(r.id);
    if (choice === 'Desfazer') runOp('undo');
  });
}

// ---------------------------------------------------------------------------
// painel (popup)

function nonce() { return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, ''); }

function html(webview) {
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Histórico de requisições</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}

async function openPanel(selectId, mode) {
  if (panel) {
    panel.reveal(undefined, false);
    if (selectId) post({ type: 'select', id: selectId });
    return;
  }
  const asPopup = (mode || vscode.workspace.getConfiguration('claudeHistory').get('openAs')) === 'popup';
  panel = vscode.window.createWebviewPanel('claudeHistory', 'Histórico do Claude', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
  });
  panel.iconPath = new vscode.ThemeIcon('history');
  panel.webview.html = html(panel.webview);
  panel.onDidDispose(() => { panel = null; });
  panel.webview.onDidReceiveMessage(m => onMessage(m).catch(e => vscode.window.showErrorMessage(String(e.message || e))));
  if (selectId) setTimeout(() => post({ type: 'select', id: selectId }), 400);
  if (asPopup) {
    try { await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); } catch (_) {}
  }
}

async function onMessage(m) {
  switch (m.type) {
    case 'ready':
      lastStamp = '';
      refresh(true);
      break;
    case 'selectProject':
      currentKey = m.key;
      lastStamp = '';
      refresh(true);
      break;
    case 'diff':
      await openDiff(m.id, m.path);
      break;
    case 'openFile': {
      const s = currentStore();
      const file = path.join(s.projectDir, m.path);
      if (fs.existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.One });
      else vscode.window.showWarningMessage(`${m.path} não existe mais no disco.`);
      break;
    }
    case 'patch':
      await openPatch(m.id);
      break;
    case 'undo':
    case 'redo':
      await runOp(m.type);
      break;
    case 'copy':
      await vscode.env.clipboard.writeText(m.text);
      vscode.window.setStatusBarMessage('$(check) Copiado', 1500);
      break;
    case 'popout':
      try { await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); } catch (_) {}
      break;
    default:
  }
}

// ---------------------------------------------------------------------------
// diff e patch

function entryOf(id) {
  const s = currentStore();
  const idx = s && s.load();
  const e = idx && idx.entries.find(x => x.id === id);
  return { s, e };
}

function revUri(s, rev, rel, side) {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: '/' + rel,
    query: JSON.stringify({ key: s.key, rev: rev || null, side }),
  });
}

async function openDiff(id, rel) {
  const { s, e } = entryOf(id);
  if (!e || !e.commit) return;
  const f = (e.files || []).find(x => x.p === rel) || { s: 'M' };
  const left = revUri(s, f.s === 'A' ? null : e.parent, rel, 'antes');
  const right = revUri(s, f.s === 'D' ? null : e.commit, rel, 'depois');
  const label = e.kind === 'request' ? `#${e.seq}` : e.kind === 'undo' ? `desfaz #${e.seq}` : e.kind === 'redo' ? `refaz #${e.seq}` : 'manual';
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(rel)} (${label}: antes ↔ depois)`, {
    viewColumn: vscode.ViewColumn.One, preview: true,
  });
}

async function openPatch(id) {
  const { s, e } = entryOf(id);
  if (!e || !e.commit) return;
  let text = s.patch(e.parent, e.commit);
  if (e.kind === 'request') {
    const head = [`# #${e.seq} ${e.title}`, `# commit ${e.commit}`, ''].join('\n');
    text = head + '\n' + text;
  }
  const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
}

class RevisionProvider {
  provideTextDocumentContent(uri) {
    const q = JSON.parse(uri.query || '{}');
    if (!q.rev) return '';
    const s = storeByKey(q.key);
    const buf = s && s.fileAt(q.rev, uri.path.replace(/^\//, ''));
    return buf ? buf.toString('utf8') : '';
  }
}

// ---------------------------------------------------------------------------
// desfazer / refazer

async function runOp(op) {
  const s = currentStore();
  if (!s) { vscode.window.showWarningMessage('Nenhum histórico do Claude para esta pasta.'); return; }
  const idx = s.load();
  const t = core.computeTargets(idx);
  const target = op === 'undo' ? t.undo : t.redo;
  if (!target) { vscode.window.showInformationMessage(op === 'undo' ? 'Nada para desfazer.' : 'Nada para refazer.'); return; }

  // arquivos abertos com alterações não salvas seriam sobrescritos
  const files = new Set((target.files || []).map(f => core.normalizeDir(path.join(s.projectDir, f.p))));
  const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === 'file' && files.has(core.normalizeDir(d.uri.fsPath)));
  if (dirty.length) {
    const names = dirty.map(d => path.basename(d.uri.fsPath)).join(', ');
    const choice = await vscode.window.showWarningMessage(
      `Há alterações não salvas em: ${names}.`, { modal: true, detail: 'Salve antes de continuar; as alterações salvas ficam registradas no histórico.' }, 'Salvar e continuar');
    if (choice !== 'Salvar e continuar') return;
    for (const d of dirty) await d.save();
  }

  post({ type: 'busy', on: true });
  let res;
  try {
    res = s.applyOp(op, { by: 'vscode' });
    if (!res.ok && res.reason === 'conflict') {
      const verb = op === 'undo' ? 'Desfazer' : 'Refazer';
      const choice = await vscode.window.showWarningMessage(
        `Arquivos da requisição #${res.seq} foram modificados depois dela.`,
        { modal: true, detail: `${res.conflicts.join('\n')}\n\nSe continuar, essas edições são sobrescritas no disco, mas ficam salvas no histórico como "alterações fora do Claude".` },
        `${verb} mesmo assim`);
      if (choice) res = s.applyOp(op, { by: 'vscode', force: true });
    }
  } finally {
    post({ type: 'busy', on: false });
  }
  lastStamp = '';
  refresh(true);
  if (!res) return;
  if (res.ok) {
    const again = op === 'undo' ? 'Refazer' : 'Desfazer';
    vscode.window.showInformationMessage(
      `${op === 'undo' ? 'Desfeita' : 'Refeita'} a requisição #${res.seq} (${res.files.length} arquivo(s)).`, again
    ).then(c => { if (c) runOp(op === 'undo' ? 'redo' : 'undo'); });
  } else if (res.reason !== 'conflict') {
    vscode.window.showWarningMessage(res.message);
  }
}

// ---------------------------------------------------------------------------
// pedido de abertura vindo do Claude (/historico:abrir)

function checkOpenSignal() {
  const file = path.join(core.HOME, 'signals', 'open.json');
  const st = stamp(file);
  if (!st || st === lastSignal) return;
  lastSignal = st;
  let sig;
  try { sig = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return; }
  if (!sig || Date.now() - sig.at > 15000) return;
  const store = workspaceStores().find(s => isInside(sig.project, s.projectDir) || isInside(s.projectDir, sig.project));
  if (!store) return;
  currentKey = store.key;
  lastStamp = '';
  openPanel();
  refresh(true);
}

// ---------------------------------------------------------------------------

function activate(context) {
  ctx = context;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'claudeHistory.open';
  context.subscriptions.push(
    statusItem,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider()),
    vscode.commands.registerCommand('claudeHistory.open', () => openPanel()),
    vscode.commands.registerCommand('claudeHistory.openInEditor', () => openPanel(null, 'editor')),
    vscode.commands.registerCommand('claudeHistory.undo', () => runOp('undo')),
    vscode.commands.registerCommand('claudeHistory.redo', () => runOp('redo')),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { currentKey = null; lastStamp = ''; storesCache.at = 0; refresh(true); })
  );
  lastSignal = stamp(path.join(core.HOME, 'signals', 'open.json'));
  const timer = setInterval(() => {
    try { refresh(false); checkOpenSignal(); } catch (e) { console.error('[claude-history]', e); }
  }, POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  refresh(true);
}

function deactivate() {}

module.exports = { activate, deactivate };
