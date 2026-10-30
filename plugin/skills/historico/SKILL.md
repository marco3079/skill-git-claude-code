---
name: historico
description: Histórico de requisições do Claude Code gravado em git pelo plugin "historico". Use quando o usuário pedir para ver o histórico de requisições ou alterações, saber o que mudou em uma requisição (#N), desfazer ou refazer a última requisição ("desfaz o que você fez", "volta a última alteração", "refaz"), ou abrir o popup do histórico no VS Code.
allowed-tools: Bash(node:*)
---

# Histórico de requisições

O plugin grava um commit por **requisição** (cada mensagem do usuário até o Claude parar), num repositório git
separado do projeto (`~/.claude/request-history`). Mensagens enviadas antes do Claude terminar entram na mesma
requisição como "alteração no meio do caminho". O `.git` do projeto nunca é tocado.

CLI (sempre com aspas, funciona no Bash e no PowerShell):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/rh.js" <comando>
```

| Pedido do usuário | Comando |
|---|---|
| ver o histórico | `listar` (`-n 50` para mais linhas) |
| detalhes / arquivos da requisição N | `mostrar N` (`--patch` para o diff completo) |
| desfazer a última requisição | `desfazer --session ${CLAUDE_SESSION_ID}` |
| refazer a última desfeita | `refazer --session ${CLAUDE_SESSION_ID}` |
| abrir o popup no VS Code | `abrir` |

## Regras

- Desfazer e refazer funcionam como uma pilha: desfazer sempre pega a requisição aplicada mais recente;
  refazer pega a última desfeita. Não existe "desfazer a #7" pulando as mais novas. Se o usuário pedir isso,
  explique e ofereça desfazer em sequência.
- Sempre passe `--session ${CLAUDE_SESSION_ID}` em `desfazer`/`refazer`: sem isso, a requisição atual (esta conversa)
  conta como "em andamento" e a operação é recusada.
- Se a saída falar em conflito (arquivos modificados depois da requisição), mostre a lista ao usuário e pergunte
  antes de repetir com `--forcar`. Com `--forcar` nada se perde: as edições posteriores ficam salvas no histórico.
- Depois de desfazer ou refazer, releia os arquivos afetados antes de editar qualquer um deles.
- Não rode comandos git direto no repositório do histórico; use só a CLI.
- Não use `git reset`/`git checkout` no projeto para "desfazer": isso afeta o repositório do usuário, não o histórico.

## Plano

O plugin salva o plano da requisição junto com o commit. Ele vem, nesta ordem, da ferramenta de tarefas
(TaskCreate/TaskUpdate ou TodoWrite), do plan mode (ExitPlanMode) ou de um bloco de texto no início da sua resposta:

```
Plano:
- primeiro passo
- segundo passo
```
