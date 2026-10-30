'use strict';
/**
 * Gera tools/preview-state.js a partir de um histórico real (ex.: KEEP=1 node test/engine.test.js)
 * para ver o popup no navegador sem o VS Code:  node tools/make-preview.js <pasta-do-teste>
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
process.env.CLAUDE_RH_HOME = path.join(dir, 'home');
const core = require('../plugin/scripts/core');
const project = path.join(dir, 'projeto teste');
const store = new core.Store(project);
const idx = store.load();

// enriquece alguns textos para exercitar o layout (e deixar os prints do README com cara de uso real)
const titles = {
  2: 'Remove o relatório antigo da pasta docs',
  5: 'Cria testes para a validação do login',
  6: 'Adiciona o logo da empresa no cabeçalho',
  7: 'Refaz a alteração do logo',
};
for (const [seq, title] of Object.entries(titles)) {
  const r = idx.entries.find(e => e.kind === 'request' && e.seq === Number(seq));
  if (r) { r.title = title; if (r.prompts[0]) r.prompts[0].text = title; }
}
const r6 = idx.entries.find(e => e.seq === 6);
r6.plan = { items: [{ id: '1', text: 'Adicionar `img.bin` como logo', status: 'completed' }, { id: '2', text: 'Ajustar `src/app.js` para carregar o logo', status: 'completed' }] };
r6.summary = 'Adicionei o logo e o cabeçalho já carrega a imagem.';
const r1 = idx.entries.find(e => e.seq === 1);
r1.prompts[0].text = 'Cria a tela de login com validação de e-mail e senha.\nUsa o mesmo layout do cadastro e mostra a mensagem de erro embaixo do campo.';
r1.summary = 'Pronto. Criei **src/login.html** com o formulário e ajustei `src/app.js` para validar:\n\n- e-mail com formato válido\n- senha com no mínimo 8 caracteres\n\nRode `npm test` para conferir.';
const r2 = idx.entries.find(e => e.seq === 2);
r2.plan.text = null;
const r3 = idx.entries.find(e => e.seq === 3);
r3.plan = { items: [], text: '# Plano: estilos da tela\n\n1. Criar `src/style.css` com as variáveis de cor\n2. Aplicar azul nos botões\n\n| arquivo | ação |\n|---|---|\n| src/style.css | criar |' };
idx.seq += 1;
idx.entries.push({
  kind: 'request', id: 'r-open', seq: idx.seq, sessionId: 'S3', status: 'open', title: 'Refatora o módulo de relatórios',
  prompts: [{ text: 'Refatora o módulo de relatórios para usar a API nova', at: new Date().toISOString() }],
  startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), files: [], fileCount: 0, add: 0, del: 0,
  plan: { items: [{ id: '1', text: 'Mapear chamadas antigas', status: 'completed' }, { id: '2', text: 'Trocar pelo cliente novo', status: 'in_progress' }, { id: '3', text: 'Atualizar testes', status: 'pending' }] },
  planRevisions: 3, toolFiles: [],
});

const t = core.computeTargets(idx);
const state = {
  projects: [{ key: idx.key, name: 'meu-projeto', project: idx.project }],
  key: idx.key, project: idx.project, name: 'meu-projeto', disabled: null,
  entries: idx.entries, head: idx.head,
  targets: { undo: t.undo ? t.undo.id : null, redo: t.redo ? t.redo.id : null },
  running: null,
};
const runningState = Object.assign({}, state, { running: 'r-open' });
const idleEntries = state.entries.filter(e => e.id !== 'r-open');
fs.writeFileSync(path.join(__dirname, 'preview-state.js'),
  `window.PREVIEW = ${JSON.stringify({ idle: Object.assign({}, state, { entries: idleEntries }), running: runningState })};\n`);
console.log('ok', idx.entries.length, 'entradas');
