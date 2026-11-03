/** Um arquivo alterado num commit do histórico (formato do index.json do plugin historico). */
export type HistFile = { p: string; s: 'A' | 'M' | 'D'; a: number; d: number; bin?: boolean; via?: 'tool' | 'other' }

export type HistPlanItem = { id: string; text: string; status: string }

/** Uma linha do histórico: init, manual, request, undo ou redo. */
export type HistEntry = {
  kind: 'init' | 'manual' | 'request' | 'undo' | 'redo'
  id: string
  seq?: number
  sessionId?: string
  status?: 'open' | 'done' | 'undone' | 'discarded'
  title?: string
  prompts?: { text: string; at: string }[]
  startedAt?: string
  endedAt?: string | null
  lastActivityAt?: string
  at?: string
  parent?: string | null
  commit?: string | null
  files?: HistFile[]
  fileCount?: number
  filesTruncated?: boolean
  add?: number
  del?: number
  plan?: { items?: HistPlanItem[]; text?: string | null; fromText?: boolean } | null
  planRevisions?: number
  intro?: string | null
  summary?: string | null
  amended?: boolean
  interrupted?: boolean
  target?: string
  forced?: boolean
  conflicts?: string[]
  note?: string | null
}

export type HistIndex = { project: string; entries: HistEntry[]; disabled?: string | null }

/** O que o painel mostra agora; os dados em si vêm do disco a cada mudança do index.json. */
export type PainelView = {
  selected: string | null
  /** path '*' é o patch inteiro da linha */
  diff: { id: string; path: string; text: string } | null
  showManual: boolean
  showEmpty: boolean
  query: string
  /** quantas linhas a lista mostra quando o painel é estreito */
  listLimit: number
  message: { text: string; tone: 'ok' | 'warn' | 'error' } | null
  pendingForce: 'undo' | 'redo' | null
  busy: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'historico-painel': { view: Shaped<PainelView>; stamp: string }
  }
}
