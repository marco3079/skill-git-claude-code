'use strict';
/**
 * Motor do histórico de requisições do Claude Code.
 *
 * Cada projeto ganha um repositório git "sombra" em ~/.claude/request-history/projects/<chave>/repo
 * cujo work-tree é a pasta do projeto. O .git do usuário nunca é tocado.
 *
 * Linha do tempo (sempre linear, como `git log --first-parent`):
 *   init     -> estado inicial do projeto
 *   manual   -> alterações feitas fora do Claude entre uma requisição e outra
 *   request  -> uma mensagem do usuário + tudo que o Claude alterou até parar (Stop)
 *   undo     -> commit que desfaz uma requisição (como `git revert`)
 *   redo     -> commit que reaplica uma requisição desfeita
 *
 * Este arquivo é compartilhado pelo plugin (hooks/CLI) e pela extensão do VS Code.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = process.env.CLAUDE_RH_HOME || path.join(os.homedir(), '.claude', 'request-history');
const INDEX_VERSION = 1;
const AMEND_WINDOW_MS = 30 * 60 * 1000;
const MAX_FILES_LISTED = 2000;
const MAX_PROJECT_FILES = Number(process.env.CLAUDE_RH_MAX_FILES || 60000);
const MAX_TEXT = 8000;
const IS_WIN = process.platform === 'win32';

const DEFAULT_EXCLUDES = [
  '# Padrões extras ignorados pelo histórico (além do .gitignore do projeto)',
  'node_modules/', 'bower_components/', 'vendor/bundle/', '.venv/', 'venv/', '__pycache__/', '*.pyc',
  '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.parcel-cache/', '.cache/', '.gradle/', '.dart_tool/',
  'target/', 'obj/', '.vs/', '*.log', '*.tmp', '*.swp', 'Thumbs.db', '.DS_Store',
  '.claude/request-history/', '.claude/worktrees/', '.git/',
];

// ---------------------------------------------------------------------------
// utilidades

function normalizeDir(p) {
  let r = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (IS_WIN) r = r.toLowerCase();
  return r;
}

function projectKey(dir) {
  const base = path.basename(path.resolve(dir)).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root';
  const hash = crypto.createHash('sha1').update(normalizeDir(dir)).digest('hex').slice(0, 10);
  return `${base}-${hash}`;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function nowIso() { return new Date().toISOString(); }

function hashText(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12); }

function clip(s, n = MAX_TEXT) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function firstLine(s, n = 90) {
  const line = String(s || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

function samePath(a, b) {
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // no Windows o rename falha se outro processo estiver lendo o arquivo naquele instante
      if (i >= 20) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
      sleepSync(25);
    }
  }
}

function readJson(file, fallback) {
  for (let i = 0; i < 5; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      sleepSync(20);
    }
  }
  return fallback;
}

function logError(err, where) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const line = `[${nowIso()}] ${where}: ${err && err.stack ? err.stack : err}\n`;
    fs.appendFileSync(path.join(HOME, 'errors.log'), line);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// plano do Claude (TodoWrite / TaskCreate / TaskUpdate / ExitPlanMode)

const PLAN_TOOLS = /^(TodoWrite|TaskCreate|TaskUpdate|ExitPlanMode)$/;
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

function normStatus(s) {
  s = String(s || '').toLowerCase();
  if (s === 'completed' || s === 'done') return 'completed';
  if (s === 'in_progress' || s === 'in-progress' || s === 'active') return 'in_progress';
  if (s === 'deleted' || s === 'cancelled' || s === 'canceled') return 'deleted';
  return 'pending';
}

function extractTaskId(resp, fallback) {
  if (resp && typeof resp === 'object') {
    const cand = resp.task && resp.task.id || resp.taskId || resp.id;
    if (cand != null) return String(cand);
    resp = JSON.stringify(resp);
  }
  const m = /#?(\d+)/.exec(String(resp || ''));
  return m ? m[1] : fallback;
}

function applyPlanTool(req, toolName, input, response) {
  input = input || {};
  const plan = req.plan || { items: [], text: null };
  plan.items = plan.items || [];
  if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    plan.items = input.todos.map((t, i) => ({
      id: String(t.id || i + 1),
      text: clip(t.content || t.activeForm || '', 400),
      status: normStatus(t.status),
    }));
  } else if (toolName === 'ExitPlanMode' && input.plan) {
    plan.text = clip(input.plan, 20000);
  } else if (toolName === 'TaskCreate') {
    const id = extractTaskId(response, String(plan.items.length + 1));
    plan.items.push({ id, text: clip(input.subject || input.description || input.content || '', 400), status: 'pending' });
  } else if (toolName === 'TaskUpdate') {
    const id = String(input.taskId || input.task_id || input.id || '');
    const item = plan.items.find(it => it.id === id);
    if (item) {
      if (input.status) item.status = normStatus(input.status);
      if (input.subject) item.text = clip(input.subject, 400);
    } else if (input.subject) {
      plan.items.push({ id, text: clip(input.subject, 400), status: normStatus(input.status) });
    }
  } else {
    return false;
  }
  plan.items = plan.items.filter(it => it.status !== 'deleted');
  req.plan = plan;
  req.planRevisions = (req.planRevisions || 0) + 1;
  return true;
}

/**
 * Sem ferramentas de tarefas, o Claude escreve o plano em texto (a sessão é orientada a abrir
 * com um bloco "Plano:"). Extrai os tópicos desse bloco.
 */
function parsePlanText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*(#{1,4}\s*)?(\*\*)?\s*plano\s*(\*\*)?\s*:?\s*(\*\*)?\s*$/i.test(l));
  if (start < 0) return null;
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(?:\[( |x|X|~)\]\s*)?(.+)$/.exec(lines[i]);
    if (m) {
      items.push({ id: String(items.length + 1), text: clip(m[2].trim(), 400), status: m[1] && /x/i.test(m[1]) ? 'completed' : 'pending' });
    } else if (lines[i].trim() && items.length) break;
  }
  return items.length ? items : null;
}

/** Mensagens que não foram digitadas pelo usuário (avisos de tarefas em segundo plano etc.). */
function isSystemPrompt(prompt) {
  return /^\s*<(task-notification|side-sessions-event|ci-monitor-event|system-reminder|scheduled-task|teammate-message|channel-message|local-command-[\w-]+|command-[\w-]+)[\s>]/i.test(String(prompt || ''));
}

// ---------------------------------------------------------------------------
// transcrição: primeira e última fala do Claude desde a mensagem do usuário

function isHumanPrompt(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain || o.toolUseResult) return false;
  if (o.origin && o.origin.kind) return o.origin.kind === 'human';
  const c = o.message && o.message.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some(b => b.type === 'text') && !c.some(b => b.type === 'tool_result');
}

function readTurnTexts(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};
  const size = fs.statSync(transcriptPath).size;
  const len = Math.min(size, 4 * 1024 * 1024);
  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (len < size) lines.shift();
  const texts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (o.isSidechain) continue;
    if (isHumanPrompt(o)) break;
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      const t = o.message.content.filter(b => b.type === 'text' && b.text && b.text.trim()).map(b => b.text.trim()).join('\n\n');
      if (t) texts.unshift(t);
    }
  }
  return { first: texts[0], last: texts[texts.length - 1] };
}

// ---------------------------------------------------------------------------
// Store: um projeto

class Store {
  constructor(projectDir) {
    this.projectDir = path.resolve(projectDir);
    this.key = projectKey(this.projectDir);
    this.dir = path.join(HOME, 'projects', this.key);
    this.gitDir = path.join(this.dir, 'repo');
    this.indexFile = path.join(this.dir, 'index.json');
    this.lockDir = path.join(this.dir, 'lock');
  }

  exists() { return fs.existsSync(this.indexFile); }

  // ----- git -------------------------------------------------------------

  gitEnv() {
    const env = Object.assign({}, process.env, {
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.projectDir,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'Claude Request History',
      GIT_AUTHOR_EMAIL: 'request-history@localhost',
      GIT_COMMITTER_NAME: 'Claude Request History',
      GIT_COMMITTER_EMAIL: 'request-history@localhost',
    });
    for (const k of ['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES']) delete env[k];
    return env;
  }

  git(args, opts = {}) {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: this.projectDir,
      env: this.gitEnv(),
      input: opts.input,
      encoding: opts.buffer ? 'buffer' : 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.error) throw r.error;
    if (r.status !== 0 && !opts.allowFail) {
      const err = String(r.stderr || '').trim();
      throw new Error(`git ${args[0]} falhou (${r.status}): ${err}`);
    }
    return opts.full ? r : r.stdout;
  }

  clearStaleGitLock() {
    const lock = path.join(this.gitDir, 'index.lock');
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > 60 * 1000) fs.unlinkSync(lock);
    } catch (_) {}
  }

  snapshot() {
    this.clearStaleGitLock();
    for (let i = 0; i < 4; i++) {
      // --ignore-errors: arquivos travados (comum no Windows) não derrubam o checkpoint
      const r = this.git(['add', '-A', '--ignore-errors'], { allowFail: true, full: true });
      if (r.status === 0 && !String(r.stderr).trim()) break;
      if (!this.fixNestedRepos()) break;
    }
    return this.git(['write-tree']).trim();
  }

  /**
   * Pastas com .git próprio (submódulo, repositório aninhado) viram "gitlink" e o conteúdo não seria
   * guardado; se o repositório aninhado ainda não tem commit, o `git add` inteiro falha. Semeia o índice
   * com um arquivo de dentro dela: com isso o git passa a descer na pasta normalmente.
   */
  fixNestedRepos() {
    const staged = this.git(['ls-files', '-s', '-z'], { allowFail: true }).split('\0');
    const links = staged.filter(l => l.startsWith('160000 ')).map(l => l.slice(l.indexOf('\t') + 1));
    const untracked = this.git(['ls-files', '-o', '--exclude-standard', '-z'], { allowFail: true }).split('\0')
      .filter(p => p.endsWith('/') && fs.existsSync(path.join(this.projectDir, p, '.git')))
      .map(p => p.slice(0, -1));
    let fixed = 0;
    for (const rel of new Set([...links, ...untracked])) {
      const seed = this.seedFile(rel);
      if (!seed) continue;
      if (links.includes(rel)) this.git(['update-index', '--force-remove', '--', rel], { allowFail: true });
      if (this.git(['update-index', '--add', '--', seed], { allowFail: true, full: true }).status === 0) fixed++;
    }
    return fixed;
  }

  seedFile(relDir) {
    const abs = path.join(this.projectDir, relDir);
    if (fs.existsSync(path.join(abs, '.gitignore'))) return `${relDir}/.gitignore`;
    const queue = [''];
    for (let n = 0; queue.length && n < 200; n++) {
      const sub = queue.shift();
      let ents;
      try { ents = fs.readdirSync(path.join(abs, sub), { withFileTypes: true }); } catch (_) { continue; }
      const file = ents.find(d => d.isFile());
      if (file) return `${relDir}/${sub ? sub + '/' : ''}${file.name}`;
      for (const d of ents) if (d.isDirectory() && d.name !== '.git') queue.push(`${sub ? sub + '/' : ''}${d.name}`);
    }
    return null;
  }

  // Cada processo git custa ~0,25 s no Windows: as árvores dos commits ficam guardadas no índice
  // (idx.headTree, entry.tree) para não perguntar ao git de novo.
  treeOf(commit, idx) {
    if (idx) {
      if (idx.head === commit && idx.headTree) return idx.headTree;
      const e = idx.entries.find(x => x.commit === commit && x.tree);
      if (e) return e.tree;
    }
    return this.git(['rev-parse', `${commit}^{tree}`]).trim();
  }

  setHead(idx, commit, tree) {
    idx.head = commit;
    idx.headTree = tree || this.treeOf(commit);
  }

  commitTree(tree, parents, message) {
    const args = ['commit-tree', tree];
    for (const p of parents) if (p) args.push('-p', p);
    return this.git(args, { input: message }).trim();
  }

  /** Atualiza várias refs num processo só: {ref: sha | null (apaga)} */
  updateRefs(map) {
    const lines = Object.entries(map).map(([ref, sha]) => (sha ? `update ${ref} ${sha}` : `delete ${ref}`));
    if (lines.length) this.git(['update-ref', '--stdin'], { input: lines.join('\n') + '\n', allowFail: true });
  }

  updateRef(ref, sha) { this.updateRefs({ [ref]: sha }); }

  /** Arquivos alterados entre dois commits/árvores: [{p, s, a, d, bin}] */
  diffFiles(a, b) {
    const out = this.git(['diff-tree', '-r', '-z', '--no-renames', '--raw', '--numstat', a, b]).split('\0');
    const files = new Map();
    const stats = new Map();
    for (let i = 0; i < out.length; i++) {
      const tok = out[i];
      if (tok.startsWith(':')) {
        let s = tok.trim().slice(-1);
        if (s === 'T') s = 'M';
        const p = out[++i];
        files.set(p, { p, s, a: 0, d: 0, bin: false });
        continue;
      }
      const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tok);
      if (m) stats.set(m[3], m);
    }
    for (const [p, m] of stats) {
      const f = files.get(p);
      if (!f) continue;
      if (m[1] === '-') f.bin = true; else { f.a = Number(m[1]); f.d = Number(m[2]); }
    }
    return [...files.values()].sort((x, y) => x.p.localeCompare(y.p));
  }

  fileAt(commit, relPath) {
    const r = this.git(['cat-file', 'blob', `${commit}:${relPath}`], { buffer: true, allowFail: true, full: true });
    return r.status === 0 ? r.stdout : null;
  }

  patch(from, to) {
    return this.git(['diff-tree', '-p', '--no-renames', '--no-color', '--no-ext-diff', from, to]);
  }

  // ----- índice + trava ---------------------------------------------------

  load() { return readJson(this.indexFile, null); }

  save(idx) {
    idx.updatedAt = nowIso();
    writeFileAtomic(this.indexFile, JSON.stringify(idx, null, 1));
  }

  lockIsStale() {
    try {
      const st = fs.statSync(this.lockDir);
      const pid = Number(fs.readFileSync(path.join(this.lockDir, 'pid'), 'utf8'));
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return true; }
      }
      return Date.now() - st.mtimeMs > 10 * 60 * 1000;
    } catch (e) {
      // trava sem pid: só é velha se tiver mais de alguns segundos (pode estar sendo criada agora)
      try { return Date.now() - fs.statSync(this.lockDir).mtimeMs > 5000; } catch (_) { return false; }
    }
  }

  withLock(fn, waitMs = 45000) {
    fs.mkdirSync(this.dir, { recursive: true });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        fs.writeFileSync(path.join(this.lockDir, 'pid'), String(process.pid));
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (this.lockIsStale()) { fs.rmSync(this.lockDir, { recursive: true, force: true }); continue; }
        if (Date.now() > deadline) throw new Error('Histórico ocupado por outro processo (trava não liberada).');
        sleepSync(60);
      }
    }
    try { return fn(); } finally { try { fs.rmSync(this.lockDir, { recursive: true, force: true }); } catch (_) {} }
  }

  // ----- inicialização ----------------------------------------------------

  disabledReason() {
    const n = normalizeDir(this.projectDir);
    if (n === normalizeDir(os.homedir())) return 'A pasta do projeto é a pasta do usuário; histórico desativado.';
    if (/^([a-z]:)?$/i.test(n) || n === '/') return 'A pasta do projeto é a raiz do disco; histórico desativado.';
    if (!fs.existsSync(this.projectDir)) return 'Pasta do projeto não encontrada.';
    return null;
  }

  ensureInit() {
    if (this.exists()) return this.load();
    const disabled = this.disabledReason();
    if (disabled) return null;
    return this.withLock(() => {
      if (this.exists()) return this.load();
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
        this.git(['init', '-q']);
        const cfg = [['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.longpaths', 'true'],
          ['core.fsmonitor', 'false'], ['core.untrackedCache', 'true'], ['core.quotepath', 'false'],
          ['advice.addEmbeddedRepo', 'false'], ['gc.auto', '2000'], ['commit.gpgsign', 'false']];
        for (const [k, v] of cfg) this.git(['config', k, v]);
        this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
        const info = path.join(this.gitDir, 'info');
        fs.mkdirSync(info, { recursive: true });
        fs.writeFileSync(path.join(info, 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n');
        // snapshots byte a byte: sem conversão de fim de linha nem filtros (LFS etc.)
        fs.writeFileSync(path.join(info, 'attributes'), '* -text -eol -ident -filter -working-tree-encoding\n');
      }
      const idx = {
        version: INDEX_VERSION, project: this.projectDir, key: this.key,
        createdAt: nowIso(), head: null, seq: 0, entries: [], sessions: {}, disabled: null,
      };
      const candidates = this.git(['ls-files', '-o', '--exclude-standard', '-z'], { allowFail: true }) || '';
      const count = candidates ? candidates.split('\0').length - 1 : 0;
      if (count > MAX_PROJECT_FILES) {
        idx.disabled = `Projeto com ${count} arquivos fora do .gitignore (limite ${MAX_PROJECT_FILES}). Ajuste o .gitignore ou defina CLAUDE_RH_MAX_FILES.`;
        this.save(idx);
        return idx;
      }
      const tree = this.snapshot();
      const commit = this.commitTree(tree, [], 'Estado inicial do projeto\n');
      this.updateRef('refs/heads/main', commit);
      this.setHead(idx, commit, tree);
      const tracked = this.git(['ls-files', '-z']).split('\0').length - 1;
      idx.entries.push({ kind: 'init', id: newId('i'), at: nowIso(), commit, tree, fileCount: tracked });
      this.save(idx);
      return idx;
    }, 110000); // a primeira fotografia de um projeto grande pode demorar (OneDrive baixa arquivos sob demanda)
  }

  // ----- regras de negócio --------------------------------------------------

  entryById(idx, id) { return idx.entries.find(e => e.id === id); }

  isRunning(r) {
    return r.kind === 'request' && r.status === 'open' &&
      Date.now() - Date.parse(r.lastActivityAt || r.startedAt) < AMEND_WINDOW_MS;
  }

  relPath(abs) {
    if (!abs) return null;
    const rel = path.relative(this.projectDir, path.resolve(this.projectDir, abs)).replace(/\\/g, '/');
    if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null;
    return rel;
  }

  /** Grava como "manual" o que mudou fora do Claude desde o último commit. */
  checkpointManual(idx, note) {
    if (!idx.head) return null;
    const tree = this.snapshot();
    const parentTree = this.treeOf(idx.head, idx);
    if (tree === parentTree) return null;
    const parent = idx.head;
    const msg = `Alterações fora do Claude${note ? ` (${note})` : ''}\n`;
    const commit = this.commitTree(tree, [parent], msg);
    this.updateRef('refs/heads/main', commit);
    this.setHead(idx, commit, tree);
    const files = this.diffFiles(parentTree, tree);
    const e = { kind: 'manual', id: newId('m'), at: nowIso(), parent, commit, tree, note: note || null };
    setFiles(e, files);
    idx.entries.push(e);
    return e;
  }

  commitMessage(r) {
    const lines = [`#${r.seq} ${r.title || 'Requisição'}`, ''];
    r.prompts.forEach((p, i) => {
      lines.push(i === 0 ? 'Pedido:' : `Alteração no meio do caminho (${i}):`);
      lines.push(p.text, '');
    });
    if (r.plan && r.plan.items && r.plan.items.length) {
      lines.push('Plano:');
      for (const it of r.plan.items) lines.push(`- [${it.status === 'completed' ? 'x' : it.status === 'in_progress' ? '~' : ' '}] ${it.text}`);
      lines.push('');
    }
    if (r.plan && r.plan.text) lines.push('Plano (plan mode):', r.plan.text, '');
    lines.push(`Session: ${r.sessionId}`, `Request: ${r.id}`);
    return lines.join('\n') + '\n';
  }

  commitRequest(idx, r, parent, parentTree, tree) {
    const msg = this.commitMessage(r);
    r.parent = parent;
    r.commit = this.commitTree(tree, [parent], msg);
    r.tree = tree;
    r.msgHash = hashText(msg);
    this.setHead(idx, r.commit, tree);
    setFiles(r, this.diffFiles(parentTree, tree), r.toolFiles);
  }

  /** Fecha o checkpoint da requisição com o estado atual do disco. */
  finalizeRequest(idx, r, { rewrite = false } = {}) {
    const tree = this.snapshot();
    const before = { head: idx.head, commit: r.commit };
    if (r.commit && r.commit === idx.head) {
      // a mesma requisição continuou (ex.: outro hook de Stop pediu para seguir): substitui o commit
      const parentTree = this.treeOf(r.parent, idx);
      if (tree === parentTree) {
        this.setHead(idx, r.parent, parentTree);
        r.commit = null; r.tree = null; setFiles(r, []);
      } else if (tree !== r.tree || (rewrite && hashText(this.commitMessage(r)) !== r.msgHash)) {
        this.commitRequest(idx, r, r.parent, parentTree, tree);
      }
    } else {
      const headTree = this.treeOf(idx.head, idx);
      if (tree !== headTree) this.commitRequest(idx, r, idx.head, headTree, tree);
    }
    if (idx.head !== before.head || r.commit !== before.commit) {
      this.updateRefs({ 'refs/heads/main': idx.head, [`refs/requests/${r.seq}`]: r.commit });
    }
    if (r.commit) {
      // nova alteração depois de um "desfazer": as desfeitas não podem mais ser refeitas
      for (const e of idx.entries) {
        if (e.kind === 'request' && e.status === 'undone' && e !== r) { e.status = 'discarded'; e.discardedAt = nowIso(); }
      }
    }
  }

  targets(idx) { return computeTargets(idx); }

  // ----- hooks ---------------------------------------------------------------

  onPrompt({ sessionId, prompt }) {
    let idx = this.ensureInit();
    if (!idx || idx.disabled) return { notices: [] };
    return this.withLock(() => {
      idx = this.load();
      const sess = idx.sessions[sessionId] || (idx.sessions[sessionId] = { seenOps: countOps(idx) });
      const notices = opsSince(idx, sess.seenOps);
      sess.seenOps = countOps(idx);
      const text = clip(prompt);
      const cur = sess.current && this.entryById(idx, sess.current);

      if (isSystemPrompt(prompt)) {
        // aviso automático (tarefa em segundo plano etc.): o que o Claude fizer entra na requisição atual
        if (cur && cur.status === 'open') cur.lastActivityAt = nowIso();
        this.save(idx);
        return { notices, request: cur || null, system: true };
      }

      if (cur && cur.status === 'open' && !cur.stoppedAt && this.isRunning(cur)) {
        // o usuário mandou outra mensagem antes do Claude terminar: é a mesma requisição, alterada
        cur.prompts.push({ text, at: nowIso() });
        cur.amended = true;
        cur.lastActivityAt = nowIso();
        this.save(idx);
        return { notices, request: cur, amended: true };
      }
      // requisições abertas que ninguém fechou (interrompidas com Esc há muito tempo, sessão encerrada):
      // fecha com o que estiver no disco
      for (const e of idx.entries) {
        if (e.kind !== 'request' || e.status !== 'open') continue;
        if (e === cur || !this.isRunning(e)) {
          this.finalizeRequest(idx, e);
          e.status = 'done'; e.endedAt = nowIso(); e.interrupted = true;
        }
      }
      const othersRunning = idx.entries.some(e => e.sessionId !== sessionId && this.isRunning(e));
      if (!othersRunning) this.checkpointManual(idx);

      idx.seq += 1;
      const r = {
        kind: 'request', id: newId('r'), seq: idx.seq, sessionId, status: 'open',
        title: firstLine(prompt) || '(mensagem vazia)', prompts: [{ text, at: nowIso() }],
        startedAt: nowIso(), lastActivityAt: nowIso(), endedAt: null, stoppedAt: null,
        parent: idx.head, commit: null, files: [], fileCount: 0, add: 0, del: 0,
        plan: null, planRevisions: 0, toolFiles: [], intro: null, summary: null, amended: false,
      };
      idx.entries.push(r);
      sess.current = r.id;
      this.save(idx);
      return { notices, request: r, amended: false };
    });
  }

  onToolUse({ sessionId, toolName, toolInput, toolResponse }) {
    if (!this.exists()) return;
    this.withLock(() => {
      const idx = this.load();
      const sess = idx && idx.sessions[sessionId];
      const r = sess && sess.current && this.entryById(idx, sess.current);
      if (!r || r.status !== 'open') return;
      let changed = false;
      if (PLAN_TOOLS.test(toolName)) changed = applyPlanTool(r, toolName, toolInput, toolResponse);
      if (FILE_TOOLS.test(toolName)) {
        const rel = this.relPath(toolInput && (toolInput.file_path || toolInput.notebook_path));
        if (rel && !r.toolFiles.some(f => samePath(f, rel))) { r.toolFiles.push(rel); changed = true; }
      }
      r.lastActivityAt = nowIso();
      if (changed || Math.random() < 0.2) this.save(idx);
    });
  }

  onStop({ sessionId, transcriptPath, lastMessage }) {
    if (!this.exists()) return null;
    return this.withLock(() => {
      const idx = this.load();
      if (!idx || idx.disabled) return null;
      const sess = idx.sessions[sessionId] || (idx.sessions[sessionId] = { seenOps: countOps(idx) });
      let r = sess.current && this.entryById(idx, sess.current);
      const isLast = r && idx.entries[idx.entries.length - 1] === r;
      if (!r || !(r.status === 'open' || (r.status === 'done' && isLast))) {
        // o Claude trabalhou sem uma nova mensagem do usuário (ex.: tarefa em segundo plano)
        if (this.snapshot() === this.treeOf(idx.head, idx)) return null;
        idx.seq += 1;
        r = {
          kind: 'request', id: newId('r'), seq: idx.seq, sessionId, status: 'open', auto: true,
          title: 'Continuação do Claude (sem nova mensagem)', prompts: [], startedAt: nowIso(),
          lastActivityAt: nowIso(), parent: idx.head, commit: null, files: [], fileCount: 0, add: 0, del: 0,
          plan: null, planRevisions: 0, toolFiles: [], amended: false,
        };
        idx.entries.push(r);
        sess.current = r.id;
      }
      let texts = {};
      try { texts = readTurnTexts(transcriptPath); } catch (e) { logError(e, 'transcript'); }
      if (texts.first && !r.intro) r.intro = clip(texts.first, 1500);
      const summary = lastMessage || texts.last;
      if (summary) r.summary = clip(summary, 4000);
      if (!r.plan || !((r.plan.items && r.plan.items.length) || r.plan.text)) {
        const items = parsePlanText(texts.first) || parsePlanText(texts.last);
        if (items) { r.plan = { items, text: null, fromText: true }; r.planRevisions = 1; }
      }
      this.finalizeRequest(idx, r, { rewrite: true });
      r.status = 'done';
      r.stoppedAt = r.endedAt = nowIso();
      this.save(idx);
      return r;
    });
  }

  onSessionEnd({ sessionId }) {
    if (!this.exists()) return;
    this.withLock(() => {
      const idx = this.load();
      const sess = idx && idx.sessions[sessionId];
      const r = sess && sess.current && this.entryById(idx, sess.current);
      if (!r || r.status !== 'open') return;
      this.finalizeRequest(idx, r);
      r.status = 'done'; r.endedAt = nowIso(); r.interrupted = !r.stoppedAt;
      this.save(idx);
    });
  }

  // ----- desfazer / refazer ------------------------------------------------

  /** Traz `checkout` do estado de `commit` para o disco e apaga `remove` (que não existem em `commit`). */
  restoreFiles(commit, checkout, remove) {
    if (checkout.length) {
      this.git(['--literal-pathspecs', 'checkout', commit, '--pathspec-from-file=-', '--pathspec-file-nul'],
        { input: checkout.join('\0') });
    }
    for (const rel of remove) {
      const abs = path.resolve(this.projectDir, rel);
      if (!this.relPath(abs)) continue;
      fs.rmSync(abs, { force: true });
      let dir = path.dirname(abs);
      while (this.relPath(dir)) {
        try { fs.rmdirSync(dir); } catch (_) { break; }
        dir = path.dirname(dir);
      }
    }
  }

  /**
   * op = 'undo' | 'redo'. Só atua na requisição mais recente (pilha).
   * Retorna {ok, seq, files} ou {ok:false, reason, conflicts?}
   */
  applyOp(op, { force = false, by = 'cli', sessionId = null } = {}) {
    if (!this.exists()) return { ok: false, reason: 'no-history', message: 'Ainda não há histórico para este projeto.' };
    return this.withLock(() => {
      const idx = this.load();
      // a própria requisição que pediu o desfazer (via Claude) não conta como "em andamento"
      const running = idx.entries.filter(e => this.isRunning(e) && !(sessionId && e.sessionId === sessionId));
      if (running.length) {
        return { ok: false, reason: 'running', message: `O Claude ainda está trabalhando na requisição #${running[0].seq}. Aguarde ele terminar.` };
      }
      const t = computeTargets(idx);
      const r = op === 'undo' ? t.undo : t.redo;
      if (!r) {
        return { ok: false, reason: 'nothing', message: op === 'undo' ? 'Nada para desfazer.' : 'Nada para refazer.' };
      }
      this.checkpointManual(idx, op === 'undo' ? `antes de desfazer #${r.seq}` : `antes de refazer #${r.seq}`);
      const changes = r.filesTruncated ? this.diffFiles(r.parent, r.commit) : r.files;
      const files = changes.map(f => f.p);
      // estado esperado no disco: desfazer espera o resultado da requisição; refazer espera o estado anterior
      const expected = op === 'undo' ? r.commit : r.parent;
      const target = op === 'undo' ? r.parent : r.commit;
      const changed = new Set(this.diffFiles(this.treeOf(expected, idx), idx.headTree || idx.head).map(f => f.p));
      const conflicts = files.filter(p => changed.has(p));
      if (conflicts.length && !force) {
        this.save(idx);
        return {
          ok: false, reason: 'conflict', seq: r.seq, conflicts,
          message: `Arquivos da requisição #${r.seq} foram modificados depois dela: ${conflicts.join(', ')}`,
        };
      }
      // A = criado pela requisição, D = apagado por ela
      const absentIn = op === 'undo' ? 'A' : 'D';
      this.restoreFiles(target,
        changes.filter(f => f.s !== absentIn).map(f => f.p),
        changes.filter(f => f.s === absentIn).map(f => f.p));
      const tree = this.snapshot();
      const parent = idx.head;
      const parentTree = this.treeOf(parent, idx);
      const verb = op === 'undo' ? 'Desfaz' : 'Refaz';
      const commit = this.commitTree(tree, [parent], `${verb} #${r.seq} ${r.title}\n\nRequest: ${r.id}\n`);
      this.updateRef('refs/heads/main', commit);
      this.setHead(idx, commit, tree);
      const e = { kind: op, id: newId(op[0]), at: nowIso(), target: r.id, seq: r.seq, parent, commit, tree, forced: conflicts.length > 0, conflicts, by };
      setFiles(e, this.diffFiles(parentTree, tree));
      idx.entries.push(e);
      r.status = op === 'undo' ? 'undone' : 'done';
      r[op === 'undo' ? 'undoneAt' : 'redoneAt'] = nowIso();
      // quem pediu já sabe o que aconteceu: não precisa ser avisado na próxima mensagem
      if (sessionId && idx.sessions[sessionId]) idx.sessions[sessionId].seenOps = countOps(idx);
      this.save(idx);
      return { ok: true, seq: r.seq, title: r.title, files, forced: e.forced };
    });
  }

  undo(opts) { return this.applyOp('undo', opts); }
  redo(opts) { return this.applyOp('redo', opts); }
}

// ---------------------------------------------------------------------------

function setFiles(e, files, toolFiles) {
  const tool = (toolFiles || []).map(f => IS_WIN ? f.toLowerCase() : f);
  e.fileCount = files.length;
  e.add = files.reduce((s, f) => s + f.a, 0);
  e.del = files.reduce((s, f) => s + f.d, 0);
  e.files = files.slice(0, MAX_FILES_LISTED).map(f => {
    if (toolFiles) f.via = tool.includes(IS_WIN ? f.p.toLowerCase() : f.p) ? 'tool' : 'other';
    return f;
  });
  e.filesTruncated = files.length > MAX_FILES_LISTED;
}

function countOps(idx) {
  return idx.entries.filter(e => e.kind === 'undo' || e.kind === 'redo').length;
}

function opsSince(idx, seen) {
  const ops = idx.entries.filter(e => e.kind === 'undo' || e.kind === 'redo').slice(seen || 0);
  return ops.map(e => {
    const files = (e.files || []).map(f => f.p);
    const list = files.slice(0, 15).join(', ') + (files.length > 15 ? ` (+${files.length - 15})` : '');
    return e.kind === 'undo'
      ? `O usuário DESFEZ a requisição #${e.seq}; estes arquivos voltaram ao estado anterior a ela: ${list}. Releia-os antes de editar.`
      : `O usuário REFEZ a requisição #${e.seq}; estes arquivos voltaram a ter as alterações dela: ${list}.`;
  });
}

/** Próximo alvo de desfazer (mais recente aplicada) e de refazer (última desfeita). */
function computeTargets(idx) {
  const reqs = (idx && idx.entries || []).filter(e => e.kind === 'request' && e.commit);
  let undo = null;
  let redo = null;
  for (let i = reqs.length - 1; i >= 0; i--) {
    const r = reqs[i];
    if (r.status === 'done') { undo = r; break; }
  }
  for (const r of reqs) {
    if (r.status === 'undone' && (!undo || r.seq > undo.seq)) { redo = r; break; }
  }
  return { undo, redo };
}

/** Localiza o projeto: --project, CLAUDE_PROJECT_DIR ou a pasta (ou ancestral) com histórico. */
function findStore(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const s = new Store(dir);
    if (s.exists()) return s;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function listProjects() {
  const root = path.join(HOME, 'projects');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const key of fs.readdirSync(root)) {
    const idx = readJson(path.join(root, key, 'index.json'), null);
    if (idx && idx.project) out.push({ key, project: idx.project, updatedAt: idx.updatedAt, count: idx.seq || 0 });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function requestOpen(projectDir) {
  fs.mkdirSync(path.join(HOME, 'signals'), { recursive: true });
  writeFileAtomic(path.join(HOME, 'signals', 'open.json'), JSON.stringify({ project: path.resolve(projectDir), at: Date.now() }));
}

module.exports = {
  HOME, Store, findStore, listProjects, computeTargets, normalizeDir, projectKey,
  requestOpen, logError, firstLine, readTurnTexts, applyPlanTool, parsePlanText, isSystemPrompt,
};
