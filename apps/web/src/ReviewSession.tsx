import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { Card, CardList, Rating, ReviewInput, ReviewResult } from '@english-coach/shared';
import { api, ApiError, errorMessage } from './api';

export function ReviewSession({ onExit, onChanged }: { onExit(): void; onChanged(): void }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [round, setRound] = useState(0);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const request = useRef<ReviewInput | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setConflict(false); setIndex(0); setRevealed(false);
    setCards([]); setQueueTotal(0);
    request.current = null;
    api<CardList>('/api/reviews/queue?limit=10', { signal: controller.signal })
      .then(value => { setCards(value.items); setQueueTotal(value.total); })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [round]);

  const card = cards[index];
  async function submit(rating: Rating) {
    if (!card || sending.current || conflict) return;
    sending.current = true; setSaving(true); setError('');
    request.current ??= { id: crypto.randomUUID(), cardId: card.id, rating };
    const attempt = request.current;
    try {
      await api<ReviewResult>('/api/reviews', { method: 'POST', body: JSON.stringify(attempt) });
      request.current = null; setIndex(value => value + 1); setRevealed(false); onChanged();
    } catch (error) {
      setError(errorMessage(error));
      setConflict(error instanceof ApiError && error.status === 409);
    } finally { sending.current = false; setSaving(false); }
  }

  return <section className="review-session" aria-label="卡片复习">
    <div className="review-toolbar"><button className="text-button" onClick={onExit}><ArrowLeft size={16} />返回记录</button>{!loading && card && <span>{index + 1} / {cards.length}</span>}</div>
    {loading ? <p className="review-status" role="status">加载中…</p> : error && !card && !cards.length ? <div className="review-status"><p className="error-message" role="alert">{error}</p><button className="button secondary" onClick={() => setRound(value => value + 1)}>重试</button></div> : !cards.length ? <div className="review-status"><h1>今天没有待复习卡片</h1><button className="button secondary" onClick={onExit}>返回记录</button></div> : !card ? <div className="review-status"><h1>本轮完成</h1><p>已复习 {cards.length} 张</p><div className="completion-actions">{queueTotal > cards.length && <button className="button primary" onClick={() => setRound(value => value + 1)}>继续复习</button>}<button className="button secondary" onClick={onExit}>返回记录</button></div></div> : <>
      <article className="review-card" key={card.id}>
        <span className="review-direction">{card.source === 'reading' ? '阅读' : '写作'}</span>
        <h1 className="review-prompt" lang={card.source === 'reading' ? 'en' : 'zh-CN'}>{card.prompt}</h1>
        {!revealed && <button className="button primary reveal-button" onClick={() => setRevealed(true)}>揭晓答案</button>}
        {revealed && <div className="answer-panel" aria-live="polite" data-testid="review-answer">{card.source === 'writing' && <p className="answer-expression" lang="en">{card.expression}</p>}<p className="answer-meaning">{card.meaning}</p><p className="answer-explanation">{card.explanation}</p>{card.source === 'reading' && <p className="answer-expression small" lang="en">{card.expression}</p>}</div>}
      </article>
      {revealed && <div className="review-actions"><div className="rating-buttons">{([['forgot', '忘了'], ['hard', '费劲'], ['familiar', '熟悉']] as const).map(([value, label]) => <button key={value} className="button secondary" disabled={saving || !!request.current || conflict} onClick={() => void submit(value)}>{label}</button>)}</div>{error && <div className="review-error"><p className="error-message" role="alert">{error}</p>{conflict ? <button className="button secondary" onClick={() => { onChanged(); setRound(value => value + 1); }}>刷新队列</button> : <button className="button secondary" disabled={saving} onClick={() => { if (request.current) void submit(request.current.rating); }}>重试提交</button>}</div>}{saving && <p className="save-notice" role="status">保存中…</p>}</div>}
    </>}
  </section>;
}
