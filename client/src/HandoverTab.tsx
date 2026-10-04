import { useCallback, useEffect, useMemo, useState } from 'react';

type Role = 'outgoing' | 'incoming' | 'supervisor';
type Risk = 'low' | 'medium' | 'high';
type Outcome = 'pending' | 'confirmed' | 'returned';
type PkgStatus = 'active' | 'in-progress' | 'confirmed' | 'expired';
type ScopeKind = 'voyage' | 'block' | 'gate-lane' | 'event' | 'rollover';

interface Catalog {
  voyages: { id: string; label: string; status: string; lateRisk: string }[];
  blocks: { id: string; label: string; heat: number; occupied: number; capacity: number }[];
  lanes: { id: string; label: string; appointments: number }[];
  events: { id: string; category: string; severity: string; title: string; detail: string; open: boolean; risk: Risk }[];
}
interface FieldChange { field: string; from: unknown; to: unknown; }
interface Drift { changed: boolean; liveMissing: boolean; eventResolved: boolean; fields: FieldChange[]; }
interface Item {
  id: string; objectKind: string; objectId: string; title: string; risk: Risk;
  pendingActions: string[]; blockingReasons: string[]; confirmPoints: string[];
  outcome: Outcome; acknowledgedDrift: boolean;
  supplements: { id: string; at: string; author: string; text: string }[];
  carryCount: number; carriedChain: string[]; drift: Drift;
}
interface Note { id: string; at: string; author: string; text: string; visibility: 'internal' | 'restricted'; redacted?: boolean; }
interface Pkg {
  id: string; title: string; fromShift: string; toShift: string; createdBy: string;
  createdAt: string; expiresAt: string; scopes: { kind: ScopeKind; ref: string; label: string }[];
  notes: Note[]; warnings: string[]; status: PkgStatus; expired: boolean;
  items: Item[]; risk: Risk;
  counts: { total: number; pending: number; confirmed: number; returned: number; drift: number };
}
interface Unowned { key: string; objectKind: string; objectId: string; title: string; reason: string; risk: Risk; blockingReasons: string[]; }
interface Overlap { key: string; objectKind: string; objectId: string; title: string; packages: { packageId: string; shift: string; outcome: Outcome; expired: boolean }[]; }
interface Repeat { key: string; objectKind: string; objectId: string; title: string; chain: { packageId: string; shift: string; at: string }[]; }
interface ConsoleData {
  generatedAt: string; packages: Pkg[]; unowned: Unowned[]; overlaps: Overlap[];
  expiredPackages: Pkg[]; repeatTakeovers: Repeat[];
  stats: { packages: number; active: number; expired: number; pendingItems: number; driftItems: number; unowned: number; overlaps: number; repeatTakeovers: number };
}

async function api<T>(path: string, init?: RequestInit, role?: Role): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(role ? { 'X-Handover-Role': role } : {}), ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `请求失败 (${response.status})`), { code: body.code, drift: body.drift });
  return body as T;
}

const riskLabel: Record<Risk, string> = { high: '高风险', medium: '中风险', low: '低风险' };
const fmtTime = (value: string) => new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const shortTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const statusLabel: Record<PkgStatus, string> = { active: '待接管', 'in-progress': '部分确认', confirmed: '已全部确认', expired: '已过期' };
const kindLabel: Record<string, string> = { voyage: '航次', container: '箱务', task: '任务', appointment: '预约', block: '区块', equipment: '设备', event: '事件' };

export default function HandoverTab() {
  const [role, setRole] = useState<Role>('incoming');
  const [catalog, setCatalog] = useState<Catalog>();
  const [view, setView] = useState<ConsoleData>();
  const [selectedId, setSelectedId] = useState<string>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCreator, setShowCreator] = useState(false);

  const load = useCallback(async (activeRole = role) => {
    const [cat, consoleData] = await Promise.all([
      api<Catalog>('/handover/catalog'),
      api<ConsoleData>('/handover/console', undefined, activeRole),
    ]);
    setCatalog(cat); setView(consoleData);
    setSelectedId(current => current || consoleData.packages[0]?.id || '');
  }, [role]);

  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法加载交接台')); }, [load]);

  const selected = view?.packages.find(p => p.id === selectedId);

  const run = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  };

  const changeRole = (next: Role) => { setRole(next); setError(''); void load(next); };

  const counts = view?.stats;

  return <section className="panel wide handover-panel">
    <div className="panel-head">
      <div>
        <div className="eyebrow">SHIFT HANDOVER / 班次交接包</div>
        <h2>现场交接台</h2>
        <span className="muted">快照冻结 · 漂移比对 · 逐项确认/退回/补充 · 确认动作不回写原始作业状态</span>
      </div>
      <div className="handover-role">
        <span className="muted">视角</span>
        {([['outgoing', '交班人'], ['incoming', '接班人'], ['supervisor', '值班主管']] as [Role, string][]).map(([value, label]) =>
          <button key={value} className={role === value ? 'active' : ''} onClick={() => changeRole(value)}>{label}</button>)}
      </div>
    </div>

    {/* 控制台：仍无人负责 / 覆盖冲突 / 过期 / 重复接管 */}
    <div className="handover-alerts">
      <div className={`alert-card ${counts && counts.unowned > 0 ? 'hot' : ''}`}>
        <strong>{counts?.unowned ?? 0}</strong><span>仍无人负责</span>
        <small>未覆盖 / 已退回 / 已过期的在控事项</small>
      </div>
      <div className={`alert-card ${counts && counts.overlaps > 0 ? 'hot' : ''}`}>
        <strong>{counts?.overlaps ?? 0}</strong><span>双重覆盖</span>
        <small>同一对象被两个有效交接包覆盖</small>
      </div>
      <div className={`alert-card ${counts && counts.expired > 0 ? 'hot' : ''}`}>
        <strong>{counts?.expired ?? 0}</strong><span>已过期交接包</span>
        <small>过期后只能滚动交接</small>
      </div>
      <div className={`alert-card ${counts && counts.repeatTakeovers > 0 ? 'warm' : ''}`}>
        <strong>{counts?.repeatTakeovers ?? 0}</strong><span>跨班次重复接管</span>
        <small>连续多个班次都未闭环</small>
      </div>
      <div className={`alert-card ${counts && counts.driftItems > 0 ? 'warm' : ''}`}>
        <strong>{counts?.driftItems ?? 0}</strong><span>源数据已变化</span>
        <small>实时数据与冻结快照不一致</small>
      </div>
    </div>

    {error && <div className="form-error handover-error">{error}<button onClick={() => setError('')}>关闭</button></div>}

    {view && view.unowned.length > 0 && <div className="unowned-strip">
      <b>无人负责事项（{view.unowned.length}）</b>
      <div className="unowned-list">
        {view.unowned.slice(0, 8).map(item => <span key={item.key} className={`unowned-chip risk-${item.risk}`}>
          <em>{kindLabel[item.objectKind] ?? item.objectKind}</em>{item.title}<i title={item.reason}>· {item.reason}</i>
        </span>)}
      </div>
    </div>}

    <div className="handover-layout">
      {/* 左：交接包列表与创建 */}
      <div className="handover-left">
        <div className="handover-toolbar">
          <button className="primary-action" onClick={() => setShowCreator(value => !value)}>{showCreator ? '收起' : '＋ 生成交接包'}</button>
          {view && view.expiredPackages.length > 0 && <RolloverButton consoleData={view} role={role} onDone={load} busy={busy} setBusy={setBusy} setError={setError} />}
        </div>
        {showCreator && catalog && <PackageCreator catalog={catalog} role={role} onCreated={async () => { setShowCreator(false); await load(); }} busy={busy} setBusy={setBusy} setError={setError} />}
        <div className="pkg-list">
          {view?.packages.map(pkg => <button key={pkg.id} className={`pkg-card status-${pkg.status} ${selectedId === pkg.id ? 'selected' : ''}`} onClick={() => setSelectedId(pkg.id)}>
            <div className="pkg-card-head"><b>{pkg.title}</b><span className={`pkg-status ${pkg.status}`}>{statusLabel[pkg.status]}</span></div>
            <small>{pkg.fromShift} → {pkg.toShift} · {pkg.createdBy} · {fmtTime(pkg.createdAt)}</small>
            <div className="pkg-card-meta">
              <span>{pkg.counts.confirmed}/{pkg.counts.total} 已确认</span>
              {pkg.counts.returned > 0 && <span className="text-danger">{pkg.counts.returned} 退回</span>}
              {pkg.counts.drift > 0 && <span className="text-warn">{pkg.counts.drift} 漂移</span>}
              {pkg.warnings.length > 0 && <span className="text-warn">{pkg.warnings.length} 提醒</span>}
            </div>
            {pkg.expired && <small className="text-danger">已于 {shortTime(pkg.expiresAt)} 过期</small>}
          </button>)}
          {view && view.packages.length === 0 && <div className="empty-hint">还没有交接包。选择航次、区块、闸口车道或现场事件生成第一份交接包。</div>}
        </div>
      </div>

      {/* 右：交接包详情 */}
      <div className="handover-right">
        {selected ? <PackageDetail
          key={selected.id} pkg={selected} role={role} busy={busy} setBusy={setBusy}
          overlaps={view!.overlaps} repeats={view!.repeatTakeovers}
          onAction={load} setError={setError}
        /> : <div className="empty-hint">选择或生成一个交接包查看事项明细。</div>}
      </div>
    </div>
  </section>;
}

/* ---------------- 滚动交接按钮 ---------------- */

function RolloverButton(props: { consoleData: ConsoleData; role: Role; onDone: (role?: Role) => Promise<void>; busy: boolean; setBusy: (v: boolean) => void; setError: (v: string) => void }) {
  const { consoleData, role, onDone, busy, setBusy, setError } = props;
  const rollover = async () => {
    const ids = consoleData.expiredPackages.map(p => p.id);
    if (!window.confirm(`将 ${ids.length} 个已过期交接包中未确认/已退回的事项滚动到新交接包？`)) return;
    setBusy(true); setError('');
    try {
      await api('/handover/rollover', { method: 'POST', body: JSON.stringify({ fromPackageIds: ids, toShift: '下一班次' }) }, role);
      await onDone();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '滚动交接失败'); }
    finally { setBusy(false); }
  };
  return <button className="rollover-action" disabled={busy} onClick={() => void rollover()}>⟳ 滚动交接（{ids2Count(consoleData)}）</button>;
}
function ids2Count(data: ConsoleData) { return `${data.expiredPackages.length} 个过期包`; }

/* ---------------- 生成交接包 ---------------- */

type Picked = { kind: ScopeKind; ref: string };

function PackageCreator(props: { catalog: Catalog; role: Role; onCreated: () => Promise<void>; busy: boolean; setBusy: (v: boolean) => void; setError: (v: string) => void }) {
  const { catalog, role, onCreated, busy, setBusy, setError } = props;
  const [picked, setPicked] = useState<Picked[]>([]);
  const [fromShift, setFromShift] = useState('白班');
  const [toShift, setToShift] = useState('夜班');
  const [ttl, setTtl] = useState('120');
  const [note, setNote] = useState('');
  const [restricted, setRestricted] = useState(false);

  const toggle = (kind: ScopeKind, ref: string) => {
    setPicked(current => current.some(p => p.kind === kind && p.ref === ref)
      ? current.filter(p => !(p.kind === kind && p.ref === ref))
      : [...current, { kind, ref }]);
  };
  const isPicked = (kind: ScopeKind, ref: string) => picked.some(p => p.kind === kind && p.ref === ref);

  const submit = async () => {
    if (!picked.length) { setError('请至少勾选一个交接范围'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<{ pkg: Pkg; warnings: string[] }>('/handover/packages', {
        method: 'POST',
        body: JSON.stringify({
          fromShift, toShift, ttlMinutes: Number(ttl),
          scopes: picked,
          ...(note.trim() ? { notes: [{ text: note.trim(), visibility: restricted ? 'restricted' : 'internal' }] } : {}),
        }),
      }, role);
      if (result.warnings.length) window.alert(`交接包已生成，但有 ${result.warnings.length} 条覆盖/重复接管提醒：\n\n${result.warnings.slice(0, 6).join('\n')}${result.warnings.length > 6 ? '\n…' : ''}`);
      await onCreated();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '生成交接包失败'); }
    finally { setBusy(false); }
  };

  return <div className="creator">
    <div className="creator-head">
      <label>交班班次<input value={fromShift} onChange={e => setFromShift(e.target.value)} /></label>
      <label>接班班次<input value={toShift} onChange={e => setToShift(e.target.value)} /></label>
      <label>有效时长(分钟)<input type="number" min="15" value={ttl} onChange={e => setTtl(e.target.value)} /></label>
    </div>
    <div className="scope-columns">
      <div className="scope-col"><b>按航次</b>{catalog.voyages.filter(v => v.status !== 'departed').map(v =>
        <label key={v.id} className={isPicked('voyage', v.id) ? 'checked' : ''}><input type="checkbox" checked={isPicked('voyage', v.id)} onChange={() => toggle('voyage', v.id)} />{v.label}<span className={`risk-dot ${v.lateRisk}`} /></label>)}</div>
      <div className="scope-col"><b>按区块</b>{catalog.blocks.map(b =>
        <label key={b.id} className={isPicked('block', b.id) ? 'checked' : ''}><input type="checkbox" checked={isPicked('block', b.id)} onChange={() => toggle('block', b.id)} />{b.label}<em>{b.heat >= 85 ? '高热区' : ''}</em></label>)}</div>
      <div className="scope-col"><b>按闸口车道</b>{catalog.lanes.map(l =>
        <label key={l.id} className={isPicked('gate-lane', l.id) ? 'checked' : ''}><input type="checkbox" checked={isPicked('gate-lane', l.id)} onChange={() => toggle('gate-lane', l.id)} />{l.label}<em>{l.appointments} 个预约</em></label>)}</div>
      <div className="scope-col"><b>按事件（未闭环异常）</b>{catalog.events.filter(e => e.open).map(e =>
        <label key={e.id} className={isPicked('event', e.id) ? 'checked' : ''} title={e.detail}><input type="checkbox" checked={isPicked('event', e.id)} onChange={() => toggle('event', e.id)} />{e.title}<em className={`sev-${e.severity}`}>{e.severity}</em></label>)}</div>
    </div>
    <div className="creator-note">
      <textarea placeholder="交接备注（未完成动作说明、口头交代等）" value={note} onChange={e => setNote(e.target.value)} rows={2} />
      <label className="restricted-toggle"><input type="checkbox" checked={restricted} onChange={e => setRestricted(e.target.checked)} />敏感备注（接班人不可见，仅交班人/主管可见）</label>
    </div>
    <div className="creator-actions">
      <span className="muted">已选 {picked.length} 个范围</span>
      <button className="primary-action" disabled={busy} onClick={() => void submit()}>{busy ? '生成中…' : '冻结快照并生成'}</button>
    </div>
  </div>;
}

/* ---------------- 交接包详情与逐项操作 ---------------- */

function PackageDetail(props: {
  pkg: Pkg; role: Role; busy: boolean; setBusy: (v: boolean) => void;
  overlaps: Overlap[]; repeats: Repeat[]; onAction: (role?: Role) => Promise<void>; setError: (v: string) => void;
}) {
  const { pkg, role, busy, setBusy, overlaps, repeats, onAction, setError } = props;
  const [filter, setFilter] = useState<'all' | Outcome | 'drift'>('all');

  const itemAction = async (item: Item, action: 'confirm' | 'return' | 'supplement', body: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      await api(`/handover/packages/${pkg.id}/items/${item.id}/${action}`, { method: 'POST', body: JSON.stringify(body) }, role);
      await onAction(role);
    } catch (reason) {
      const err = reason as Error & { code?: string };
      if (action === 'confirm' && err.code === 'DRIFT_DETECTED') {
        if (window.confirm(`源数据已变化，需要先核对差异后勾选“已知悉漂移”。\n\n仍要继续确认吗？请先展开该事项的漂移明细。`)) setError('请在该事项上勾选“已知悉源数据漂移”后再确认');
        else setError('');
      } else setError(err.message);
    } finally { setBusy(false); }
  };

  const filtered = useMemo(() => pkg.items.filter(item => {
    if (filter === 'all') return true;
    if (filter === 'drift') return item.drift.changed;
    return item.outcome === filter;
  }), [pkg.items, filter]);

  return <div className="pkg-detail">
    <div className="pkg-detail-head">
      <div>
        <h3>{pkg.title}</h3>
        <small>{pkg.fromShift} → {pkg.toShift} · {pkg.createdBy} 生成于 {fmtTime(pkg.createdAt)} · {pkg.expired ? `已过期（${fmtTime(pkg.expiresAt)}）` : `有效期至 ${fmtTime(pkg.expiresAt)}`}</small>
        <div className="scope-tags">{pkg.scopes.map(s => <span key={`${s.kind}-${s.ref}`} className="scope-tag">{kindLabel[s.kind] ?? s.kind} · {s.ref}</span>)}</div>
      </div>
      <span className={`pkg-status big ${pkg.status}`}>{statusLabel[pkg.status]}</span>
    </div>

    {pkg.warnings.length > 0 && <div className="warning-box">
      {pkg.warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
    </div>}
    {pkg.expired && <div className="expired-box">本交接包已过期，确认 / 退回 / 补充均已锁定；请使用右上方“滚动交接”把未完成事项带入新包。</div>}

    {pkg.notes.length > 0 && <div className="note-box">
      <b>交接备注</b>
      {pkg.notes.map(n => <div key={n.id} className={`note ${n.visibility}`}>
        {n.redacted ? <span className="redacted">🔒 敏感备注：当前视角不可见（仅交班人 / 值班主管可查看）</span> : <>“{n.text}”<small>{n.author} · {shortTime(n.at)}{n.visibility === 'restricted' ? ' · 敏感' : ''}</small></>}
      </div>)}
    </div>}

    <div className="item-filters">
      {([['all', `全部 ${pkg.counts.total}`], ['pending', `待确认 ${pkg.counts.pending}`], ['confirmed', `已确认 ${pkg.counts.confirmed}`], ['returned', `已退回 ${pkg.counts.returned}`], ['drift', `漂移 ${pkg.counts.drift}`]] as ['all' | Outcome | 'drift', string][]).map(([value, label]) =>
        <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
    </div>

    <div className="item-list">
      {filtered.map(item => <ItemRow
        key={item.id} item={item} pkgExpired={pkg.expired} busy={busy}
        overlapPackages={overlaps.find(o => o.objectKind === item.objectKind && o.objectId === item.objectId)?.packages.filter(p => !p.expired && p.packageId !== pkg.id) ?? []}
        repeat={repeats.find(r => r.objectKind === item.objectKind && r.objectId === item.objectId)}
        onAction={itemAction}
      />)}
      {filtered.length === 0 && <div className="empty-hint">当前筛选下没有事项。</div>}
    </div>
  </div>;
}

function ItemRow(props: {
  item: Item; pkgExpired: boolean; busy: boolean;
  overlapPackages: { packageId: string; shift: string; outcome: Outcome; expired: boolean }[];
  repeat?: Repeat;
  onAction: (item: Item, action: 'confirm' | 'return' | 'supplement', body: Record<string, unknown>) => Promise<void>;
}) {
  const { item, pkgExpired, busy, overlapPackages, repeat, onAction } = props;
  const [open, setOpen] = useState(false);
  const [acknowledge, setAcknowledge] = useState(item.acknowledgedDrift);
  const [returnNote, setReturnNote] = useState('');
  const [supplement, setSupplement] = useState('');
  const locked = pkgExpired || item.outcome === 'confirmed';
  const drift = item.drift;

  return <div className={`item-row outcome-${item.outcome} ${drift.changed ? 'has-drift' : ''}`}>
    <div className="item-head" onClick={() => setOpen(v => !v)}>
      <span className={`risk-tag risk-${item.risk}`}>{riskLabel[item.risk]}</span>
      <span className="item-title"><b>{item.title}</b><small>{kindLabel[item.objectKind] ?? item.objectKind} · {item.objectId}{item.carryCount > 0 ? ` · 已跨班 ${item.carryCount} 次` : ''}</small></span>
      {drift.changed && <span className="drift-tag" title={drift.liveMissing ? '源对象已删除' : '源数据已变化'}>{drift.liveMissing ? '源已删除' : drift.eventResolved ? '事件已闭环' : '已漂移'}</span>}
      <span className={`outcome-tag ${item.outcome}`}>{item.outcome === 'confirmed' ? '✓ 已确认' : item.outcome === 'returned' ? '↩ 已退回' : '待确认'}</span>
      <span className="item-caret">{open ? '▾' : '▸'}</span>
    </div>
    {open && <div className="item-body">
      <div className="item-cols">
        <div><b>未完成动作</b><ul>{item.pendingActions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
        <div><b>阻塞原因</b>{item.blockingReasons.length ? <ul className="blockers">{item.blockingReasons.map((a, i) => <li key={i}>{a}</li>)}</ul> : <small>无明确阻塞</small>}</div>
        <div><b>待确认事项</b><ul>{item.confirmPoints.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
      </div>

      {drift.changed && <div className="drift-box">
        <b>源数据变化（快照 → 当前实时数据）</b>
        {drift.liveMissing ? <div className="drift-row danger">源对象在交接包生成后已被删除，确认仅代表知悉该事实，不会恢复任何数据。</div> :
          drift.fields.map(f => <div key={f.field} className="drift-row"><code>{f.field}</code><span>{JSON.stringify(f.from)}</span>→<span>{JSON.stringify(f.to)}</span></div>)}
      </div>}

      {overlapPackages.length > 0 && <div className="overlap-box">⛒ 该对象同时被 {overlapPackages.map(p => p.packageId).join('、')} 覆盖（{overlapPackages.map(p => p.shift).join('；')}），请先协调唯一责任人再确认。</div>}
      {repeat && <div className="repeat-box">⟳ 跨班次重复接管：{repeat.chain.map(c => c.packageId).join(' → ')}，请在补充信息中记录遗留原因。</div>}

      {item.supplements.length > 0 && <div className="supplement-box"><b>现场补充</b>
        {item.supplements.map(s => <div key={s.id}>“{s.text}”<small>{s.author} · {shortTime(s.at)}</small></div>)}
      </div>}

      <div className="item-actions">
        {!pkgExpired && item.outcome === 'pending' && drift.changed && !item.acknowledgedDrift &&
          <label className="ack-line"><input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} />我已逐项核对上述漂移，知悉源数据变化（原始作业状态不会被本次确认修改）</label>}
        <div className="action-buttons">
          {item.outcome === 'pending' && <button className="confirm-btn" disabled={busy || locked || (drift.changed && !acknowledge)}
            onClick={() => void onAction(item, 'confirm', { acknowledgeDrift: drift.changed })}>✓ 逐项确认接管</button>}
          {item.outcome === 'returned' && <button className="confirm-btn" disabled={busy || pkgExpired}
            onClick={() => void onAction(item, 'confirm', { acknowledgeDrift: drift.changed })}>退回后重新确认</button>}
          {item.outcome !== 'confirmed' && !pkgExpired && <details className="return-details">
            <summary>退回交班</summary>
            <textarea placeholder="退回原因（必填）：如现场与描述不符、责任不清…" value={returnNote} onChange={e => setReturnNote(e.target.value)} rows={2} />
            <button disabled={busy || !returnNote.trim()} onClick={() => void onAction(item, 'return', { note: returnNote }).then(() => setReturnNote(''))}>提交退回</button>
          </details>}
          {!pkgExpired && <details className="return-details">
            <summary>补充现场信息</summary>
            <textarea placeholder="记录现场看到的情况，例如设备实际位置、司机反馈…" value={supplement} onChange={e => setSupplement(e.target.value)} rows={2} />
            <button disabled={busy || !supplement.trim()} onClick={() => void onAction(item, 'supplement', { text: supplement }).then(() => setSupplement(''))}>保存补充</button>
          </details>}
          {item.outcome === 'confirmed' && <small className="confirmed-hint">已确认结果不可撤销；如现场仍有变化，请补充信息或由下一班滚动交接。</small>}
        </div>
      </div>
    </div>}
  </div>;
}
