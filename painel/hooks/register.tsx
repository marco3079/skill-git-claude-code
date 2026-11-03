import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { HistEntry, HistFile, HistIndex, PainelView } from '../types'

/**
 * Painel do histórico de requisições (plugin "historico") ao lado do chat, no mesmo layout da
 * janela da extensão do VS Code: topo com Desfazer/Refazer, barra de contagens e filtros, lista
 * com o grafo estilo git e, ao lado (ou embaixo, se o painel for estreito), os detalhes.
 * Os dados vêm do index.json que o plugin grava em ~/.claude/request-history; desfazer/refazer
 * chamam a CLI do plugin, e os diffs saem do repositório git sombra.
 */

const PANE = 'historico'
const TITLE = 'Histórico'
const COMMAND = 'historico-painel'
const POLL_MS = 2000
const MAX_ROWS = 150
const WIDE_COLUMNS = 100
const NARROW_ROWS = 12

const ACCENT = '#8b7cf6'
const PALETTE = [ACCENT, '#3ba7ff', '#22c08b', '#f2a33a', '#ec5f9b', '#00b8c4', '#f0743c', '#6f8cff']
const RED = '#f85149'
const GREEN = '#3fb950'
const AMBER = '#d29922'
const MUTED = '#8b90a0'
const LINE = 'rgba(140,140,150,0.5)'
const HEADER_BG = '#8b7cf614'
const BAR_BG = '#8080800f'
const SEL_BG = '#8b7cf630'
const CARD_BG = '#80808012'

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E8825F"/><stop offset="1" stop-color="#7B5CF5"/></linearGradient></defs><rect width="128" height="128" rx="30" fill="url(#bg)"/><g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"><path d="M36 30v68" stroke-width="6" stroke-opacity=".85"/><circle cx="36" cy="32" r="8.5" fill="#fff" stroke-width="0"/><circle cx="36" cy="64" r="8.5" fill="#fff" stroke-width="0"/><circle cx="36" cy="96" r="7" fill="#9b6be0" stroke-width="4" stroke-dasharray="4.4 3.2"/><path d="M76 38 62 52l14 14" stroke-width="7.5"/><path d="M62 52h26a16 16 0 0 1 0 32H70" stroke-width="7.5"/></g></svg>'

const firstLine = (s: string) => s.split('\n')[0] ?? s

const VIEW0: PainelView = {
  selected: null, diff: null, showManual: true, showEmpty: false, query: '', listLimit: NARROW_ROWS,
  message: null, pendingForce: null, busy: false,
}
// Troque o tag quando os campos mudarem: valores gravados por uma versão anterior voltam ao inicial.
const view = atom({ plugin: 'historico-painel', key: 'view' } as const, VIEW0, { shape: 'view-2' })
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
// regras (as mesmas do motor) e formatação

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
  if (s < 172800) return 'ontem'
  return `há ${Math.round(s / 86400)} dias`
}

function when(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}, ${two(d.getHours())}:${two(d.getMinutes())}`
}

function dur(a?: string | null, b?: string | null): string {
  if (!a || !b) return ''
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

function num(n?: number): string {
  const v = n || 0
  return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(v)
}

function sessionColors(idx: HistIndex) {
  const map = new Map<string, string>()
  for (const e of idx.entries) if (e.sessionId && !map.has(e.sessionId)) map.set(e.sessionId, PALETTE[map.size % PALETTE.length] ?? ACCENT)
  return map
}

// ---------------------------------------------------------------------------
// grafo: cada linha da lista leva uma fatia de SVG da mesma altura

const ROW_H = 52
const MID = ROW_H / 2
const X0 = 13
const LANE = 10

type Arc = { from: number; to: number; kind: 'undo' | 'redo'; lane: number }

function layoutArcs(rows: HistEntry[]): { arcs: Arc[]; width: number } {
  const pos = new Map(rows.map((e, i) => [e.id, i] as const))
  const arcs: Arc[] = []
  rows.forEach((e, i) => {
    const to = e.target ? pos.get(e.target) : undefined
    if ((e.kind === 'undo' || e.kind === 'redo') && to !== undefined && to > i) arcs.push({ from: i, to, kind: e.kind, lane: 0 })
  })
  const lanes: [number, number][][] = []
  for (const a of arcs) {
    let l = 0
    while ((lanes[l] || []).some(([lo, hi]) => !(a.to < lo || a.from > hi))) l++
    ;(lanes[l] = lanes[l] || []).push([a.from, a.to])
    a.lane = l + 1
  }
  return { arcs, width: X0 + lanes.length * LANE + 12 }
}

function nodeRadius(e: HistEntry): number {
  if (e.kind === 'request') return e.status === 'open' ? 6 : !e.commit ? 3.5 : e.status === 'undone' || e.status === 'discarded' ? 6 : 7
  return e.kind === 'manual' ? 5.5 : e.kind === 'init' ? 6 : 4.5
}

function graphSlice(e: HistEntry, i: number, total: number, arcs: Arc[], width: number, color: string): string {
  const r = nodeRadius(e)
  const p: string[] = []
  if (i > 0) p.push(`<line x1="${X0}" y1="0" x2="${X0}" y2="${MID - r - 1}" stroke="${LINE}" stroke-width="2"/>`)
  if (i < total - 1) p.push(`<line x1="${X0}" y1="${MID + r + 1}" x2="${X0}" y2="${ROW_H}" stroke="${LINE}" stroke-width="2"/>`)
  for (const a of arcs) {
    const x = X0 + a.lane * LANE
    const col = a.kind === 'undo' ? RED : GREEN
    const dash = `fill="none" stroke="${col}" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.75"`
    if (i === a.from) p.push(`<path d="M${X0 + r} ${MID} Q${x} ${MID} ${x} ${MID + 12} L${x} ${ROW_H}" ${dash}/>`)
    else if (i === a.to) p.push(`<path d="M${x} 0 L${x} ${MID - 12} Q${x} ${MID} ${X0 + r} ${MID}" ${dash}/>`)
    else if (i > a.from && i < a.to) p.push(`<path d="M${x} 0 L${x} ${ROW_H}" ${dash}/>`)
  }
  if (e.kind === 'request') {
    if (e.status === 'open') {
      p.push(`<circle cx="${X0}" cy="${MID}" r="10" fill="none" stroke="${AMBER}" stroke-width="1.5" opacity="0.5"/>`)
      p.push(`<circle cx="${X0}" cy="${MID}" r="6" fill="${AMBER}"/>`)
    } else if (!e.commit) p.push(`<circle cx="${X0}" cy="${MID}" r="3.5" fill="none" stroke="${color}" stroke-width="1.5"/>`)
    else if (e.status === 'undone') p.push(`<circle cx="${X0}" cy="${MID}" r="6" fill="none" stroke="${RED}" stroke-width="2" stroke-dasharray="2.4 2"/>`)
    else if (e.status === 'discarded') p.push(`<circle cx="${X0}" cy="${MID}" r="5.5" fill="none" stroke="${MUTED}" stroke-width="1.5"/>`)
    else p.push(`<circle cx="${X0}" cy="${MID}" r="7" fill="${color}"/>`)
  } else if (e.kind === 'manual') {
    p.push(`<rect x="${X0 - 4}" y="${MID - 4}" width="8" height="8" transform="rotate(45 ${X0} ${MID})" fill="none" stroke="${MUTED}" stroke-width="1.5"/>`)
  } else if (e.kind === 'undo' || e.kind === 'redo') {
    p.push(`<circle cx="${X0}" cy="${MID}" r="4.5" fill="none" stroke="${e.kind === 'undo' ? RED : GREEN}" stroke-width="2"/>`)
  } else {
    p.push(`<rect x="${X0 - 5}" y="${MID - 5}" width="10" height="10" rx="2.5" fill="${MUTED}"/>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}">${p.join('')}</svg>`
}

function glyph(e: HistEntry): string {
  if (e.kind === 'manual') return '◇'
  if (e.kind === 'undo') return '↶'
  if (e.kind === 'redo') return '↷'
  if (e.kind === 'init') return '■'
  if (e.status === 'open') return '◉'
  if (e.status === 'undone') return '◌'
  return e.commit ? '●' : '·'
}

/** ■■■□□ como a mini barra da janela do VS Code */
function bar(a?: number, d?: number): { add: string; del: string; rest: string } {
  const total = (a || 0) + (d || 0)
  if (!total) return { add: '', del: '', rest: '' }
  const na = Math.round(((a || 0) / total) * 5)
  const nd = Math.min(5 - na, Math.max(d ? 1 : 0, Math.round(((d || 0) / total) * 5)))
  return { add: '■'.repeat(na), del: '■'.repeat(nd), rest: '■'.repeat(5 - na - nd) }
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

/** Diff de um arquivo, ou o patch inteiro da linha com path '*'. */
async function showDiff($: EngineInterface, e: HistEntry, path: string) {
  const c = await locate($)
  if (!e.commit || !e.parent) return
  const argv = ['git', '--literal-pathspecs', '--git-dir', c.repoDir, '-c', 'core.quotepath=false',
    'diff-tree', '-p', '--no-color', '--no-ext-diff', e.parent, e.commit]
  if (path !== '*') argv.push('--', path)
  const r = await $.process.run(argv).catch(err => ({ stdout: `Não consegui rodar o git: ${String(err)}`, exitCode: 1 }))
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
    const canSvg = e.surface === 'desktop' || e.surface === 'vscode'
    const svg = (source: string, alt: string, width: number, height: number) => {
      if (e.surface !== 'desktop' && e.surface !== 'vscode') return null
      const { Svg } = $.ui.resolve(e)
      return <Svg source={source} alt={alt} width={width} height={height} />
    }
    const wide = e.props.bodyColumns >= WIDE_COLUMNS
    // o app do celular não tem campo de texto: lá a busca some
    const searchBox = () => {
      if (e.surface === 'mobile') return null
      const { Input } = $.ui.resolve(e)
      return (
        <Box flexGrow={1} minWidth={18}>
          <Input key="q" placeholder="Buscar pedido, arquivo ou hash…" value={v.query}
            onInput={(value: string) => { void setView($, { query: value }) }}
            onSubmit={(value: string) => { void setView($, { query: value }) }} />
        </Box>
      )
    }

    // ----- pequenos blocos visuais -----
    const chip = (key: string, label: string, color: string, bg: string) => (
      <Text key={key} size="caption" weight="semibold" color={color} backgroundColor={bg}>{` ${label} `}</Text>
    )
    const section = (key: string, title: string, extra: string, body: RenderChildren) => (
      <Box key={key} flexDirection="column" gap="sm">
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Text size="caption" weight="semibold" dimColor>{title}</Text>
          {extra ? <Text size="caption" dimColor>{extra}</Text> : null}
        </Box>
        {body}
      </Box>
    )
    const card = (key: string, children: RenderChildren, dashed = false) => (
      <Box key={key} flexDirection="column" gap="xs" paddingX="md" paddingY="sm" borderStyle={dashed ? 'dashed' : 'round'}
        borderColor={dashed ? ACCENT : undefined} borderDimColor={!dashed} backgroundColor={CARD_BG}>
        {children}
      </Box>
    )

    if (!idx || idx.disabled) {
      return (
        <Box flexDirection="column" alignItems="center" gap="md" padding="lg">
          {svg(LOGO, 'Histórico de requisições', 56, 56)}
          <Text weight="semibold" size="heading">{idx?.disabled ? 'Histórico desativado neste projeto' : 'Nenhuma requisição registrada ainda'}</Text>
          <Text dimColor>{idx?.disabled || 'Mande uma mensagem para o Claude nesta pasta. Cada pedido vira um commit com o plano e os arquivos alterados.'}</Text>
          {!idx && <Text dimColor size="footnote">Precisa do plugin "historico": github.com/marco3079/skill-git-claude-code</Text>}
        </Box>
      )
    }

    const t = targets(idx)
    const running = idx.entries.find(isRunning)
    const colors = sessionColors(idx)
    const color = (x: HistEntry) => (x.sessionId && colors.get(x.sessionId)) || ACCENT
    const blocked = !!running || v.busy
    const doUndo = () => { if (t.undo && !blocked) void runOp($, 'undo', false) }
    const doRedo = () => { if (t.redo && !blocked) void runOp($, 'redo', false) }

    // ----- topo -----
    const top = (
      <Box flexDirection="column" gap="xs" paddingX="md" paddingY="sm" backgroundColor={HEADER_BG}>
        <Box flexDirection="row" alignItems="center" gap="md">
          {svg(LOGO, 'Histórico', 30, 30) || <Text color={ACCENT}>◷</Text>}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text weight="semibold">Histórico de requisições</Text>
            <Text dimColor size="footnote" wrap="truncate-middle">{idx.project.replace(/\\/g, '/').split('/').pop() || ''}</Text>
          </Box>
          <Button key="undo" dimColor={!t.undo || blocked} onPress={doUndo}>
            <Text color="error">↶ Desfazer</Text>
            {t.undo ? <Text color="error" dimColor mono>{` #${t.undo.seq}`}</Text> : ''}
          </Button>
          <Button key="redo" dimColor={!t.redo || blocked} onPress={doRedo}>
            <Text color="success">↷ Refazer</Text>
            {t.redo ? <Text color="success" dimColor mono>{` #${t.redo.seq}`}</Text> : ''}
          </Button>
        </Box>
        {running && <Text color="warning" size="footnote">{`O Claude está trabalhando na #${running.seq}: desfazer e refazer esperam ele terminar.`}</Text>}
        {v.busy && <Text dimColor size="footnote">Trabalhando…</Text>}
        {v.message && (
          <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
            <Text size="footnote" color={v.message.tone === 'ok' ? 'success' : v.message.tone === 'warn' ? 'warning' : 'error'}>{v.message.text}</Text>
            {v.pendingForce && (
              <Button key="force" variant="primary" label={v.pendingForce === 'undo' ? 'Desfazer mesmo assim' : 'Refazer mesmo assim'}
                onPress={() => { const op = v.pendingForce; if (op) void runOp($, op, true) }} />
            )}
            <Button key="dismiss" plain label="×" onPress={() => { void setView($, { message: null, pendingForce: null }) }} />
          </Box>
        )}
      </Box>
    )

    // ----- barra de contagens, filtros e busca -----
    const reqs = idx.entries.filter(x => x.kind === 'request')
    const applied = reqs.filter(x => x.status === 'done' && x.commit)
    const files = new Set<string>()
    applied.forEach(x => (x.files || []).forEach(f => files.add(f.p)))
    const statsBar = (
      <Box flexDirection="row" alignItems="center" gap="md" flexWrap="wrap" paddingX="md" paddingY="xs" backgroundColor={BAR_BG}>
        <Box flexDirection="row" gap="md" flexWrap="wrap">
          <Text size="footnote" dimColor><Text weight="semibold">{String(reqs.length)}</Text> requisições</Text>
          <Text size="footnote" dimColor><Text weight="semibold">{String(new Set(reqs.map(x => x.sessionId)).size)}</Text> sessões</Text>
          <Text size="footnote" dimColor><Text weight="semibold">{String(files.size)}</Text> arquivos</Text>
          <Text size="footnote"><Text color="success" weight="semibold">{`+${num(applied.reduce((s, x) => s + (x.add || 0), 0))}`}</Text> <Text color="error" weight="semibold">{`−${num(applied.reduce((s, x) => s + (x.del || 0), 0))}`}</Text></Text>
        </Box>
        <Button key="t-manual" plain onPress={() => { void update($, view, x => ({ ...x, showManual: !x.showManual })) }}>
          <Text color={v.showManual ? ACCENT : MUTED}>● </Text><Text size="footnote" dimColor={!v.showManual}>Edições manuais</Text>
        </Button>
        <Button key="t-empty" plain onPress={() => { void update($, view, x => ({ ...x, showEmpty: !x.showEmpty })) }}>
          <Text color={v.showEmpty ? ACCENT : MUTED}>● </Text><Text size="footnote" dimColor={!v.showEmpty}>Sem alterações</Text>
        </Button>
        {searchBox()}
      </Box>
    )

    // ----- lista com o grafo -----
    const q = v.query.trim().toLowerCase()
    const all = idx.entries.filter(x => {
      if (x.kind === 'manual' && !v.showManual) return false
      if (x.kind === 'request' && !x.commit && x.status !== 'open' && !v.showEmpty) return false
      if (q) {
        const hay = [titleOf(x, idx), x.seq != null ? `#${x.seq}` : '', x.commit || '',
          ...(x.prompts || []).map(p => p.text), ...(x.files || []).map(f => f.p)].join('\n').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    }).slice(-MAX_ROWS).reverse()
    const rows = wide ? all : all.slice(0, Math.max(NARROW_ROWS, v.listLimit))
    const selected = all.find(x => x.id === v.selected) || all.find(x => x.kind === 'request') || all[0]
    const { arcs, width } = layoutArcs(rows)

    const list = (
      <Box flexDirection="column" width={wide ? '42%' : undefined} flexShrink={0}>
        {rows.length === 0 && <Box padding="lg"><Text dimColor>{q ? `Nada encontrado para “${v.query}”.` : 'Nada para mostrar.'}</Text></Box>}
        {rows.map((x, i) => {
          const isSel = selected?.id === x.id
          const muted = x.kind !== 'request' || !x.commit || x.status === 'undone' || x.status === 'discarded'
          const b = bar(x.add, x.del)
          return (
            <Box key={`row-${x.id}`} flexDirection="row" alignItems="center" gap="sm" paddingRight="sm"
              backgroundColor={isSel ? SEL_BG : undefined}>
              {canSvg ? svg(graphSlice(x, i, rows.length, arcs, width, color(x)), `${x.kind} ${x.seq ?? ''}`, width, ROW_H)
                : <Text color={x.kind === 'request' ? color(x) : MUTED}>{glyph(x)}</Text>}
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                <Button key={x.id} plain onPress={() => { void setView($, { selected: x.id, diff: null }) }}>
                  {x.kind === 'request' ? <Text color={color(x)} weight="semibold" mono>{`#${x.seq} `}</Text> : ''}
                  {x.kind === 'undo' ? <Text color={RED}>{'↶ '}</Text> : x.kind === 'redo' ? <Text color={GREEN}>{'↷ '}</Text> : ''}
                  <Text weight={muted ? 'regular' : 'medium'} dimColor={muted} strikethrough={x.status === 'undone' || x.status === 'discarded'}
                    wrap="truncate-end">{titleOf(x, idx)}</Text>
                  {x.status === 'open' ? <Text size="caption" weight="semibold" color={AMBER}>{'  TRABALHANDO'}</Text> : ''}
                  {x.status === 'undone' ? <Text size="caption" weight="semibold" color={RED}>{'  DESFEITA'}</Text> : ''}
                  {x.status === 'discarded' ? <Text size="caption" weight="semibold" dimColor>{'  DESCARTADA'}</Text> : ''}
                  {x.amended ? <Text size="caption" color={ACCENT}>{`  ✎${(x.prompts || []).length - 1}`}</Text> : ''}
                  {x.forced ? <Text size="caption" weight="semibold" color={AMBER}>{'  FORÇADO'}</Text> : ''}
                </Button>
                <Box flexDirection="row" gap="sm" alignItems="center">
                  {x.commit ? <Text mono size="footnote" dimColor>{x.commit.slice(0, 7)}</Text> : null}
                  <Text size="footnote" dimColor>{ago(x.startedAt || x.at)}</Text>
                  {x.kind === 'init'
                    ? <Text size="footnote" dimColor>{`${x.fileCount ?? 0} arquivos no projeto`}</Text>
                    : x.fileCount
                      ? <Text size="footnote"><Text dimColor>{`${x.fileCount} arquivo${x.fileCount > 1 ? 's' : ''}  `}</Text><Text color="success">{`+${num(x.add)}`}</Text> <Text color="error">{`−${num(x.del)}`}</Text>{'  '}<Text color={GREEN}>{b.add}</Text><Text color={RED}>{b.del}</Text><Text dimColor>{b.rest}</Text></Text>
                      : x.kind === 'request' && x.status !== 'open' ? <Text size="footnote" dimColor>sem alterações</Text> : null}
                </Box>
              </Box>
              {t.undo === x && !blocked && (
                <Button key={`ru-${x.id}`} onPress={doUndo}><Text color="error" size="footnote">↶ Desfazer</Text></Button>
              )}
              {t.redo === x && !blocked && (
                <Button key={`rr-${x.id}`} onPress={doRedo}><Text color="success" size="footnote">↷ Refazer</Text></Button>
              )}
            </Box>
          )
        })}
        {!wide && all.length > rows.length && (
          <Box paddingX="md" paddingY="xs">
            <Button key="more" plain onPress={() => { void update($, view, x => ({ ...x, listLimit: Math.max(NARROW_ROWS, x.listLimit) + 20 })) }}>
              <Text color={ACCENT} size="footnote">{`Mostrar mais (${all.length - rows.length})`}</Text>
            </Button>
          </Box>
        )}
      </Box>
    )

    // ----- detalhes -----
    const detail = selected ? renderDetail(selected) : <Box padding="lg"><Text dimColor>Selecione uma linha.</Text></Box>

    return (
      <Box flexDirection="column">
        {top}
        {statsBar}
        <Box flexDirection={wide ? 'row' : 'column'} alignItems="flex-start">
          {list}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} borderStyle="single" borderDimColor
            paddingX="lg" paddingY="md">
            {detail}
          </Box>
        </Box>
      </Box>
    )

    function renderDetail(x: HistEntry) {
      if (!idx) return null
      const c = color(x)
      const badgeColor = x.kind === 'undo' ? RED : x.kind === 'redo' ? GREEN : x.kind === 'request' ? c : MUTED
      const badge = x.kind === 'request' ? `#${x.seq}` : x.kind === 'undo' ? '↶' : x.kind === 'redo' ? '↷' : x.kind === 'manual' ? '✎' : '◆'
      const xfiles = x.files || []
      const items = x.plan?.items || []
      const target = x.target ? idx.entries.find(y => y.id === x.target) : undefined

      let hint = ''
      if (x.kind === 'request') {
        if (x.status === 'open') hint = 'O Claude ainda está trabalhando nesta requisição.'
        else if (t.undo === x || t.redo === x) hint = running ? 'Desfazer e refazer ficam disponíveis quando o Claude terminar.' : ''
        else if (x.status === 'discarded') hint = 'Descartada: outra requisição alterou arquivos depois que esta foi desfeita.'
        else if (x.status === 'undone') hint = t.redo ? `Desfeita. Refaça antes a #${t.redo.seq}.` : 'Desfeita.'
        else if (x.commit && t.undo) hint = `Só a requisição aplicada mais recente pode ser desfeita (agora: #${t.undo.seq}).`
      } else if (x.kind === 'manual') {
        hint = 'Edições feitas fora do Claude (por você ou outra ferramenta) entre requisições. Ficam separadas para não serem atribuídas a nenhuma requisição.'
      } else if (x.kind === 'init') {
        hint = `Fotografia do projeto quando o histórico começou (${x.fileCount ?? 0} arquivos).`
      } else if (x.forced && x.conflicts?.length) {
        hint = `Sobrescreveu edições posteriores em: ${x.conflicts.join(', ')} (salvas na linha “Alterações fora do Claude” logo abaixo).`
      }

      const planBody = items.length > 0 || x.plan?.text ? (
        <Box flexDirection="column" gap="xs">
          {items.map(it => (
            <Box key={`it-${it.id}`} flexDirection="row" gap="sm" alignItems="flex-start">
              <Text color={it.status === 'completed' ? 'success' : it.status === 'in_progress' ? 'warning' : MUTED}>
                {it.status === 'completed' ? '☑' : it.status === 'in_progress' ? '◐' : '☐'}
              </Text>
              <Text dimColor={it.status === 'completed'}>{it.text}</Text>
            </Box>
          ))}
          {items.length > 0 && (
            <Text size="footnote" dimColor>
              {`${items.filter(it => it.status === 'completed').length}/${items.length} concluídos · ${x.plan?.fromText ? 'do texto da resposta' : 'da lista de tarefas do Claude'}${(x.planRevisions || 0) > 1 && !x.plan?.fromText ? ` · atualizado ${x.planRevisions}×` : ''}`}
            </Text>
          )}
          {x.plan?.text ? card('plan-md', <Markdown text={x.plan.text} />) : null}
          {x.plan?.text ? <Text size="footnote" dimColor>plano aprovado no plan mode</Text> : null}
        </Box>
      ) : null

      return (
        <Box flexDirection="column" gap="lg">
          <Box flexDirection="row" gap="md" alignItems="flex-start">
            <Box paddingX="sm" paddingY="sm" backgroundColor={`${badgeColor}2e`} borderStyle="round" borderColor={badgeColor}>
              <Text color={badgeColor} weight="bold" mono size="heading">{badge}</Text>
            </Box>
            <Box flexDirection="column" gap="xs" flexShrink={1} minWidth={0}>
              <Text size="heading" weight="semibold">{titleOf(x, idx)}</Text>
              <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
                {x.status === 'open' ? chip('c-run', 'TRABALHANDO', AMBER, `${AMBER}33`) : null}
                {x.status === 'undone' ? chip('c-undone', 'DESFEITA', RED, `${RED}2e`) : null}
                {x.status === 'discarded' ? chip('c-disc', 'DESCARTADA', MUTED, `${MUTED}2e`) : null}
                {x.interrupted ? chip('c-int', 'INTERROMPIDA', MUTED, `${MUTED}2e`) : null}
                {x.amended ? chip('c-amend', 'ALTERADA NO MEIO DO CAMINHO', ACCENT, `${ACCENT}33`) : null}
                {x.forced ? chip('c-forced', 'FORÇADO', AMBER, `${AMBER}33`) : null}
                {x.sessionId ? <Text size="footnote" mono color={c}>{`● sessão ${x.sessionId.slice(0, 8)}`}</Text> : null}
                <Text size="footnote" dimColor>{`${when(x.startedAt || x.at)}${x.endedAt ? ' · ' + dur(x.startedAt, x.endedAt) : ''}`}</Text>
                {x.commit ? <Text size="footnote" mono dimColor>{`⧉ ${x.commit.slice(0, 7)}`}</Text> : null}
              </Box>
            </Box>
          </Box>

          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              {t.undo === x && <Button key="d-undo" dimColor={blocked} onPress={doUndo}><Text color="error">{`↶ Desfazer requisição #${x.seq}`}</Text></Button>}
              {t.redo === x && <Button key="d-redo" dimColor={blocked} onPress={doRedo}><Text color="success">{`↷ Refazer requisição #${x.seq}`}</Text></Button>}
              {(x.kind === 'undo' || x.kind === 'redo') && target && (
                <Button key="goto" label={`→ Ir para #${x.seq}`} onPress={() => { void setView($, { selected: target.id, diff: null, query: '' }) }} />
              )}
              {x.commit && x.parent && (
                <Button key="patch" label={v.diff?.id === x.id && v.diff.path === '*' ? 'Fechar patch' : 'Ver patch (git diff)'}
                  onPress={() => { if (v.diff?.id === x.id && v.diff.path === '*') void setView($, { diff: null }); else void showDiff($, x, '*') }} />
              )}
            </Box>
            {hint ? <Text size="footnote" dimColor>{hint}</Text> : null}
            {v.diff && v.diff.id === x.id && v.diff.path === '*' && <Code source={v.diff.text} format="diff" wrap="truncate-end" />}
          </Box>

          {x.kind === 'request' && section('s-prompt', 'PEDIDO', (x.prompts || []).length > 1 ? `${(x.prompts || []).length} mensagens` : '',
            (x.prompts || []).length === 0
              ? card('p-none', <Text dimColor>Sem mensagem do usuário: o Claude continuou sozinho (ex.: aviso de tarefa em segundo plano).</Text>)
              : <Box flexDirection="column" gap="sm">
                {(x.prompts || []).map((p, i) => card(`p-${i}`, <>
                  <Text size="footnote" color={i ? ACCENT : undefined} dimColor={!i}>{i === 0 ? `Pedido · ${when(p.at)}` : `✎ Alteração no meio do caminho · ${when(p.at)}`}</Text>
                  <Text>{p.text.length > 2000 ? p.text.slice(0, 2000) + '…' : p.text}</Text>
                </>, i > 0))}
              </Box>)}

          {x.kind === 'request' && planBody && section('s-plan', 'PLANO', '', planBody)}
          {x.kind === 'request' && !planBody && x.intro && section('s-intro', 'ABORDAGEM', '', <Box flexDirection="column" gap="xs">
            {card('intro', <Markdown text={x.intro} />)}
            <Text size="footnote" dimColor>primeira resposta do Claude (nenhum plano estruturado registrado)</Text>
          </Box>)}

          {x.kind !== 'init' && section('s-files', 'ARQUIVOS ALTERADOS', x.fileCount ? `${x.fileCount} · +${num(x.add)} −${num(x.del)}` : '',
            x.status === 'open'
              ? card('f-wait', <Text dimColor>Os arquivos aparecem quando o Claude terminar a requisição.</Text>)
              : xfiles.length === 0
                ? card('f-none', <Text dimColor>Nenhum arquivo alterado.</Text>)
                : <Box flexDirection="column" borderStyle="round" borderDimColor>
                  {xfiles.map((f: HistFile) => {
                    const slash = f.p.lastIndexOf('/')
                    const name = slash >= 0 ? f.p.slice(slash + 1) : f.p
                    const dir = slash >= 0 ? f.p.slice(0, slash) : ''
                    const fc = f.s === 'A' ? GREEN : f.s === 'D' ? RED : AMBER
                    const b = bar(f.a, f.d)
                    const open = v.diff?.id === x.id && v.diff.path === f.p
                    return (
                      <Box key={`fw-${f.p}`} flexDirection="column" paddingX="sm" paddingY="xs" backgroundColor={open ? SEL_BG : undefined}>
                        <Button key={`f-${f.p}`} plain onPress={() => { if (open) void setView($, { diff: null }); else void showDiff($, x, f.p) }}>
                          <Text mono weight="bold" color={fc} backgroundColor={`${fc}26`}>{` ${f.s} `}</Text>
                          <Text weight="medium" strikethrough={f.s === 'D'} dimColor={f.s === 'D'}>{`  ${name}`}</Text>
                          {dir ? <Text dimColor size="footnote">{`  ${dir}`}</Text> : ''}
                          {f.via === 'other' ? <Text dimColor size="caption">{'   terminal'}</Text> : ''}
                          {f.bin ? <Text dimColor size="footnote">{'   binário'}</Text>
                            : <Text size="footnote" mono>{'   '}<Text color="success">{`+${f.a}`}</Text> <Text color="error">{`−${f.d}`}</Text>{' '}<Text color={GREEN}>{b.add}</Text><Text color={RED}>{b.del}</Text><Text dimColor>{b.rest}</Text></Text>}
                        </Button>
                        {open && <Code source={v.diff?.text || ''} format="diff" path={f.p} wrap="truncate-end" />}
                      </Box>
                    )
                  })}
                  {x.filesTruncated ? <Box paddingX="sm" paddingY="xs"><Text dimColor size="footnote">{`Mostrando ${xfiles.length} de ${x.fileCount} arquivos. Use “Ver patch” para a lista completa.`}</Text></Box> : null}
                </Box>)}

          {x.summary && section('s-summary', 'RESPOSTA FINAL DO CLAUDE', '', card('summary', <Markdown text={x.summary} />))}

          <Box flexDirection="row" gap="lg" flexWrap="wrap" paddingTop="sm">
            <Text size="footnote" dimColor><Text color={ACCENT}>●</Text> requisição (cor = sessão)</Text>
            <Text size="footnote" dimColor><Text color={RED}>◌</Text> desfeita</Text>
            <Text size="footnote" dimColor>◇ edição manual</Text>
            <Text size="footnote" dimColor><Text color={RED}>┆</Text> desfazer/refazer → requisição</Text>
          </Box>
        </Box>
      )
    }
  })
}
