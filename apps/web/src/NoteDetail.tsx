import { useEffect, useState } from 'react';
import { Archive, ArrowLeft, Pencil, RotateCcw } from 'lucide-react';
import type { CardDetail, CardPatch } from '@english-coach/shared';
import { api, dateLabel, errorMessage } from './api';

const ratingLabel = { forgot: '忘了', hard: '费劲', familiar: '熟悉' };
function draft(card: CardDetail['card']) {
  return { meaning: card.meaning, explanation: card.explanation, prompt: card.prompt };
}

export function NoteDetail({ id, onBack, onChanged }: { id: string; onBack(): void; onChanged(): void }) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ meaning: '', explanation: '', prompt: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api<CardDetail>(`/api/cards/${id}`, { signal: controller.signal })
      .then(value => { setDetail(value); setForm(draft(value.card)); })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, retry]);

  async function update(patch: CardPatch) {
    if (saving || !detail) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await api(`/api/cards/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const updated = await api<CardDetail>(`/api/cards/${id}`);
      setDetail(updated); setEditing(false); setNotice('已保存'); onChanged();
    } catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  function startEditing() {
    if (!detail) return;
    setForm(draft(detail.card)); setEditing(true); setNotice('');
  }

  const card = detail?.card;
  return <section className="note-detail" aria-label="词句详情">
    <div className="note-toolbar">
      <button className="icon-button mobile-back" title="返回列表" aria-label="返回列表" onClick={onBack}><ArrowLeft size={19} /></button>
      <div className="note-actions">{card && !editing && <>
        <button className="icon-button" title="编辑笔记" aria-label="编辑笔记" onClick={startEditing}><Pencil size={17} /></button>
        <button className="icon-button" title={card.archived ? '恢复复习' : '归档'} aria-label={card.archived ? '恢复复习' : '归档'} disabled={saving} onClick={() => void update({ archived: !card.archived })}>{card.archived ? <RotateCcw size={17} /> : <Archive size={17} />}</button>
      </>}</div>
    </div>
    <div className="note-scroll">
      {loading ? <p className="detail-status" role="status">加载中…</p> : card ? <article className="note-content">
        <header className="note-heading"><h2 lang="en">{card.expression}</h2>{card.archived && <span className="archive-label">已归档</span>}{!editing && <p>{card.meaning}</p>}</header>
        {editing ? <form className="edit-form" onSubmit={event => { event.preventDefault(); void update(form); }}>
          <div className="edit-field"><label htmlFor="note-meaning">中文含义</label><textarea id="note-meaning" autoFocus required maxLength={12000} rows={2} value={form.meaning} onChange={event => setForm({ ...form, meaning: event.target.value })} /></div>
          <div className="edit-field"><label htmlFor="note-explanation">解释</label><textarea id="note-explanation" required maxLength={12000} rows={5} value={form.explanation} onChange={event => setForm({ ...form, explanation: event.target.value })} /></div>
          <div className="edit-field"><label htmlFor="note-prompt">复习提示</label><textarea id="note-prompt" required maxLength={12000} rows={3} value={form.prompt} onChange={event => setForm({ ...form, prompt: event.target.value })} /></div>
          <div className="form-actions"><button type="button" className="button secondary" disabled={saving} onClick={() => setEditing(false)}>取消</button><button className="button primary" disabled={saving || !form.meaning.trim() || !form.explanation.trim() || !form.prompt.trim()}>{saving ? '保存中…' : '保存'}</button></div>
        </form> : <>
          <blockquote className="note-context" lang="en">{card.context}</blockquote>
          {card.original && <p className="original-fragment"><span>修改前</span><span lang="en">{card.original}</span></p>}
          <p className="note-explanation">{card.explanation}</p>
          <div className="note-history">
            <details><summary>复习提示</summary><p className="history-prompt">{card.prompt}</p>{!card.archived && <p className="history-meta">下次复习 {card.dueDate}</p>}</details>
            <details><summary>遇到记录<span>{detail.encounters.length}</span></summary><div className="history-list">{detail.encounters.map(encounter => <article key={encounter.id}><div className="history-meta"><span>{encounter.sourceLabel}</span><time>{dateLabel(encounter.createdAt, true)}</time></div><p lang="en">{encounter.context}</p><p>{encounter.explanation}</p></article>)}</div></details>
            <details><summary>复习历史<span>{detail.reviews.length}</span></summary>{detail.reviews.length ? <div className="history-list">{detail.reviews.map(review => <article key={review.id}><div className="history-meta"><span>{ratingLabel[review.rating]}</span><time>{dateLabel(review.reviewedAt, true)}</time></div><p>下次复习 {review.nextDueDate}</p></article>)}</div> : <p className="history-meta">暂无复习记录</p>}</details>
          </div>
        </>}
        {notice && <p className="save-notice" role="status">{notice}</p>}
      </article> : <div className="detail-status"><p>无法打开这条记录</p><button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
  </section>;
}
