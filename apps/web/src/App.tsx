import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, BookOpen, ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import type { Card, CardList, Kind, Source, Stats } from '@english-coach/shared';
import { api, dateLabel, errorMessage } from './api';
import { NoteDetail } from './NoteDetail';
import { ReviewSession } from './ReviewSession';

const pageSize = 12;

export function App() {
  const [view, setView] = useState<'records' | 'review'>('records');
  const [stats, setStats] = useState<Stats | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useRef<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const select = useCallback((id: string | null) => {
    selected.current = id;
    setSelectedId(id);
  }, []);
  const selectAvailable = useCallback((cards: Card[]) => {
    if (selected.current && cards.some(card => card.id === selected.current)) return;
    select(window.matchMedia('(min-width: 761px)').matches ? cards[0]?.id ?? null : null);
  }, [select]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 20000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    api<Stats>('/api/stats', { signal: controller.signal })
      .then(value => { setStats(value); setConnectionError(''); })
      .catch(error => { if (!controller.signal.aborted) setConnectionError(errorMessage(error)); });
    return () => controller.abort();
  }, [revision]);

  async function exportRecords() {
    if (exporting) return;
    setExporting(true); setExportError('');
    try {
      const response = await fetch('/api/export');
      if (!response.ok) throw new Error('导出失败，请重试。');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      anchor.href = url;
      anchor.download = `codex-english-coach-${today}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setExportError(errorMessage(error)); }
    finally { setExporting(false); }
  }

  return <div className="app">
    <header className="app-toolbar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView('records'); }}>
        <BookOpen size={21} strokeWidth={1.6} /><span>English Coach</span>
      </a>
      <nav className="view-switch" aria-label="主导航">
        <button className={view === 'records' ? 'active' : ''} aria-current={view === 'records' ? 'page' : undefined} onClick={() => setView('records')}>学习记录</button>
        <button className={view === 'review' ? 'active' : ''} aria-current={view === 'review' ? 'page' : undefined} onClick={() => setView('review')}>复习{!!stats?.due && <span>{stats.due}</span>}</button>
      </nav>
      <div className="toolbar-actions">
        {connectionError && <button className="icon-button connection-warning" title={connectionError} aria-label="重新连接" onClick={refresh}><RefreshCw size={17} /></button>}
        <button className="icon-button" title="导出记录" aria-label="导出记录" onClick={() => void exportRecords()} disabled={exporting}><ArrowDownToLine size={18} /></button>
      </div>
    </header>
    {connectionError && <div className="app-error" role="alert">{connectionError}<button onClick={refresh}>重试</button></div>}
    {exportError && <p className="app-error" role="alert">{exportError}</p>}
    {view === 'review' ? <main className="review-main"><ReviewSession onExit={() => setView('records')} onChanged={refresh} /></main> : <main className={`workspace ${selectedId ? 'has-selection' : ''}`}>
      <Records selectedId={selectedId} revision={revision} onSelect={select} onLoaded={selectAvailable} />
      <div className="detail-column">
        {selectedId ? <NoteDetail key={selectedId} id={selectedId} onBack={() => select(null)} onChanged={refresh} /> : <div className="detail-placeholder" aria-hidden="true" />}
      </div>
    </main>}
  </div>;
}

function Records({ selectedId, revision, onSelect, onLoaded }: {
  selectedId: string | null; revision: number; onSelect(id: string): void; onLoaded(cards: Card[]): void
}) {
  const [source, setSource] = useState<Source | ''>('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [archived, setArchived] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [list, setList] = useState<CardList>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const activeFilter = !!(source || kind || query || from || to || archived);
  const advancedFilter = !!(kind || from || to || archived);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError('');
      const search = new URLSearchParams({ archived: String(archived), limit: String(pageSize), offset: String(page * pageSize) });
      if (source) search.set('source', source);
      if (kind) search.set('kind', kind);
      if (query.trim()) search.set('q', query.trim());
      if (from) search.set('from', from);
      if (to) search.set('to', to);
      api<CardList>(`/api/cards?${search}`, { signal: controller.signal })
        .then(value => {
          setList(value);
          if (page > 0 && page * pageSize >= value.total) setPage(Math.max(0, Math.ceil(value.total / pageSize) - 1));
          else onLoaded(value.items);
        })
        .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 180 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [source, kind, query, from, to, archived, page, revision, retry, onLoaded]);

  function clearFilters() {
    setSource(''); setKind(''); setQuery(''); setFrom(''); setTo(''); setArchived(false); setPage(0);
  }

  return <section className="record-column" aria-label="学习记录列表">
    <div className="list-tools">
      <div className="list-heading">
        <h1>{archived ? '已归档' : '学习记录'}<span>{list.total}</span></h1>
        <button className={`icon-button ${advancedFilter ? 'filter-active' : ''}`} title="筛选记录" aria-label="筛选记录" aria-expanded={filtersOpen} aria-controls="record-filters" onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal size={17} /></button>
      </div>
      <label className="search-field"><Search size={16} />
        <input aria-label="搜索学习记录" maxLength={300} placeholder="搜索词句" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        {query && <button className="clear-search" aria-label="清除搜索" onClick={() => { setQuery(''); setPage(0); }}><X size={13} /></button>}
      </label>
      <div className="source-switch" aria-label="记录来源">
        {([['', '全部'], ['writing', '写作'], ['reading', '阅读']] as const).map(([value, label]) => <button key={value} className={source === value ? 'active' : ''} aria-pressed={source === value} onClick={() => { setSource(value); setPage(0); }}>{label}</button>)}
      </div>
      {filtersOpen && <div className="record-filters" id="record-filters">
        <label>类型<select aria-label="词句类型" value={kind} onChange={event => { setKind(event.target.value as Kind | ''); setPage(0); }}><option value="">全部类型</option><option value="word">单词</option><option value="phrase">词组</option><option value="sentence">句子</option></select></label>
        <div className="date-filters">
          <label>从<input aria-label="开始日期" type="date" value={from} max={to || undefined} onChange={event => { setFrom(event.target.value); setPage(0); }} /></label>
          <label>到<input aria-label="结束日期" type="date" value={to} min={from || undefined} onChange={event => { setTo(event.target.value); setPage(0); }} /></label>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={archived} onChange={event => { setArchived(event.target.checked); setPage(0); }} />已归档</label>
        {activeFilter && <button className="text-button" onClick={clearFilters}>清除筛选</button>}
      </div>}
    </div>
    <div className="list-content" aria-busy={loading}>
      {loading ? <div className="list-loading" role="status">加载中…</div> : error ? <div className="list-empty"><p role="alert">{error}</p><button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></div> : list.items.length ? <div className="record-list">
        {list.items.map(card => <button className={`record-row ${selectedId === card.id ? 'selected' : ''}`} key={card.id} onClick={() => onSelect(card.id)} aria-current={selectedId === card.id ? 'true' : undefined} aria-label={`查看记录：${card.expression}`}>
          <span className="record-line"><strong lang="en">{card.expression}</strong><time>{dateLabel(card.lastEncounterAt)}</time></span>
          <span className="record-meaning">{card.meaning}</span>
        </button>)}
      </div> : <div className="list-empty"><p>{activeFilter ? '没有匹配的记录' : '向 Codex 提问或中英混写，学习记录会出现在这里。'}</p>{activeFilter && <button className="text-button" onClick={clearFilters}>清除筛选</button>}</div>}
    </div>
    {list.total > pageSize && !loading && <div className="pagination"><span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, list.total)} / {list.total}</span><div>
      <button className="icon-button" aria-label="上一页" disabled={page === 0} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button>
      <button className="icon-button" aria-label="下一页" disabled={(page + 1) * pageSize >= list.total} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button>
    </div></div>}
  </section>;
}
