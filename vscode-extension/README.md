# Claude Request History

Popup com o histórico de requisições do Claude Code gravado pelo plugin `historico`:
cada mensagem enviada ao Claude vira um commit (num git separado do projeto) com o pedido,
o plano, os arquivos alterados e a resposta final. Desfazer/refazer sempre na requisição mais recente.

- `Ctrl+Alt+H` ou o item **Claude #N** na barra de status abre o popup.
- Clique num arquivo para ver o diff antes ↔ depois.
- Configurações: `claudeHistory.openAs` (popup ou aba), `claudeHistory.notify`, `claudeHistory.autoOpen`.
