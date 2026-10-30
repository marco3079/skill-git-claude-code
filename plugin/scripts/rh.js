#!/usr/bin/env node
'use strict';
/**
 * Entrada única do plugin "historico".
 *
 *   node rh.js hook <SessionStart|UserPromptSubmit|PostToolUse|Stop|SessionEnd>   (lê o JSON do hook no stdin)
 *   node rh.js listar [-n 20] [--json]
 *   node rh.js mostrar <N> [--patch]
 *   node rh.js desfazer [--forcar] [--session ID]
 *   node rh.js refazer  [--forcar] [--session ID]
 *   node rh.js abrir
 *
 * Opções comuns: --project <pasta> (padrão: CLAUDE_PROJECT_DIR ou a pasta atual).
 */
const fs = require('fs');
const { spawn } = require('child_process');
const core = require('./core');

const CLI = __filename;
const ALIASES = { list: 'listar', show: 'mostrar', undo: 'desfazer', redo: 'refazer', open: 'abrir', historico: 'abrir' };
const COMMAND_RE = /^\s*\/(?:historico:(abrir|desfazer|refazer|listar)|(historico))(?:\s+([^\n]*))?\s*$/i;
const SKILL_MARKER = 'historico-cmd';

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--forcar' || a === '--force' || a === '-f') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--patch') out.patch = true;
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '-n') out.n = Number(argv[++i]);
    else out._.push(a);
  }
  return out;
}

function resolveStore(args) {
  const dir = args.project || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const exact = new core.Store(dir);
  return exact.exists() ? exact : (core.findStore(dir) || exact);
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}

const STATUS_LABEL = { open: 'em andamento', done: '', undone: 'DESFEITA', discarded: 'descartada' };

function formatList(store, idx, n = 20) {
  if (!idx) return 'Ainda não há histórico para este projeto.';
  if (idx.disabled) return `Histórico desativado: ${idx.disabled}`;
  const t = core.computeTargets(idx);
  const rows = [];
  const entries = idx.entries.filter(e => e.kind !== 'request' || e.commit || e.status === 'open').slice(-n).reverse();
  for (const e of entries) {
    const sha = e.commit ? e.commit.slice(0, 7) : '-------';
    const stats = e.fileCount ? `  ${e.fileCount} arq +${e.add} -${e.del}` : '';
    if (e.kind === 'request') {
      const flags = [STATUS_LABEL[e.status], e.amended ? 'alterada no meio' : '',
        t.undo === e ? '<- desfazer disponível' : '', t.redo === e ? '<- refazer disponível' : ''].filter(Boolean).join(', ');
      rows.push(`* ${sha}  #${e.seq} ${e.title}${stats}  (${ago(e.startedAt)})${flags ? '  [' + flags + ']' : ''}`);
    } else if (e.kind === 'undo' || e.kind === 'redo') {
      rows.push(`* ${sha}  ${e.kind === 'undo' ? '↶ desfez' : '↷ refez'} #${e.seq}${stats}  (${ago(e.at)})`);
    } else if (e.kind === 'manual') {
      rows.push(`o ${sha}  alterações fora do Claude${stats}  (${ago(e.at)})`);
    } else {
      rows.push(`o ${sha}  estado inicial do projeto  (${ago(e.at)})`);
    }
  }
  return [`Histórico de requisições — ${idx.project}`, ...rows].join('\n');
}

function formatShow(store, idx, seq, withPatch) {
  const r = idx && idx.entries.find(e => e.kind === 'request' && e.seq === seq);
  if (!r) return `Requisição #${seq} não encontrada.`;
  const out = [`#${r.seq} ${r.title}`, `status: ${r.status}${r.amended ? ' (alterada no meio do caminho)' : ''}`,
    `commit: ${r.commit || '(sem alterações)'}`, `início: ${r.startedAt}`, ''];
  r.prompts.forEach((p, i) => out.push(i === 0 ? 'Pedido:' : `Alteração ${i}:`, p.text, ''));
  if (r.plan && r.plan.items && r.plan.items.length) {
    out.push('Plano:');
    for (const it of r.plan.items) out.push(`  [${it.status === 'completed' ? 'x' : it.status === 'in_progress' ? '~' : ' '}] ${it.text}`);
    out.push('');
  }
  if (r.files.length) {
    out.push('Arquivos:');
    for (const f of r.files) out.push(`  ${f.s} ${f.p}${f.bin ? ' (binário)' : `  +${f.a} -${f.d}`}`);
  }
  if (withPatch && r.commit) out.push('', store.patch(r.parent, r.commit));
  return out.join('\n');
}

function formatOp(op, res) {
  if (res.ok) {
    const verb = op === 'desfazer' ? 'Desfeita' : 'Refeita';
    return `${verb} a requisição #${res.seq} "${res.title}" (${res.files.length} arquivo(s)${res.forced ? ', forçado' : ''}):\n` +
      res.files.map(f => `  ${f}`).join('\n');
  }
  if (res.reason === 'conflict') {
    return `${res.message}\nNada foi alterado. Para ${op} mesmo assim (as edições posteriores ficam salvas no histórico como "alterações fora do Claude"), use: /historico:${op} --forcar`;
  }
  return res.message;
}

// ---------------------------------------------------------------------------
// hooks

function emit(obj) { process.stdout.write(JSON.stringify(obj)); }

function sessionContext(store, idx) {
  const lines = [
    '[historico] Este projeto grava um checkpoint git por requisição do usuário (histórico com desfazer/refazer no VS Code).',
    '- Quando a requisição for alterar arquivos e você não usar ferramenta de tarefas nem plan mode, comece a primeira resposta com um bloco curto "Plano:" seguido de 2 a 6 tópicos "- ...". O plugin salva esse plano junto com o checkpoint.',
    `- Se o usuário pedir para ver, desfazer ou refazer requisições, use a skill "historico" (CLI: node "${CLI}").`,
  ];
  if (idx && idx.disabled) lines.push(`- Aviso: ${idx.disabled}`);
  return lines.join('\n');
}

/**
 * /historico:abrir|listar|desfazer|refazer digitados no chat: resolvidos aqui mesmo, sem gastar
 * uma resposta do Claude (o prompt é bloqueado e o resultado aparece para o usuário).
 * A sessão que digitou é avisada do desfazer/refazer na próxima mensagem normal.
 */
function handleCommandPrompt(store, prompt) {
  const m = COMMAND_RE.exec(prompt);
  if (!m) return null;
  const name = (m[1] || m[2]).toLowerCase();
  const cmd = ALIASES[name] || name;
  const args = parseArgs(String(m[3] || '').split(/\s+/).filter(Boolean));
  if (cmd === 'abrir') {
    core.requestOpen(store.projectDir);
    return 'Abrindo o histórico no VS Code (extensão "Claude Request History").\n\n' + formatList(store, store.load(), 8);
  }
  if (cmd === 'listar') return formatList(store, store.load(), args.n || 30);
  const res = store.applyOp(cmd === 'desfazer' ? 'undo' : 'redo', { force: !!args.force, by: 'slash' });
  return formatOp(cmd, res);
}

function runHook(event, input) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const store = new core.Store(projectDir);
  const sessionId = input.session_id || 'sem-sessao';

  switch (event) {
    case 'SessionStart': {
      if (store.disabledReason()) return;
      if (!store.exists()) {
        // a primeira fotografia de um projeto grande demora: roda em segundo plano para não travar a sessão
        spawn(process.execPath, [CLI, 'init', '--project', store.projectDir], {
          detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
        }).unref();
      }
      emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sessionContext(store, store.load()) } });
      return;
    }
    case 'UserPromptSubmit': {
      const prompt = String(input.prompt || '');
      if (prompt.includes(SKILL_MARKER)) return; // skill do próprio plugin já expandida: não é uma requisição
      store.ensureInit();
      const cmdOut = store.exists() ? handleCommandPrompt(store, prompt) : null;
      if (cmdOut != null) { emit({ decision: 'block', reason: cmdOut }); return; }
      const res = store.onPrompt({ sessionId, prompt });
      const ctx = [];
      if (res.notices && res.notices.length) ctx.push('[historico] ' + res.notices.join('\n[historico] '));
      if (res.amended) ctx.push(`[historico] Esta mensagem foi anexada à requisição #${res.request.seq} em andamento.`);
      if (ctx.length) emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.join('\n') } });
      return;
    }
    case 'PostToolUse':
      store.onToolUse({ sessionId, toolName: input.tool_name, toolInput: input.tool_input, toolResponse: input.tool_response });
      return;
    case 'Stop':
      store.onStop({ sessionId, transcriptPath: input.transcript_path, lastMessage: input.last_assistant_message });
      return;
    case 'SessionEnd':
      store.onSessionEnd({ sessionId });
      return;
    default:
  }
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = ALIASES[args._[0]] || args._[0];

  if (cmd === 'hook') {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) {}
    try { runHook(args._[1] || input.hook_event_name, input); } catch (e) { core.logError(e, `hook ${args._[1]}`); }
    process.exit(0); // nunca atrapalha o Claude
  }

  const store = resolveStore(args);
  switch (cmd) {
    case 'listar': {
      const idx = store.load();
      console.log(args.json ? JSON.stringify(idx, null, 2) : formatList(store, idx, args.n || 20));
      break;
    }
    case 'mostrar':
      console.log(formatShow(store, store.load(), Number(args._[1]), args.patch));
      break;
    case 'desfazer':
    case 'refazer': {
      const res = store.applyOp(cmd === 'desfazer' ? 'undo' : 'redo', { force: !!args.force, by: 'cli', sessionId: args.session });
      console.log(formatOp(cmd, res));
      process.exitCode = res.ok ? 0 : 2;
      break;
    }
    case 'abrir':
      core.requestOpen(store.projectDir);
      console.log('Pedido enviado ao VS Code para abrir o histórico.');
      break;
    case 'init': {
      const idx = store.ensureInit();
      console.log(idx ? `Histórico pronto em ${store.dir}` : `Histórico desativado: ${store.disabledReason()}`);
      break;
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 15).join('\n').replace(/^ \*?/gm, ''));
  }
}

main();
