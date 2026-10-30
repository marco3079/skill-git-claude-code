'use strict';
/**
 * Teste ponta a ponta do motor: simula os hooks do Claude Code chamando rh.js como o Claude chamaria.
 *   node test/engine.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const RH = path.join(__dirname, '..', 'plugin', 'scripts', 'rh.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-test-'));
const HOME = path.join(tmp, 'home');
const PROJ = path.join(tmp, 'projeto teste');
fs.mkdirSync(PROJ, { recursive: true });
process.env.CLAUDE_RH_HOME = HOME;
const core = require('../plugin/scripts/core');

const env = Object.assign({}, process.env, { CLAUDE_RH_HOME: HOME, CLAUDE_PROJECT_DIR: PROJ });
function hook(event, input) {
  const r = spawnSync('node', [RH, 'hook', event], { input: JSON.stringify(Object.assign({ hook_event_name: event, cwd: PROJ }, input)), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
function cli(...args) {
  const r = spawnSync('node', [RH, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const P = rel => path.join(PROJ, rel);
const read = rel => fs.readFileSync(P(rel), 'utf8');
const write = (rel, s) => { fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), s); };
const store = new core.Store(PROJ);
const idx = () => store.load();
const req = seq => idx().entries.find(e => e.kind === 'request' && e.seq === seq);
let step = 0;
const ok = msg => console.log(`  ✓ ${++step}. ${msg}`);

try {
  // projeto inicial com .gitignore, CRLF e acento no nome
  write('.gitignore', 'node_modules/\n*.secret\n');
  write('src/app.js', 'linha1\r\nlinha2\r\n');
  write('docs/relatório final.md', '# Relatório\n');
  write('node_modules/x/index.js', 'ignorado');
  write('chave.secret', 'segredo');

  // repositório aninhado sem commit (antes quebrava o `git add`) e worktree do Claude (ignorada)
  write('libs/vendorizada/lib.js', 'module.exports = 1;\n');
  spawnSync('git', ['init', '-q'], { cwd: P('libs/vendorizada') });
  write('.claude/worktrees/wt1/x.js', 'cópia\n');
  write('.claude/worktrees/wt1/.git', 'gitdir: ../../../.git/worktrees/wt1\n');

  const ss = hook('SessionStart', { session_id: 'S1', source: 'startup' });
  assert.ok(ss.hookSpecificOutput.additionalContext.includes('[historico]'));
  for (let i = 0; i < 200 && !idx(); i++) spawnSync('node', ['-e', 'setTimeout(()=>{},100)']);
  assert.ok(idx() && idx().head, 'repositório inicializado em segundo plano');
  const initFiles = store.git(['ls-tree', '-r', '--name-only', idx().head]).trim().split('\n');
  assert.ok(initFiles.includes('docs/relatório final.md') && !initFiles.some(f => f.includes('node_modules') || f.endsWith('.secret')));
  assert.ok(initFiles.includes('libs/vendorizada/lib.js'), 'conteúdo do repositório aninhado entra no snapshot');
  assert.ok(!initFiles.some(f => f.includes('worktrees')), 'worktrees do Claude ficam de fora');
  ok('SessionStart inicializa o git sombra (em segundo plano) respeitando .gitignore, acentos e repositórios aninhados');

  // requisição 1: cria/edita arquivos, plano via TaskCreate/TaskUpdate
  hook('UserPromptSubmit', { session_id: 'S1', prompt: 'Cria a tela de login\ncom validação' });
  hook('PostToolUse', { session_id: 'S1', tool_name: 'TaskCreate', tool_input: { subject: 'Criar login.html' }, tool_response: { task: { id: '1', subject: 'Criar login.html' } } });
  hook('PostToolUse', { session_id: 'S1', tool_name: 'TaskCreate', tool_input: { subject: 'Validar campos' }, tool_response: { task: { id: '2' } } });
  write('src/login.html', '<form></form>\n');
  hook('PostToolUse', { session_id: 'S1', tool_name: 'Write', tool_input: { file_path: P('src/login.html') } });
  write('src/app.js', 'linha1\r\nlinha2 alterada\r\n');
  write('build.log', 'gerado pelo terminal\n');
  hook('PostToolUse', { session_id: 'S1', tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } });
  hook('Stop', { session_id: 'S1', last_assistant_message: 'Pronto, criei a tela.' });
  let r1 = req(1);
  assert.strictEqual(r1.status, 'done');
  assert.deepStrictEqual(r1.files.map(f => f.p + ':' + f.s), ['src/app.js:M', 'src/login.html:A']);
  assert.strictEqual(r1.files.find(f => f.p === 'src/login.html').via, 'tool');
  assert.deepStrictEqual(r1.plan.items.map(i => i.status), ['completed', 'pending']);
  assert.strictEqual(r1.summary, 'Pronto, criei a tela.');
  assert.ok(store.git(['log', '-1', '--format=%B', r1.commit]).includes('Plano:'));
  ok('requisição #1: commit com pedido, plano (TaskCreate/TaskUpdate), arquivos e resposta (*.log ignorado pelo exclude padrão)');

  // edição manual entre requisições + requisição 2 com plano em texto
  write('README.md', 'feito à mão\n');
  hook('UserPromptSubmit', { session_id: 'S1', prompt: 'Apaga o relatório' });
  fs.unlinkSync(P('docs/relatório final.md'));
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', origin: { kind: 'human' }, message: { content: 'Apaga o relatório' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Plano:\n- remover o arquivo\n- conferir links' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Removido.' }] } },
  ].map(o => JSON.stringify(o)).join('\n'));
  hook('Stop', { session_id: 'S1', transcript_path: transcript });
  const manual = idx().entries.find(e => e.kind === 'manual');
  assert.ok(manual && manual.files.map(f => f.p).join() === 'README.md', 'edição manual separada');
  const r2 = req(2);
  assert.deepStrictEqual(r2.files.map(f => f.p + ':' + f.s), ['docs/relatório final.md:D']);
  assert.deepStrictEqual(r2.plan.items.map(i => i.text), ['remover o arquivo', 'conferir links']);
  assert.strictEqual(r2.summary, 'Removido.');
  ok('edição manual vira commit próprio; requisição #2 pega o plano do texto "Plano:" da transcrição');

  // requisição 3 alterada no meio do caminho (segunda mensagem antes do Stop) + aviso automático ignorado
  hook('UserPromptSubmit', { session_id: 'S1', prompt: 'Adiciona CSS' });
  write('src/style.css', 'body{}\n');
  const amend = hook('UserPromptSubmit', { session_id: 'S1', prompt: 'na verdade usa cor azul' });
  assert.ok(amend.hookSpecificOutput.additionalContext.includes('#3'));
  hook('UserPromptSubmit', { session_id: 'S1', prompt: '<task-notification><task-id>x</task-id></task-notification>' });
  write('src/style.css', 'body{color:blue}\n');
  hook('Stop', { session_id: 'S1' });
  const r3 = req(3);
  assert.strictEqual(r3.prompts.length, 2);
  assert.ok(r3.amended);
  assert.strictEqual(idx().seq, 3, 'aviso automático não vira requisição');
  ok('mensagem enviada antes do Stop entra na mesma requisição (#3 alterada); <task-notification> ignorado');

  // requisição 4 sem alterações (pergunta) em outra sessão
  hook('UserPromptSubmit', { session_id: 'S2', prompt: 'O que faz o app.js?' });
  hook('Stop', { session_id: 'S2' });
  assert.strictEqual(req(4).commit, null);
  ok('requisição sem alterações fica registrada sem commit (#4, outra sessão)');

  // desfazer: pilha começa na #3 (a #4 não alterou nada)
  let t = core.computeTargets(idx());
  assert.strictEqual(t.undo.seq, 3);
  let o = cli('desfazer');
  assert.strictEqual(o.code, 0, o.out);
  assert.ok(!fs.existsSync(P('src/style.css')));
  o = cli('desfazer');
  assert.strictEqual(o.code, 0, o.out);
  assert.strictEqual(read('docs/relatório final.md'), '# Relatório\n');
  t = core.computeTargets(idx());
  assert.strictEqual(t.undo.seq, 1);
  assert.strictEqual(t.redo.seq, 2, 'refazer começa pela última desfeita');
  ok('desfazer em pilha: #3 e depois #2 (arquivo apagado volta, criado some)');

  // refazer #2, depois #3
  o = cli('refazer');
  assert.ok(!fs.existsSync(P('docs/relatório final.md')), o.out);
  o = cli('refazer');
  assert.strictEqual(read('src/style.css'), 'body{color:blue}\n');
  assert.strictEqual(core.computeTargets(idx()).redo, null);
  ok('refazer reaplica #2 e #3 na ordem certa');

  // conflito: arquivo da #3 editado depois → recusa; --forcar resolve e guarda a edição
  write('src/style.css', 'body{color:red}\n');
  o = cli('desfazer');
  assert.strictEqual(o.code, 2);
  assert.ok(o.out.includes('src/style.css'));
  assert.strictEqual(read('src/style.css'), 'body{color:red}\n', 'nada muda sem --forcar');
  o = cli('desfazer', '--forcar');
  assert.strictEqual(o.code, 0, o.out);
  assert.ok(!fs.existsSync(P('src/style.css')));
  const saved = idx().entries.filter(e => e.kind === 'manual').pop();
  assert.strictEqual(store.fileAt(saved.commit, 'src/style.css').toString(), 'body{color:red}\n');
  ok('conflito detectado; --forcar desfaz e a edição posterior fica salva no histórico');

  // aviso para o Claude na próxima mensagem + nova requisição descarta o refazer
  const notice = hook('UserPromptSubmit', { session_id: 'S1', prompt: 'Cria um teste' });
  assert.ok(notice.hookSpecificOutput.additionalContext.includes('DESFEZ a requisição #3'));
  write('test/a.test.js', 'ok\n');
  hook('Stop', { session_id: 'S1' });
  assert.strictEqual(req(3).status, 'discarded');
  assert.strictEqual(core.computeTargets(idx()).redo, null);
  ok('o Claude é avisado do desfazer; nova requisição com alterações descarta o refazer da #3');

  // CRLF e binário preservados byte a byte
  const bin = Buffer.from([0, 1, 2, 255, 13, 10, 0]);
  hook('UserPromptSubmit', { session_id: 'S1', prompt: 'binário' });
  fs.writeFileSync(P('img.bin'), bin);
  write('src/app.js', 'linha1\r\nlinha2 de novo\r\n');
  hook('Stop', { session_id: 'S1' });
  assert.ok(req(6).files.find(f => f.p === 'img.bin').bin);
  cli('desfazer');
  assert.strictEqual(read('src/app.js'), 'linha1\r\nlinha2 alterada\r\n', 'CRLF preservado');
  cli('refazer');
  assert.ok(fs.readFileSync(P('img.bin')).equals(bin));
  ok('CRLF e arquivo binário restaurados byte a byte');

  // comandos no chat resolvidos pelo hook (sem gastar resposta do Claude)
  const blk = hook('UserPromptSubmit', { session_id: 'S1', prompt: '/historico:listar' });
  assert.strictEqual(blk.decision, 'block');
  assert.ok(blk.reason.includes('#6'));
  const und = hook('UserPromptSubmit', { session_id: 'S1', prompt: '/historico:desfazer' });
  assert.ok(und.reason.includes('Desfeita a requisição #6'), und.reason);
  assert.ok(!fs.existsSync(P('img.bin')));
  assert.strictEqual(idx().seq, 6, 'comandos não viram requisição');
  const skill = hook('UserPromptSubmit', { session_id: 'S1', prompt: '<!-- historico-cmd -->\nRepita a saída' });
  assert.strictEqual(skill, null);
  ok('/historico:listar e /historico:desfazer resolvidos pelo hook (bloqueiam o prompt)');

  // desfazer pedido pelo próprio Claude no meio de uma requisição (skill) usa --session
  hook('UserPromptSubmit', { session_id: 'S1', prompt: 'refaz o que eu desfiz' });
  o = cli('refazer');
  assert.strictEqual(o.code, 2, 'sem --session a requisição atual bloqueia');
  o = cli('refazer', '--session', 'S1');
  assert.strictEqual(o.code, 0, o.out);
  hook('Stop', { session_id: 'S1' });
  assert.ok(fs.readFileSync(P('img.bin')).equals(bin));
  assert.strictEqual(req(7).commit, null, 'a requisição que pediu o refazer não leva o refazer como alteração própria');
  ok('refazer via skill (--session) dentro de uma requisição em andamento');

  console.log('\n' + cli('listar', '-n', '30').out);
  console.log(`Todos os ${step} cenários passaram.`);
} finally {
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log('dados mantidos em', tmp);
}
