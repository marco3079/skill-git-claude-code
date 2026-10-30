---
name: listar
description: Mostra o histórico de requisições (estilo git log) no chat.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
<!-- historico-cmd: normalmente o hook do plugin resolve este comando antes de chegar aqui -->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rh.js" listar $ARGUMENTS`

Repita para o usuário a saída acima, sem comentários extras. Se ela falar em conflito, pergunte se ele quer repetir com `--forcar`.
