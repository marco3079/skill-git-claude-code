import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HistEntry, HistFile, HistIndex, PainelView } from '../types'

/**
 * Painel do histórico de requisições (plugin "historico") ao lado do chat.
 * Os dados vêm do index.json que o plugin grava em ~/.claude/request-history;
 * desfazer/refazer chamam a CLI do plugin, e o diff de cada arquivo sai do git sombra.
 */

const PANE = 'historico'
const TITLE = 'Histórico'
const COMMAND = 'historico-painel'
const POLL_MS = 2000
const MAX_ROWS = 80
const ACCENT = '#8b7cf6'
const PALETTE = [ACCENT, '#3ba7ff', '#22c08b', '#f2a33a', '#ec5f9b', '#00b8c4', '#f0743c', '#6f8cff']
const firstLine = (s: string) => s.split('\n')[0] ?? s

const VIEW0: PainelView = {
  selected: null, diff: null, showManual: true, showEmpty: false, message: null, pendingForce: null, busy: false,
}
// Troque o tag quando os campos mudarem: valores gravados por uma versão anterior voltam ao inicial.
const view = atom({ plugin: 'historico-painel', key: 'view' } as const, VIEW0, { shape: 'view-1' })
const stamp = atom({ plugin: 'historico-painel', key: 'stamp' } as const, '')

type Ctx = { root: string; indexFile: string; repoDir: string; rh: string | null }

// caches do módulo: um reload os zera e tudo é relido do disco
let ctx: Ctx | null = null
let cache: { stamp: string; idx: HistIndex | null } = { stamp: '', idx: null }
let lastStamp = ''

// ---------------------------------------------------------------------------
// caminhos (mesma regra do core.js do plugin)

const isWin = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
const join = (...parts: string[]) => parts.map((p, i) => (i ? p.replace(/^[\\/]+/, '') : p.replace(/[\\/]+$/, ''))).join('/')

function normalizeDir(p: string): string {
  const r = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWin(p) ? r.toLowerCase() : r
}

async function projectKey(dir: string): Promise<string> {
  const clean = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = (clean.split('/').pop() || '').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root'
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(normalizeDir(dir)))
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  return `${base}-${hex.slice(0, 10)}`
}

async function locate($: EngineInterface): Promise<Ctx> {
  if (ctx) return ctx
  const root = await $.session.root()
  const userHome = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  const home = (await $.env.get('CLAUDE_RH_HOME')) || join(userHome, '.claude', 'request-history')
  let dir = join(home, 'projects', await projectKey(root))
  if (!(await $.fs.exists(join(dir, 'index.json')))) {
    // o Claude pode ter começado numa pasta acima: procura um projeto que contenha a raiz
    const want = normalizeDir(root)
    const projects = await $.fs.list(join(home, 'projects')).catch(() => [])
    for (const p of projects) {
      if (p.kind !== 'dir') continue
      try {
        const idx = JSON.parse(await $.fs.read(join(home, 'projects', p.name, 'index.json'))) as HistIndex
        const have = normalizeDir(idx.project)
        if (want === have || want.startsWith(have + '/')) { dir = join(home, 'projects', p.name); break }
      } catch (_) { /* projeto sem índice */ }
    }
  }
  ctx = { root, indexFile: join(dir, 'index.json'), repoDir: join(dir, 'repo'), rh: await findCli($, userHome) }
  return ctx
}

/** CLI do plugin historico instalado (rh.js), para desfazer/refazer com o mesmo motor. */
async function findCli($: EngineInterface, userHome: string): Promise<string | null> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || join(userHome, '.claude')
  try {
    const data = JSON.parse(await $.fs.read(join(config, 'plugins', 'installed_plugins.json'))) as {
      plugins?: Record<string, { installPath: string }[]>
    }
    for (const [name, installs] of Object.entries(data.plugins || {})) {
      if (name.startsWith('historico@') && installs[0]) return join(installs[0].installPath, 'scripts', 'rh.js')
    }
  } catch (_) { /* sem plugins instalados */ }
  return null
}

async function indexStamp($: EngineInterface): Promise<string> {
  const c = await locate($)
  try {
    const st = await $.fs.stat(c.indexFile)
    return `${st.mtimeMs}:${st.size}`
  } catch (_) {
    return 'none'
  }
}

async function loadIndex($: EngineInterface): Promise<HistIndex | null> {
  const s = await indexStamp($)
  if (s === cache.stamp) return cache.idx
  let idx: HistIndex | null = null
  if (s !== 'none') {
    try { idx = JSON.parse(await $.fs.read((await locate($)).indexFile)) as HistIndex } catch (_) { idx = cache.idx }
  }
  cache = { stamp: s, idx }
  return idx
}

async function poll($: EngineInterface) {
  const s = await indexStamp($)
  if (s !== lastStamp) {
    lastStamp = s
    await update($, stamp, () => s)
  }
}

// ---------------------------------------------------------------------------
// regras (as mesmas do motor)

function targets(idx: HistIndex) {
  const reqs = idx.entries.filter(e => e.kind === 'request' && e.commit)
  const undo = [...reqs].reverse().find(r => r.status === 'done') || null
  const redo = reqs.find(r => r.status === 'undone' && (!undo || (r.seq || 0) > (undo.seq || 0))) || null
  return { undo, redo }
}

function isRunning(e: HistEntry) {
  return e.kind === 'request' && e.status === 'open' &&
    Date.now() - Date.parse(e.lastActivityAt || e.startedAt || '') < 30 * 60 * 1000
}

function titleOf(e: HistEntry, idx: HistIndex): string {
  const target = e.target ? idx.entries.find(x => x.id === e.target) : undefined
  switch (e.kind) {
    case 'request': return e.title || 'Requisição'
    case 'manual': return 'Alterações fora do Claude' + (e.note ? ` · ${e.note}` : '')
    case 'undo': return `Desfez #${e.seq}${target ? ' · ' + target.title : ''}`
    case 'redo': return `Refez #${e.seq}${target ? ' · ' + target.title : ''}`
    default: return 'Estado inicial do projeto'
  }
}

function ago(iso?: string | null): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 45) return 'agora'
  if (s < 3600) return `há ${Math.round(s / 60)} min`
  if (s < 86400) return `há ${Math.round(s / 3600)} h`
  return `há ${Math.round(s / 86400)} d`
}

function when(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function sessionColors(idx: HistIndex) {
  const map = new Map<string, string>()
  for (const e of idx.entries) if (e.sessionId && !map.has(e.sessionId)) map.set(e.sessionId, PALETTE[map.size % PALETTE.length] ?? ACCENT)
  return map
}

/** Um trecho do grafo estilo git para uma linha da lista. */
function graphSvg(e: HistEntry, color: string, isFirst: boolean, isLast: boolean): string {
  const line = 'rgba(140,140,150,.55)'
  const parts: string[] = []
  if (!isFirst) parts.push(`<line x1="11" y1="0" x2="11" y2="22" stroke="${line}" stroke-width="2"/>`)
  if (!isLast) parts.push(`<line x1="11" y1="22" x2="11" y2="44" stroke="${line}" stroke-width="2"/>`)
  if (e.kind === 'request') {
    if (e.status === 'open') parts.push('<circle cx="11" cy="22" r="6" fill="#d29922"/>')
    else if (!e.commit) parts.push(`<circle cx="11" cy="22" r="3.5" fill="#1f1f24" stroke="${color}" stroke-width="1.5"/>`)
    else if (e.status === 'undone') parts.push('<circle cx="11" cy="22" r="6" fill="#1f1f24" stroke="#f85149" stroke-width="2" stroke-dasharray="2.4 2"/>')
    else if (e.status === 'discarded') parts.push('<circle cx="11" cy="22" r="5.5" fill="#1f1f24" stroke="#8b90a0" stroke-width="1.5"/>')
    else parts.push(`<circle cx="11" cy="22" r="7" fill="${color}" stroke="#1f1f24" stroke-width="2"/>`)
  } else if (e.kind === 'manual') {
    parts.push('<rect x="7" y="18" width="8" height="8" transform="rotate(45 11 22)" fill="#1f1f24" stroke="#8b90a0" stroke-width="1.5"/>')
  } else if (e.kind === 'undo' || e.kind === 'redo') {
    parts.push(`<circle cx="11" cy="22" r="4.5" fill="#1f1f24" stroke="${e.kind === 'undo' ? '#f85149' : '#3fb950'}" stroke-width="2"/>`)
  } else {
    parts.push('<rect x="6" y="17" width="10" height="10" rx="2.5" fill="#8b90a0"/>')
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="44" viewBox="0 0 22 44">${parts.join('')}</svg>`
}

function statusGlyph(e: HistEntry): string {
  if (e.kind === 'manual') return '◇'
  if (e.kind === 'undo') return '↶'
  if (e.kind === 'redo') return '↷'
  if (e.kind === 'init') return '■'
  if (e.status === 'open') return '◉'
  if (e.status === 'undone') return '◌'
  return e.commit ? '●' : '·'
}

// ---------------------------------------------------------------------------
// ações

async function setView($: EngineInterface, patch: Partial<PainelView>) {
  await update($, view, v => ({ ...v, ...patch }))
}

async function runOp($: EngineInterface, op: 'undo' | 'redo', force: boolean) {
  const c = await locate($)
  if (!c.rh) {
    await setView($, { message: { text: 'Plugin "historico" não encontrado. Instale-o para desfazer e refazer.', tone: 'error' } })
    return
  }
  await setView($, { busy: true, message: null, pendingForce: null })
  const argv = ['node', c.rh, op === 'undo' ? 'desfazer' : 'refazer', '--project', c.root]
  if (force) argv.push('--forcar')
  let text = ''
  let tone: 'ok' | 'warn' | 'error' = 'ok'
  let pending: 'undo' | 'redo' | null = null
  try {
    const r = await $.process.run(argv, { timeoutMs: 180000 })
    text = (r.stdout || r.stderr).trim()
    if (r.exitCode !== 0) {
      const conflict = /modificados depois/.test(text)
      tone = conflict ? 'warn' : 'error'
      pending = conflict ? op : null
      if (conflict) text = firstLine(text)
    }
  } catch (err) {
    text = `Não consegui rodar o node: ${String(err)}`
    tone = 'error'
  }
  await setView($, { busy: false, message: { text, tone }, pendingForce: pending })
  if (tone === 'ok') $.ui.toast(firstLine(text))
  await poll($)
}

async function showDiff($: EngineInterface, e: HistEntry, path: string) {
  const c = await locate($)
  if (!e.commit || !e.parent) return
  const r = await $.process.run(['git', '--literal-pathspecs', '--git-dir', c.repoDir, '-c', 'core.quotepath=false',
    'diff-tree', '-p', '--no-color', '--no-ext-diff', e.parent, e.commit, '--', path])
    .catch(err => ({ stdout: `Não consegui rodar o git: ${String(err)}`, exitCode: 1 }))
  const text = r.stdout.length > 60000 ? r.stdout.slice(0, 60000) + '\n… (diff cortado)' : r.stdout
  await setView($, { diff: { id: e.id, path, text: text || '(sem diferenças de texto)' } })
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Abre o painel do histórico de requisições ao lado do chat' })
    $.clock.every(POLL_MS, () => { void poll($).catch(() => {}) })
    if ((await indexStamp($)) !== 'none') void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Painel do histórico aberto.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e)
    const v = await read($, view)
    await read($, stamp) // redesenha quando o index.json muda
    const idx = await loadIndex($)
    const svgOf = (source: string, alt: string) => {
      if (e.surface === 'terminal' || e.surface === 'mobile') return null
      const { Svg } = $.ui.resolve(e)
      return <Svg source={source} alt={alt} width={22} height={44} />
    }

    if (!idx) {
      return (
        <Box flexDirection="column" gap="sm" padding="sm">
          <Text weight="semibold">Nenhuma requisição registrada ainda</Text>
          <Text dimColor>Mande uma mensagem para o Claude nesta pasta: cada pedido vira um commit com o plano e os arquivos alterados.</Text>
          <Text dimColor>Precisa do plugin "historico" (github.com/marco3079/skill-git-claude-code).</Text>
        </Box>
      )
    }
    if (idx.disabled) {
      return <Box padding="sm"><Text color="warning">{`Histórico desativado: ${idx.disabled}`}</Text></Box>
    }

    const t = targets(idx)
    const running = idx.entries.find(isRunning)
    const colors = sessionColors(idx)
    const color = (x: HistEntry) => (x.sessionId && colors.get(x.sessionId)) || ACCENT

    const header = (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" alignItems="center" gap="sm" flexWrap="wrap">
          <Text weight="semibold">Histórico</Text>
          <Text dimColor wrap="truncate-middle">{idx.project.replace(/\\/g, '/').split('/').pop() || ''}</Text>
          <Box flexGrow={1} />
          <Button key="undo" label={t.undo ? `↶ Desfazer #${t.undo.seq}` : '↶ Desfazer'} dimColor={!t.undo || !!running || v.busy}
            onPress={() => { if (t.undo && !running && !v.busy) void runOp($, 'undo', false) }} />
          <Button key="redo" label={t.redo ? `↷ Refazer #${t.redo.seq}` : '↷ Refazer'} dimColor={!t.redo || !!running || v.busy}
            onPress={() => { if (t.redo && !running && !v.busy) void runOp($, 'redo', false) }} />
        </Box>
        {running && <Text color="warning">{`O Claude está trabalhando na #${running.seq}; desfazer e refazer esperam ele terminar.`}</Text>}
        {v.busy && <Text dimColor>Trabalhando…</Text>}
        {v.message && (
          <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
            <Text color={v.message.tone === 'ok' ? 'success' : v.message.tone === 'warn' ? 'warning' : 'error'}>{v.message.text}</Text>
            {v.pendingForce && (
              <Button key="force" variant="primary" label={v.pendingForce === 'undo' ? 'Desfazer mesmo assim' : 'Refazer mesmo assim'}
                onPress={() => { const op = v.pendingForce; if (op) void runOp($, op, true) }} />
            )}
            <Button key="dismiss" plain label="×" onPress={() => { void setView($, { message: null, pendingForce: null }) }} />
          </Box>
        )}
      </Box>
    )

    const selected = v.selected ? idx.entries.find(x => x.id === v.selected) : undefined
    if (selected) return <Box flexDirection="column" gap="md" padding="sm">{header}{detail(selected)}</Box>

    // ----- lista -----
    const reqs = idx.entries.filter(x => x.kind === 'request')
    const applied = reqs.filter(x => x.status === 'done' && x.commit)
    const add = applied.reduce((s, x) => s + (x.add || 0), 0)
    const del = applied.reduce((s, x) => s + (x.del || 0), 0)
    const rows = idx.entries.filter(x => {
      if (x.kind === 'manual' && !v.showManual) return false
      if (x.kind === 'request' && !x.commit && x.status !== 'open' && !v.showEmpty) return false
      return true
    }).slice(-MAX_ROWS).reverse()

    return (
      <Box flexDirection="column" gap="sm" padding="sm">
        {header}
        <Text dimColor size="footnote">{`${reqs.length} requisições · ${new Set(reqs.map(x => x.sessionId)).size} sessões · +${add} −${del}`}</Text>
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          <Button key="t-manual" plain dimColor={!v.showManual} label={`${v.showManual ? '☑' : '☐'} Edições manuais`}
            onPress={() => { void update($, view, x => ({ ...x, showManual: !x.showManual })) }} />
          <Button key="t-empty" plain dimColor={!v.showEmpty} label={`${v.showEmpty ? '☑' : '☐'} Sem alterações`}
            onPress={() => { void update($, view, x => ({ ...x, showEmpty: !x.showEmpty })) }} />
        </Box>
        <Box flexDirection="column">
          {rows.map((x, i) => {
            const meta = [x.commit ? x.commit.slice(0, 7) : '', ago(x.startedAt || x.at),
              x.kind === 'init' ? `${x.fileCount ?? 0} arquivos no projeto`
                : x.fileCount ? `${x.fileCount} arq · +${x.add} −${x.del}`
                  : x.kind === 'request' && x.status !== 'open' ? 'sem alterações' : '',
              x.status === 'undone' ? 'desfeita' : x.status === 'discarded' ? 'descartada' : x.status === 'open' ? 'trabalhando' : '',
              x.amended ? '✎ alterada no meio' : '',
              t.undo === x ? '← desfazer disponível' : t.redo === x ? '← refazer disponível' : '',
            ].filter(Boolean).join(' · ')
            const muted = x.kind !== 'request' || !x.commit || x.status === 'undone' || x.status === 'discarded'
            const svg = svgOf(graphSvg(x, color(x), i === 0, i === rows.length - 1), `${x.kind} ${x.seq ?? ''}`)
            return (
              <Box key={`row-${x.id}`} flexDirection="row" alignItems="center" gap="xs">
                {svg || <Text color={x.kind === 'request' ? color(x) : undefined} dimColor={x.kind !== 'request'}>{statusGlyph(x)}</Text>}
                <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Button key={x.id} plain onPress={() => { void setView($, { selected: x.id, diff: null }) }}>
                    {x.kind === 'request' ? <Text color={color(x)} weight="semibold" mono>{`#${x.seq} `}</Text> : ''}
                    <Text dimColor={muted} strikethrough={x.status === 'undone' || x.status === 'discarded'} wrap="truncate-end">{titleOf(x, idx)}</Text>
                  </Button>
                  <Text dimColor size="footnote" wrap="truncate-end">{meta}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )

    // ----- detalhes -----
    function detail(x: HistEntry) {
      if (!idx) return null
      const files = x.files || []
      const isUndo = t.undo === x
      const isRedo = t.redo === x
      const chips = [
        x.status === 'open' ? 'trabalhando' : x.status === 'undone' ? 'desfeita' : x.status === 'discarded' ? 'descartada' : '',
        x.amended ? 'alterada no meio do caminho' : '',
        x.interrupted ? 'interrompida' : '',
        x.forced ? 'forçado' : '',
        x.sessionId ? `sessão ${x.sessionId.slice(0, 8)}` : '',
        when(x.startedAt || x.at),
        x.commit ? x.commit.slice(0, 7) : '',
      ].filter(Boolean).join(' · ')
      const items = x.plan?.items || []
      return (
        <Box flexDirection="column" gap="md">
          <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
            <Button key="back" label="← Voltar" onPress={() => { void setView($, { selected: null, diff: null }) }} />
            {isUndo && <Button key="d-undo" variant="primary" label={`↶ Desfazer #${x.seq}`} dimColor={!!running || v.busy}
              onPress={() => { if (!running && !v.busy) void runOp($, 'undo', false) }} />}
            {isRedo && <Button key="d-redo" variant="primary" label={`↷ Refazer #${x.seq}`} dimColor={!!running || v.busy}
              onPress={() => { if (!running && !v.busy) void runOp($, 'redo', false) }} />}
          </Box>
          <Box flexDirection="column" gap="xs">
            <Text size="heading" weight="semibold">{`${x.kind === 'request' ? `#${x.seq} ` : ''}${titleOf(x, idx)}`}</Text>
            <Text dimColor size="footnote">{chips}</Text>
          </Box>

          {x.kind === 'request' && (
            <Box flexDirection="column" gap="xs">
              <Text weight="semibold" dimColor size="footnote">PEDIDO</Text>
              {(x.prompts || []).length === 0 && <Text dimColor>Sem mensagem do usuário (o Claude continuou sozinho).</Text>}
              {(x.prompts || []).map((p, i) => (
                <Box key={`p-${i}`} flexDirection="column" padding="sm" borderStyle={i ? 'dashed' : 'round'} borderDimColor>
                  <Text dimColor size="footnote">{i === 0 ? `Pedido · ${when(p.at)}` : `✎ Alteração no meio do caminho · ${when(p.at)}`}</Text>
                  <Text>{p.text.length > 1500 ? p.text.slice(0, 1500) + '…' : p.text}</Text>
                </Box>
              ))}
            </Box>
          )}

          {x.kind === 'request' && (items.length > 0 || x.plan?.text || x.intro) && (
            <Box flexDirection="column" gap="xs">
              <Text weight="semibold" dimColor size="footnote">{items.length || x.plan?.text ? 'PLANO' : 'ABORDAGEM'}</Text>
              {items.map(it => (
                <Text key={`it-${it.id}`} dimColor={it.status === 'completed'}>
                  {`${it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '◐' : '○'} ${it.text}`}
                </Text>
              ))}
              {x.plan?.text && <Markdown text={x.plan.text} />}
              {!items.length && !x.plan?.text && x.intro && <Markdown text={x.intro} />}
            </Box>
          )}

          {x.kind !== 'init' && (
            <Box flexDirection="column" gap="xs">
              <Text weight="semibold" dimColor size="footnote">{`ARQUIVOS ALTERADOS${x.fileCount ? ` · ${x.fileCount} · +${x.add} −${x.del}` : ''}`}</Text>
              {x.status === 'open' && <Text dimColor>Os arquivos aparecem quando o Claude terminar a requisição.</Text>}
              {x.status !== 'open' && files.length === 0 && <Text dimColor>Nenhum arquivo alterado.</Text>}
              {files.map((f: HistFile) => (
                <Button key={`f-${f.p}`} plain onPress={() => { void showDiff($, x, f.p) }}>
                  <Text mono color={f.s === 'A' ? 'success' : f.s === 'D' ? 'error' : 'warning'}>{`${f.s} `}</Text>
                  <Text strikethrough={f.s === 'D'}>{f.p}</Text>
                  <Text dimColor>{f.bin ? '  binário' : `  +${f.a} −${f.d}`}{f.via === 'other' ? '  (terminal)' : ''}</Text>
                </Button>
              ))}
              {x.filesTruncated && <Text dimColor>{`Mostrando ${files.length} de ${x.fileCount} arquivos.`}</Text>}
              {v.diff && v.diff.id === x.id && (
                <Box flexDirection="column" gap="xs">
                  <Box flexDirection="row" gap="sm" alignItems="center">
                    <Text weight="semibold" wrap="truncate-middle">{v.diff.path}</Text>
                    <Button key="close-diff" plain label="× fechar diff" onPress={() => { void setView($, { diff: null }) }} />
                  </Box>
                  <Code source={v.diff.text} format="diff" path={v.diff.path} wrap="truncate-end" />
                </Box>
              )}
            </Box>
          )}

          {x.summary && (
            <Box flexDirection="column" gap="xs">
              <Text weight="semibold" dimColor size="footnote">RESPOSTA FINAL DO CLAUDE</Text>
              <Markdown text={x.summary} />
            </Box>
          )}
        </Box>
      )
    }
  })
}
