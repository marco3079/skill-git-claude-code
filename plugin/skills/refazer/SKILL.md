---
name: refazer
description: Refaz a última requisição desfeita (use --forcar se houver conflito).
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
<!-- historico-cmd: normalmente o hook do plugin resolve este comando antes de chegar aqui -->
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/rh.js" refazer $ARGUMENTS`

Repita para o usuário a saída acima, sem comentários extras. Se ela falar em conflito, pergunte se ele quer repetir com `--forcar`.
