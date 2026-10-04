import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Dashboard = { activeVoyages: number; berthMoves: number; yardUtilization: number; gateQueue: number; pendingTasks: number; blockedTasks: number; reeferAlerts: number; hazmatHolds: number; lateVessels: number };
type Voyage = { id: string; vessel: string; service: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string };
type Container = { id: string; voyageId: string; size: '20'|'40'|'45'; isoType: string; direction: 'import'|'export'|'transshipment'; status: string; weightT: number; reefer: boolean; temperature?: number; hazmatClass?: string; customs: 'released'|'inspection'|'hold'; priority: string; yardSlot: string; appointmentId?: string; lastEvent: string };
type Block = { id: string; zone: string; capacity: number; occupied: number; reeferPlugs: number; usedPlugs: number; hazmatAllowed: boolean; heat: number; utilization: number; freeSlots: number; pressure: string };
type Conflict = { severity: string; appointmentId: string; reason: string };
type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup'|'dropoff'; windowStart: string; windowEnd: string; lane: 'north'|'south'|'rail'; status: string; exception?: string };
type Task = { id: string; kind: string; containerId: string; from: string; to: string; equipmentId?: string; priority: number; score: number; status: string; blockingReasons: string[]; estimatedMinutes: number; scheduledAt: string };
type Equipment = { id: string; name: string; kind: string; status: string; location: string; battery: number; queue: number; movesPerHour: number };
type HandoverSummary = { id: string; title: string; selectorText: string; fromShift: string; toShift: string; createdBy: string; note?: string; noteSensitive: boolean; createdAt: string; expiresAt: string; status: string; total: number; confirmed: number; returned: number; staleCount: number; overlapCount: number };
type Supplement = { at: string; actor: string; text: string; sensitive: boolean };
type HandoverItem = { id: string; objectKind: string; objectId: string; label: string; snapshot: Record<string, unknown>; openActions: string[]; blockingReasons: string[]; riskLevel: string; status: string; confirmedBy?: string; confirmedAt?: string; confirmedWithDrift?: boolean; duplicateTakeover?: boolean; returnedBy?: string; returnReason?: string; supplements: Supplement[]; takeoverOf?: { packageId: string; confirmedBy?: string }; stale: boolean; sourceMissing: boolean; changedFields: string[]; overlapWith: string[] };
type HandoverDetail = { id: string; title: string; selectorText: string; fromShift: string; toShift: string; createdBy: string; note?: string; noteSensitive: boolean; createdAt: string; expiresAt: string; status: string; items: HandoverItem[] };
type UnownedEntry = { packageId: string; packageTitle: string; reason: string; item: HandoverItem };
type Section = 'control'|'containers'|'gate'|'yard'|'tasks'|'handover';
type Editor = { entity: 'container'|'appointment'|'task'; mode: 'create'|'edit'; id?: string; values: Record<string, string|boolean> };

const api = '/api';
const pct = (value: number) => `${Math.round(value * 100)}%`;
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const toLocalInput = (value?: string) => {
  const date = value ? new Date(value) : new Date(Date.now() + 30 * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const defaultValues = (entity: Editor['entity']): Record<string, string|boolean> => {
  if (entity === 'container') return { id: '', voyageId: 'VOY-AX7', size: '40', isoType: '45G1', direction: 'import', status: 'in-yard', weightT: '20', reefer: false, temperature: '4', hazmatClass: '', customs: 'released', priority: 'normal', yardSlot: 'C03-R01-T1' };
  if (entity === 'appointment') return { containerId: '', truckNo: '', driver: '', type: 'pickup', windowStart: toLocalInput(), windowEnd: toLocalInput(new Date(Date.now() + 60 * 60000).toISOString()), lane: 'north' };
  return { kind: 'receive', containerId: '', from: '闸口', to: 'C03-R01-T1', equipmentId: '', priority: '50', scheduledAt: toLocalInput(), estimatedMinutes: '20', status: 'queued' };
};
const handoverStatusText: Record<string, string> = { open: '待接管', partial: '部分确认', acknowledged: '已闭环', expired: '已过期', pending: '待确认', confirmed: '已确认', returned: '已退回' };
const handoverKindText: Record<string, string> = { container: '箱务', appointment: '预约', task: '任务', equipment: '设备' };
const riskText: Record<string, string> = { low: '低', medium: '中', high: '高', critical: '紧急' };
const snapshotText = (snapshot: Record<string, unknown>) => Object.entries(snapshot).slice(0, 6).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

export default function App() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [voyages, setVoyages] = useState<Voyage[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [packages, setPackages] = useState<HandoverSummary[]>([]);
  const [unowned, setUnowned] = useState<UnownedEntry[]>([]);
  const [detail, setDetail] = useState<HandoverDetail>();
  const [selectedPkg, setSelectedPkg] = useState('');
  const [role, setRole] = useState<'dispatcher'|'supervisor'>('dispatcher');
  const [actor, setActor] = useState('接班人·小李');
  const [handoverForm, setHandoverForm] = useState({ selectorType: 'voyage', selectorValue: 'VOY-AX7', title: '', fromShift: '白班', toShift: '夜班', createdBy: '交班调度员', ttlHours: '8', note: '', noteSensitive: false });
  const [supplementFor, setSupplementFor] = useState<{ itemId: string; text: string; sensitive: boolean }>();
  const [tab, setTab] = useState<Section>('control');
  const [selectedVoyage, setSelectedVoyage] = useState('VOY-AX7');
  const [editor, setEditor] = useState<Editor>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [d, v, ctn, b, cf, a, t, e, hp, uo] = await Promise.all([
      request<Dashboard>('/dashboard'), request<Voyage[]>('/voyages'), request<Container[]>('/containers'),
      request<Block[]>('/yard/heatmap'), request<Conflict[]>('/gate/conflicts'), request<Appointment[]>('/gate/appointments'),
      request<Task[]>('/tasks'), request<Equipment[]>('/equipment'),
      request<HandoverSummary[]>(`/handover/packages?role=${role}`), request<UnownedEntry[]>(`/handover/unowned?role=${role}`)
    ]);
    setDashboard(d); setVoyages(v); setContainers(ctn); setBlocks(b); setConflicts(cf); setAppointments(a); setTasks(t); setEquipment(e);
    setPackages(hp); setUnowned(uo);
  }, [role]);
  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }, [load]);
  useEffect(() => {
    if (!selectedPkg) { setDetail(undefined); return; }
    request<HandoverDetail>(`/handover/packages/${selectedPkg}?role=${role}`).then(setDetail).catch(() => setDetail(undefined));
  }, [selectedPkg, role, packages]);

  const mutate = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await load(); setEditor(undefined); setMessage('操作已保存，作业台数据已刷新');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const openCreate = (entity: Editor['entity']) => { setError(''); setEditor({ entity, mode: 'create', values: defaultValues(entity) }); };
  const openEdit = (entity: Editor['entity'], id: string, values: Record<string, string|boolean>) => { setError(''); setEditor({ entity, mode: 'edit', id, values: { ...values } }); };
  const updateField = (key: string, value: string|boolean) => setEditor(current => current ? { ...current, values: { ...current.values, [key]: value } } : current);
  const saveEditor = async (event: FormEvent) => {
    event.preventDefault(); if (!editor) return;
    const { entity, mode, id, values } = editor;
    const payload: Record<string, unknown> = entity === 'container' ? {
      ...(mode === 'create' ? { id: values.id } : {}), voyageId: values.voyageId, size: values.size, isoType: values.isoType,
      direction: values.direction, status: values.status, weightT: Number(values.weightT), reefer: Boolean(values.reefer),
      ...(values.reefer ? { temperature: Number(values.temperature) } : {}), ...(values.hazmatClass ? { hazmatClass: values.hazmatClass } : {}),
      customs: values.customs, priority: values.priority, yardSlot: values.yardSlot
    } : entity === 'appointment' ? {
      containerId: values.containerId, truckNo: values.truckNo, driver: values.driver, type: values.type,
      windowStart: new Date(String(values.windowStart)).toISOString(), windowEnd: new Date(String(values.windowEnd)).toISOString(), lane: values.lane
    } : {
      kind: values.kind, containerId: values.containerId, from: values.from, to: values.to, priority: Number(values.priority),
      scheduledAt: new Date(String(values.scheduledAt)).toISOString(), estimatedMinutes: Number(values.estimatedMinutes),
      ...(values.equipmentId ? { equipmentId: values.equipmentId } : {}), ...(mode === 'edit' ? { status: values.status } : {})
    };
    await mutate(entity === 'container' ? `/containers${mode === 'edit' ? `/${id}` : ''}` : entity === 'appointment' ? `/gate/appointments${mode === 'edit' ? `/${id}` : ''}` : `/tasks${mode === 'edit' ? `/${id}` : ''}`, mode === 'create' ? 'POST' : 'PATCH', payload);
  };
  const remove = async (entity: Editor['entity'], id: string) => {
    if (!window.confirm(`确认删除 ${id}？相关数据的联动处理会写入审计记录。`)) return;
    const path = entity === 'container' ? `/containers/${id}` : entity === 'appointment' ? `/gate/appointments/${id}` : `/tasks/${id}`;
    await mutate(path, 'DELETE');
  };
  const updateAppointmentStatus = async (id: string, status: string) => mutate(`/gate/appointments/${id}`, 'PATCH', { status });
  const assign = async (id: string, equipmentId: string) => equipmentId ? mutate(`/tasks/${id}/assign`, 'PATCH', { equipmentId }) : mutate(`/tasks/${id}`, 'PATCH', { equipmentId: '', status: 'queued' });
  const selectorOptions = handoverForm.selectorType === 'voyage'
    ? voyages.map(voyage => ({ value: voyage.id, label: `${voyage.id} · ${voyage.vessel}` }))
    : handoverForm.selectorType === 'block'
      ? blocks.map(block => ({ value: block.id, label: `${block.id} · ${block.zone}` }))
      : handoverForm.selectorType === 'lane'
        ? [{ value: 'north', label: '北闸口' }, { value: 'south', label: '南闸口' }, { value: 'rail', label: '铁路闸口' }]
        : [{ value: 'exceptions', label: '设备故障 / 阻塞任务 / 海关扣留等异常' }];
  const generateHandover = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const created = await request<HandoverDetail>('/handover/packages', { method: 'POST', body: JSON.stringify({
        ...(handoverForm.title ? { title: handoverForm.title } : {}),
        selector: { type: handoverForm.selectorType, value: handoverForm.selectorValue },
        fromShift: handoverForm.fromShift, toShift: handoverForm.toShift, createdBy: handoverForm.createdBy,
        ttlMinutes: Number(handoverForm.ttlHours) * 60,
        ...(handoverForm.note ? { note: handoverForm.note } : {}), noteSensitive: handoverForm.noteSensitive
      })});
      await load(); setSelectedPkg(created.id); setMessage(`交接包 ${created.id} 已生成，覆盖 ${created.items.length} 个对象`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '生成交接包失败'); }
    finally { setBusy(false); }
  };
  const itemAction = async (itemId: string, action: 'confirm'|'return'|'supplement', body?: unknown) => {
    if (!detail) return;
    setBusy(true); setError('');
    try {
      await request(`/handover/packages/${detail.id}/items/${itemId}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
      await load(); setSupplementFor(undefined); setMessage('交接状态已更新，原始作业数据未受影响');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const confirmHandoverItem = (itemId: string) => void itemAction(itemId, 'confirm', { actor });
  const returnHandoverItem = (itemId: string) => {
    const reason = window.prompt('请输入退回原因（将写入交接审计）');
    if (reason) void itemAction(itemId, 'return', { actor, reason });
  };
  const submitSupplement = (event: FormEvent) => {
    event.preventDefault();
    if (supplementFor) void itemAction(supplementFor.itemId, 'supplement', { actor, text: supplementFor.text, sensitive: supplementFor.sensitive });
  };
  const selected = voyages.find(voyage => voyage.id === selectedVoyage);
  const remaining = selected ? selected.movesPlanned - selected.movesDone : 0;
  const maxHeat = useMemo(() => Math.max(...blocks.map(block => block.heat), 1), [blocks]);

  if (!dashboard && error) return <main className="connection-error"><div className="eyebrow">API CONNECTION ERROR</div><h1>无法连接港口作业服务</h1><p>{error}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5178 和 API 4107 均已启动。</p><button onClick={() => { setError(''); void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }}>重新连接</button></main>;
  if (!dashboard) return <div className="loading">正在连接码头实时作业中台…</div>;

  return <main>
    <header><div><div className="eyebrow">PORT OPS / YARD & GATE CONTROL</div><h1>HarborGrid <span>港口集装箱堆场协同与闸口调度</span></h1><p>把船期、箱务、堆场容量、危险品/冷藏约束、闸口预约与场内设备任务放在同一条作业链路上。</p></div><div className="header-right"><span className="live"><i/> TOS LINKED</span><span className="clock">LIVE · {new Date().toLocaleTimeString()}</span></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}{error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <section className="kpis"><div><small>ACTIVE VESSELS</small><b>{dashboard.activeVoyages}<em> 艘</em></b><span>{dashboard.lateVessels} 艘存在延误风险</span></div><div><small>YARD UTILIZATION</small><b>{pct(dashboard.yardUtilization)}</b><span>可用堆位 / 危险品隔离纳管</span></div><div><small>GATE QUEUE</small><b>{dashboard.gateQueue}<em> 车</em></b><span>预约、已进场与车道排队</span></div><div><small>EXCEPTIONS</small><b>{dashboard.blockedTasks + dashboard.reeferAlerts + dashboard.hazmatHolds}<em> 项</em></b><span>{dashboard.blockedTasks} 作业阻塞 · {dashboard.reeferAlerts} 冷藏告警</span></div></section>
    <nav className="tabs"><button className={tab==='control'?'active':''} onClick={() => setTab('control')}>作业驾驶舱</button><button className={tab==='containers'?'active':''} onClick={() => setTab('containers')}>箱务台账 / CRUD</button><button className={tab==='gate'?'active':''} onClick={() => setTab('gate')}>闸口预约</button><button className={tab==='yard'?'active':''} onClick={() => setTab('yard')}>堆场热区</button><button className={tab==='tasks'?'active':''} onClick={() => setTab('tasks')}>设备任务</button><button className={tab==='handover'?'active':''} onClick={() => setTab('handover')}>班次交接{unowned.length>0?` · ${unowned.length} 无人负责`:''}</button><span>最后同步 {new Date().toLocaleTimeString()}</span></nav>
    {tab === 'control' && <div className="layout"><section className="panel vessel-panel"><div className="panel-head"><div><div className="eyebrow">VESSEL WINDOW / 船期窗口</div><h2>泊位作业进度</h2></div><span className="muted">剩余作业动态计算</span></div>{voyages.map(voyage => <button key={voyage.id} className={`vessel ${selectedVoyage===voyage.id?'selected':''}`} onClick={() => setSelectedVoyage(voyage.id)}><span className={`vessel-dot ${voyage.status}`}/><span className="vessel-main"><b>{voyage.vessel}</b><small>{voyage.id} · {voyage.service} · {voyage.berth}</small><i><em style={{ width: `${Math.min(100, voyage.movesDone / voyage.movesPlanned * 100)}%` }}/></i></span><span className="vessel-move"><b>{voyage.movesDone.toLocaleString()}</b><small>/ {voyage.movesPlanned.toLocaleString()} moves</small></span><strong className={voyage.lateRisk}>{voyage.lateRisk==='high'?'HIGH':voyage.lateRisk==='medium'?'WATCH':'ON TIME'}</strong></button>)}</section><section className="panel focus-panel"><div className="panel-head"><div><div className="eyebrow">SELECTED VOYAGE / {selected?.id}</div><h2>{selected?.vessel}</h2></div><span className={`badge ${selected?.lateRisk}`}>{selected?.status}</span></div><div className="voyage-stats"><div><small>ETA</small><b>{selected&&time(selected.eta)}</b><span>预计靠泊</span></div><div><small>ETD</small><b>{selected&&time(selected.etd)}</b><span>计划离港</span></div><div><small>REMAINING</small><b>{remaining}</b><span>剩余翻箱</span></div></div><div className="berth-map"><div className="water"><span>岸线 / BERTH</span><i className="ship" style={{ left: `${selected?.berth==='B07'?50:24}%` }}>{selected?.vessel}</i><b>B01</b><b>B04</b><b>B07</b><b>B10</b></div></div><div className="callout"><strong>调度策略</strong><span>已把 {dashboard.blockedTasks} 个阻塞任务、{dashboard.gateQueue} 车闸口压力纳入当前窗口；优先保护冷藏与危险品安全约束。</span></div></section><section className="panel wide"><div className="panel-head"><h3>异常与联动信号</h3><span>{conflicts.length} gate conflicts detected</span></div><div className="signal-grid"><div><strong className="critical">{dashboard.blockedTasks}</strong><span>设备/约束阻塞</span><small>最高优先级：海关查验任务</small></div><div><strong className="warning">{conflicts.length}</strong><span>闸口预约冲突</span><small>同车重叠窗口需人工重排</small></div><div><strong className="warning">{dashboard.reeferAlerts}</strong><span>冷藏与温控风险</span><small>查验区电源余量接近阈值</small></div><div><strong className="ok">{equipment.filter(item => item.status==='available').length}</strong><span>可调度设备</span><small>场桥 / 正面吊 / 集卡</small></div></div></section></div>}
    {tab === 'containers' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">CONTAINER REGISTER / CRUD</div><h2>箱务台账</h2><span className="muted">新增、查询、编辑、删除；危险品与冷藏箱受堆场约束校验</span></div><button className="primary-action" onClick={() => openCreate('container')}>＋ 新增箱务</button></div><div className="table container-table"><div className="tr th"><span>箱号 / 航次</span><span>尺寸 / 流向</span><span>箱况 / 海关</span><span>堆位</span><span>重量 / 属性</span><span>操作</span></div>{containers.map(container => <div className="tr" key={container.id}><span><b>{container.id}</b><small>{container.voyageId} · {container.lastEvent}</small></span><span>{container.size}ft · {container.direction}<small>{container.isoType}</small></span><span><b>{container.status}</b><small>海关：{container.customs}</small></span><span>{container.yardSlot}</span><span>{container.weightT}t<small>{container.reefer?`冷藏 ${container.temperature}°C`:container.hazmatClass?`危险品 ${container.hazmatClass} 类`:'普通箱'}</small></span><span className="row-actions"><button onClick={() => openEdit('container', container.id, { ...container, weightT: String(container.weightT), temperature: String(container.temperature ?? 4), hazmatClass: container.hazmatClass ?? '' })}>编辑</button><button className="danger-action" onClick={() => void remove('container', container.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'gate' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">GATE APPOINTMENT / SLOT CONTROL</div><h2>闸口预约与车道状态</h2><span className="muted">支持新增预约、编辑时隙、签到/完成和删除</span></div><button className="primary-action" onClick={() => openCreate('appointment')}>＋ 新增预约</button></div>{conflicts.map(conflict => <div className="conflict" key={`${conflict.appointmentId}-${conflict.reason}`}><strong>{conflict.severity}</strong><b>{conflict.appointmentId}</b><span>{conflict.reason}</span></div>)}<div className="table"><div className="tr th"><span>预约</span><span>箱号 / 车辆</span><span>窗口</span><span>车道</span><span>状态</span><span>操作</span></div>{appointments.map(appointment => <div className="tr" key={appointment.id}><span><b>{appointment.id}</b><small>{appointment.type}</small></span><span><b>{appointment.containerId}</b><small>{appointment.truckNo} · {appointment.driver}</small></span><span>{time(appointment.windowStart)}—{time(appointment.windowEnd)}</span><span>{appointment.lane}</span><span className={`pill ${appointment.status}`}>{appointment.status}</span><span className="row-actions">{appointment.status==='booked'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'checked-in')}>签到</button>:appointment.status==='checked-in'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'completed')}>完成</button>:null}<button onClick={() => openEdit('appointment', appointment.id, { ...appointment, windowStart: toLocalInput(appointment.windowStart), windowEnd: toLocalInput(appointment.windowEnd) })}>编辑</button><button className="danger-action" onClick={() => void remove('appointment', appointment.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'yard' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">YARD HEATMAP / STACK DENSITY</div><h2>堆场容量与安全约束</h2></div><span className="muted">实时区块压力</span></div><div className="yard-grid">{blocks.map(block => <div className={`block ${block.pressure}`} key={block.id}><div className="block-top"><b>{block.id}</b><strong>{pct(block.utilization)}</strong></div><span>{block.zone}</span><div className="heat"><i style={{ width: `${block.heat / maxHeat * 100}%` }}/></div><div className="block-stats"><span>空位 {block.freeSlots}</span><span>冷插 {block.usedPlugs}/{block.reeferPlugs}</span><span>{block.hazmatAllowed?'危险品可入':'普通区'}</span></div></div>)}</div><div className="yard-note"><span>堆位推荐会同时考虑容量、热区、危险品隔离、冷藏插座和设备可达性。</span><b>A01 → C03 重排建议可释放 21 个低热度堆位</b></div></section>}
    {tab === 'tasks' && <div className="layout"><section className="panel wide"><div className="panel-head"><div><div className="eyebrow">TASK DISPATCH / EQUIPMENT POOL</div><h2>场内任务优先级与设备指派</h2><span className="muted">支持新增、编辑、删除和设备指派</span></div><button className="primary-action" onClick={() => openCreate('task')}>＋ 新建任务</button></div><div className="table task-table"><div className="tr th"><span>任务</span><span>箱号</span><span>路径</span><span>优先级</span><span>状态</span><span>设备 / 操作</span></div>{tasks.map(task => <div className="tr" key={task.id}><span><b>{task.id}</b><small>{task.kind} · {task.estimatedMinutes}min</small></span><span>{task.containerId}</span><span>{task.from} → {task.to}</span><span className={task.score>95?'critical':''}>{task.score}</span><span><span className={`pill ${task.status}`}>{task.status}</span>{task.blockingReasons.length>0&&<small className="blocked-text">{task.blockingReasons[0]}</small>}</span><span className="task-actions"><select value={task.equipmentId??''} onChange={event => void assign(task.id, event.target.value)}><option value="">未指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => openEdit('task', task.id, { kind: task.kind, containerId: task.containerId, from: task.from, to: task.to, equipmentId: task.equipmentId ?? '', priority: String(task.priority), estimatedMinutes: String(task.estimatedMinutes), scheduledAt: toLocalInput(task.scheduledAt), status: task.status })}>编辑</button><button className="danger-action" onClick={() => void remove('task', task.id)}>删除</button></span></div>)}</div></section><section className="panel"><div className="panel-head"><h3>设备池</h3><span>{equipment.length} assets</span></div>{equipment.map(item => <div className="equipment" key={item.id}><i className={`equip-dot ${item.status}`}/><div><b>{item.name}</b><small>{item.location} · 队列 {item.queue}</small></div><strong>{item.battery}%</strong></div>)}</section></div>}
    {tab === 'handover' && <div className="layout">
      <section className={`panel wide ${unowned.length?'unowned-panel':''}`}><div className="panel-head"><div><div className="eyebrow">UNOWNED / 责任真空监控</div><h2>仍无人负责的事项</h2><span className="muted">交接包过期未确认、或被接班人退回的对象会留在这里，直到有人接管</span></div><span className={unowned.length?'unowned-count':'muted'}>{unowned.length} 项</span></div>
        {unowned.length===0 && <p className="muted">当前没有责任真空事项，所有交接对象均有明确归属。</p>}
        {unowned.map(entry => <div className="conflict" key={`${entry.packageId}-${entry.item.id}`}><strong>{riskText[entry.item.riskLevel] ?? entry.item.riskLevel}</strong><b>{entry.item.objectId}</b><span>{handoverKindText[entry.item.objectKind]} · {entry.reason} · 来自 {entry.packageId}（{entry.packageTitle}）</span></div>)}
      </section>
      <section className="panel"><div className="panel-head"><div><div className="eyebrow">SHIFT HANDOVER / 生成交接包</div><h2>按范围打包交接对象</h2></div></div>
        <form className="form-grid handover-form" onSubmit={generateHandover}>
          <label>交接范围<select value={handoverForm.selectorType} onChange={event => setHandoverForm(form => ({ ...form, selectorType: event.target.value, selectorValue: '' }))}><option value="voyage">按航次</option><option value="block">按堆场区块</option><option value="lane">按闸口车道</option><option value="event">按异常事件</option></select></label>
          <label>交接对象<select required value={handoverForm.selectorValue} onChange={event => setHandoverForm(form => ({ ...form, selectorValue: event.target.value }))}><option value="">请选择</option>{selectorOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>交接包标题<input placeholder="留空则自动生成" value={handoverForm.title} onChange={event => setHandoverForm(form => ({ ...form, title: event.target.value }))}/></label>
          <label>交班人<input required value={handoverForm.createdBy} onChange={event => setHandoverForm(form => ({ ...form, createdBy: event.target.value }))}/></label>
          <label>交班班次<input required value={handoverForm.fromShift} onChange={event => setHandoverForm(form => ({ ...form, fromShift: event.target.value }))}/></label>
          <label>接班班次<input required value={handoverForm.toShift} onChange={event => setHandoverForm(form => ({ ...form, toShift: event.target.value }))}/></label>
          <label>有效期（小时）<input type="number" min="1" max="24" required value={handoverForm.ttlHours} onChange={event => setHandoverForm(form => ({ ...form, ttlHours: event.target.value }))}/></label>
          <label>交班备注<input placeholder="可标记为敏感，仅值班经理可见" value={handoverForm.note} onChange={event => setHandoverForm(form => ({ ...form, note: event.target.value }))}/></label>
          <label className="check-label"><input type="checkbox" checked={handoverForm.noteSensitive} onChange={event => setHandoverForm(form => ({ ...form, noteSensitive: event.target.checked }))}/>敏感备注</label>
          <div className="modal-actions handover-actions"><button className="primary-action" disabled={busy}>{busy?'生成中…':'生成交接包'}</button></div>
        </form>
        <div className="callout handover-callout"><strong>身份与权限</strong><span>当前身份：</span><select value={role} onChange={event => setRole(event.target.value as 'dispatcher'|'supervisor')}><option value="dispatcher">接班人（普通调度）</option><option value="supervisor">值班经理</option></select><span>接班人姓名：</span><input className="actor-input" value={actor} onChange={event => setActor(event.target.value)}/></div>
        <div className="callout"><strong>交接规则</strong><span>确认 / 退回 / 补充只写入交接记录，不会改变箱务、预约、任务等原始作业状态；源数据在生成后发生变化的事项会被标记漂移。</span></div>
      </section>
      <section className="panel"><div className="panel-head"><div><div className="eyebrow">PACKAGES / 交接包列表</div><h2>本班交接包</h2></div><span className="muted">{packages.length} 个</span></div>
        {packages.length===0 && <p className="muted">还没有交接包，请先在左侧生成。</p>}
        {packages.map(pkg => <button key={pkg.id} className={`pkg-card ${selectedPkg===pkg.id?'selected':''}`} onClick={() => setSelectedPkg(pkg.id)}>
          <span className="pkg-title"><b>{pkg.title}</b><small>{pkg.id} · {pkg.selectorText} · {pkg.fromShift}→{pkg.toShift} · {pkg.createdBy}</small></span>
          <span className="pkg-meta"><span className={`pill ${pkg.status}`}>{handoverStatusText[pkg.status]}</span><small>{pkg.confirmed}/{pkg.total} 已确认</small>{pkg.returned>0 && <small className="tag returned">{pkg.returned} 退回</small>}{pkg.staleCount>0 && <small className="tag stale">{pkg.staleCount} 漂移</small>}{pkg.overlapCount>0 && <small className="tag overlap">{pkg.overlapCount} 对象重叠</small>}<small>到期 {time(pkg.expiresAt)}</small></span>
          {pkg.note && <small className="pkg-note">备注：{pkg.note}</small>}
        </button>)}
      </section>
      {detail && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">PACKAGE {detail.id} / {detail.selectorText}</div><h2>{detail.title}</h2><span className="muted">{detail.createdBy} 创建于 {time(detail.createdAt)} · {detail.fromShift} → {detail.toShift} · 到期 {time(detail.expiresAt)}</span>{detail.note && <span className="pkg-note">交班备注：{detail.note}</span>}</div><span className={`pill ${detail.status}`}>{handoverStatusText[detail.status]}</span></div>
        {detail.status==='expired' && <div className="conflict"><strong>expired</strong><b>交接包已过期</b><span>未确认事项已转入「仍无人负责」清单，需值班经理重新生成交接包。</span></div>}
        {detail.items.map(item => <div className={`handover-item ${item.status}`} key={item.id}>
          <div className="item-head"><span className="kind-tag">{handoverKindText[item.objectKind]}</span><b>{item.objectId}</b><span className={`risk-tag ${item.riskLevel}`}>{riskText[item.riskLevel]}风险</span>
            {item.stale && <span className="tag stale">源数据已变化：{item.changedFields.join('、')}</span>}
            {item.sourceMissing && <span className="tag stale">源记录已删除</span>}
            {item.overlapWith.length>0 && <span className="tag overlap">同时被 {item.overlapWith.join('、')} 覆盖</span>}
            {item.takeoverOf && <span className="tag takeover">重复接管：{item.takeoverOf.packageId} 已由 {item.takeoverOf.confirmedBy} 确认</span>}
            <span className={`pill ${item.status}`}>{handoverStatusText[item.status]}</span></div>
          <div className="item-body">
            <div><small>未完成动作</small>{item.openActions.length?item.openActions.map(action => <span className="line" key={action}>· {action}</span>):<span className="line muted">无</span>}</div>
            <div><small>阻塞原因</small>{item.blockingReasons.length?item.blockingReasons.map(reason => <span className="line blocked-text" key={reason}>· {reason}</span>):<span className="line muted">无</span>}</div>
            <div><small>生成时快照</small><span className="line snapshot">{snapshotText(item.snapshot)}</span></div>
            {item.supplements.length>0 && <div><small>现场补充</small>{item.supplements.map((entry, index) => <span className="line" key={index}>· [{entry.actor} {time(entry.at)}] {entry.text}{entry.sensitive?' 🔒':''}</span>)}</div>}
            {item.status==='confirmed' && <div><small>确认信息</small><span className="line ok-text">· {item.confirmedBy} 于 {item.confirmedAt?time(item.confirmedAt):''} 确认{item.confirmedWithDrift?'（确认时源数据已漂移）':''}{item.duplicateTakeover?'（跨班次重复接管）':''}</span></div>}
            {item.status==='returned' && <div><small>退回信息</small><span className="line blocked-text">· {item.returnedBy} 退回：{item.returnReason}</span></div>}
          </div>
          {item.status!=='confirmed' && detail.status!=='expired' && <div className="item-actions">
            <button className="primary-action" disabled={busy} onClick={() => confirmHandoverItem(item.id)}>确认接管</button>
            <button className="danger-action" disabled={busy} onClick={() => returnHandoverItem(item.id)}>退回</button>
            <button disabled={busy} onClick={() => setSupplementFor({ itemId: item.id, text: '', sensitive: false })}>补充现场信息</button>
            {supplementFor?.itemId===item.id && <form className="supplement-form" onSubmit={submitSupplement}><input required placeholder="补充现场情况，如查验进度、设备恢复时间" value={supplementFor.text} onChange={event => setSupplementFor(current => current ? { ...current, text: event.target.value } : current)}/><label className="check-label"><input type="checkbox" checked={supplementFor.sensitive} onChange={event => setSupplementFor(current => current ? { ...current, sensitive: event.target.checked } : current)}/>敏感</label><button className="primary-action" disabled={busy}>提交</button><button type="button" onClick={() => setSupplementFor(undefined)}>取消</button></form>}
          </div>}
        </div>)}
      </section>}
    </div>}
    <footer>HarborGrid · 内存种子数据 + REST API · 箱务台账、闸口预约、场内任务提供完整增删改查操作 · 班次交接包支持快照、漂移检测与责任真空监控</footer>
    {editor && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setEditor(undefined); }}><form className="editor-modal" onSubmit={saveEditor}><div className="modal-head"><div><div className="eyebrow">{editor.mode.toUpperCase()} / {editor.entity.toUpperCase()}</div><h2>{editor.mode==='create'?'创建':'编辑'}{editor.entity==='container'?'箱务记录':editor.entity==='appointment'?'闸口预约':'作业任务'}</h2></div><button type="button" className="icon-button" onClick={() => setEditor(undefined)}>×</button></div>
      {editor.entity === 'container' && <div className="form-grid">
        <label>集装箱号<input required disabled={editor.mode==='edit'} value={String(editor.values.id)} onChange={event => updateField('id', event.target.value.toUpperCase())}/></label>
        <label>关联航次<select value={String(editor.values.voyageId)} onChange={event => updateField('voyageId', event.target.value)}>{voyages.filter(voyage => voyage.status!=='departed').map(voyage => <option key={voyage.id} value={voyage.id}>{voyage.id} · {voyage.vessel}</option>)}</select></label>
        <label>尺寸<select value={String(editor.values.size)} onChange={event => updateField('size', event.target.value)}><option value="20">20 ft</option><option value="40">40 ft</option><option value="45">45 ft</option></select></label>
        <label>ISO 箱型<input required value={String(editor.values.isoType)} onChange={event => updateField('isoType', event.target.value)}/></label>
        <label>作业流向<select value={String(editor.values.direction)} onChange={event => updateField('direction', event.target.value)}><option value="import">进口</option><option value="export">出口</option><option value="transshipment">中转</option></select></label>
        <label>箱状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['in-transit','at-gate','in-yard','on-quay','released','hold'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>重量 (吨)<input type="number" min="0.1" step="0.1" required value={String(editor.values.weightT)} onChange={event => updateField('weightT', event.target.value)}/></label>
        <label>海关状态<select value={String(editor.values.customs)} onChange={event => updateField('customs', event.target.value)}><option value="released">已放行</option><option value="inspection">查验中</option><option value="hold">扣留</option></select></label>
        <label>优先级<select value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}><option value="normal">普通</option><option value="hot">急箱</option><option value="reefer">冷藏</option><option value="hazmat">危险品</option></select></label>
        <label>堆位<input required placeholder="例如 B07-R03-T2" value={String(editor.values.yardSlot)} onChange={event => updateField('yardSlot', event.target.value.toUpperCase())}/></label>
        <label>危险品类别<input placeholder="非危险品留空" value={String(editor.values.hazmatClass)} onChange={event => updateField('hazmatClass', event.target.value)}/></label>
        <label className="check-label"><input type="checkbox" checked={Boolean(editor.values.reefer)} onChange={event => updateField('reefer', event.target.checked)}/>冷藏箱</label>
        {Boolean(editor.values.reefer) && <label>目标温度 (°C)<input type="number" step="0.1" value={String(editor.values.temperature)} onChange={event => updateField('temperature', event.target.value)}/></label>}
      </div>}
      {editor.entity === 'appointment' && <div className="form-grid">
        <label>集装箱<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id} · {container.status}</option>)}</select></label>
        <label>预约类型<select value={String(editor.values.type)} onChange={event => updateField('type', event.target.value)}><option value="pickup">提箱</option><option value="dropoff">进场</option></select></label>
        <label>车牌号<input required value={String(editor.values.truckNo)} onChange={event => updateField('truckNo', event.target.value)}/></label><label>司机<input required value={String(editor.values.driver)} onChange={event => updateField('driver', event.target.value)}/></label>
        <label>窗口开始<input type="datetime-local" required value={String(editor.values.windowStart)} onChange={event => updateField('windowStart', event.target.value)}/></label><label>窗口结束<input type="datetime-local" required value={String(editor.values.windowEnd)} onChange={event => updateField('windowEnd', event.target.value)}/></label>
        <label>闸口车道<select value={String(editor.values.lane)} onChange={event => updateField('lane', event.target.value)}><option value="north">北闸口</option><option value="south">南闸口</option><option value="rail">铁路闸口</option></select></label>
      </div>}
      {editor.entity === 'task' && <div className="form-grid">
        <label>任务类型<select value={String(editor.values.kind)} onChange={event => updateField('kind', event.target.value)}>{['receive','deliver','rehandle','load','discharge','inspect'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>关联箱号<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id}</option>)}</select></label>
        <label>起点<input required value={String(editor.values.from)} onChange={event => updateField('from', event.target.value)}/></label><label>终点<input required value={String(editor.values.to)} onChange={event => updateField('to', event.target.value)}/></label>
        <label>优先级 (1–100)<input type="number" min="1" max="100" required value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}/></label><label>预计时长 (分钟)<input type="number" min="1" required value={String(editor.values.estimatedMinutes)} onChange={event => updateField('estimatedMinutes', event.target.value)}/></label>
        <label>计划时间<input type="datetime-local" required value={String(editor.values.scheduledAt)} onChange={event => updateField('scheduledAt', event.target.value)}/></label><label>指派设备<select value={String(editor.values.equipmentId)} onChange={event => updateField('equipmentId', event.target.value)}><option value="">暂不指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
        {editor.mode==='edit' && <label>任务状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['queued','assigned','executing','blocked','done'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      </div>}
      {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" onClick={() => setEditor(undefined)}>取消</button><button className="primary-action" disabled={busy}>{busy?'保存中…':'保存'}</button></div>
    </form></div>}
  </main>;
}
