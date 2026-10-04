import { appointments, auditEvents, blocks, containers, equipment, tasks, voyages } from './domain.js';
import type { Container, Equipment, GateAppointment, Voyage, YardBlock, YardTask } from './domain.js';

/* ------------------------------------------------------------------ */
/* 班次交接包模块                                                        */
/* 设计要点：                                                            */
/* 1. 交接包只持有生成时刻的快照，所有确认/退回/补充只写交接包自身，       */
/*    绝不回写箱务/预约/任务/设备的原始作业状态；                          */
/* 2. 每次查看时用实时数据与快照比对，得到漂移（源数据变化）结论；          */
/* 3. 覆盖、过期、滚动交接、无人负责等结论全部由交接包集合派生，可重算。   */
/* ------------------------------------------------------------------ */

export type ObjectKind = 'voyage' | 'container' | 'task' | 'appointment' | 'block' | 'equipment' | 'event';
export type ScopeKind = 'voyage' | 'block' | 'gate-lane' | 'event' | 'rollover';
export type Risk = 'low' | 'medium' | 'high';
export type ItemOutcome = 'pending' | 'confirmed' | 'returned';
export type PackageStatus = 'active' | 'in-progress' | 'confirmed' | 'expired';
export type NoteVisibility = 'internal' | 'restricted';
export type HandoverRole = 'outgoing' | 'incoming' | 'supervisor';

export interface HandoverScope { kind: ScopeKind; ref: string; label: string; }
export interface HandoverNote { id: string; at: string; author: string; text: string; visibility: NoteVisibility; }
export interface ItemSupplement { id: string; at: string; author: string; text: string; }
export interface ItemHistoryEntry { at: string; actor: string; action: string; note?: string; }
export interface FieldChange { field: string; from: unknown; to: unknown; }
export interface DriftInfo { changed: boolean; liveMissing: boolean; eventResolved: boolean; fields: FieldChange[]; }

export interface HandoverItem {
  id: string;
  objectKind: ObjectKind;
  objectId: string;
  title: string;
  /** 生成时刻的冻结快照，之后不再修改 */
  snapshot: Record<string, unknown>;
  pendingActions: string[];
  blockingReasons: string[];
  confirmPoints: string[];
  risk: Risk;
  outcome: ItemOutcome;
  /** 接班人确认“已知悉源数据变化”后置真，不代表漂移消失 */
  acknowledgedDrift: boolean;
  supplements: ItemSupplement[];
  history: ItemHistoryEntry[];
  /** 该对象此前已被多少个交接包接管过（跨班次重复接管） */
  carryCount: number;
  carriedChain: string[];
  addedAt: string;
}

export interface PackageTimelineEntry { at: string; actor: string; text: string; }

export interface HandoverPackage {
  id: string;
  title: string;
  fromShift: string;
  toShift: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  scopes: HandoverScope[];
  items: HandoverItem[];
  notes: HandoverNote[];
  warnings: string[];
  timeline: PackageTimelineEntry[];
  predecessorIds: string[];
}

export interface CreatePackageInput {
  title?: string;
  fromShift?: string;
  toShift?: string;
  createdBy?: string;
  ttlMinutes?: number;
  expiresAt?: string;
  scopes: { kind: ScopeKind; ref: string }[];
  notes?: { text: string; visibility?: NoteVisibility }[];
}

const handoverPackages: HandoverPackage[] = [];

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/* 测试用时钟接缝：生产环境永远走 Date.now() */
let nowOverride: number | undefined;
export function __setHandoverNow(value?: number) { nowOverride = value; }
const now = () => new Date(nowOverride ?? Date.now());
const nowIso = () => now().toISOString();

/* 测试用：清空交接包集合（不触碰任何原始作业数据） */
export function __resetHandoverPackages() { handoverPackages.length = 0; }

function recordAudit(action: string, entityId: string, details: string, actor = '中控调度员') {
  auditEvents.unshift({ id: nextId('AUD'), actor, action, entity: 'handover-package', entityId, at: nowIso(), details });
}

/* ---------------- 快照与实时对象构建 ---------------- */

type Snapshot = Record<string, unknown>;
interface ObjectDef {
  kind: ObjectKind;
  id: string;
  title: string;
  snapshot: Snapshot;
  pendingActions: string[];
  blockingReasons: string[];
  confirmPoints: string[];
  risk: Risk;
}

const laneLabels: Record<string, string> = { north: '北闸口', south: '南闸口', rail: '铁路闸口' };
const parseSlotBlock = (slot: string) => slot.match(/^([A-Z]\d\d)-/)?.[1];
const maxRisk = (...levels: Risk[]): Risk => levels.includes('high') ? 'high' : levels.includes('medium') ? 'medium' : 'low';

function linkedAppointment(container: Container) { return container.appointmentId ? appointments.find(a => a.id === container.appointmentId) : undefined; }
function openTasksOf(containerId: string) { return tasks.filter(t => t.containerId === containerId && t.status !== 'done'); }

function voyageDef(voyage: Voyage): ObjectDef {
  const remaining = voyage.movesPlanned - voyage.movesDone;
  const pendingActions = voyage.status === 'departed' ? [] : [
    remaining > 0 ? `跟进剩余 ${remaining} 个装卸作业` : '确认离港手续',
    ...(voyage.lateRisk !== 'low' ? ['跟踪航速/泊位窗口变化，及时重排作业计划'] : []),
  ];
  const confirmPoints = voyage.status === 'departed' ? [] : [
    `泊位 ${voyage.berth} 窗口是否仍然有效`,
    ...(voyage.lateRisk !== 'low' ? ['延误风险等级是否需要升降级'] : []),
    '船图/作业量是否有临时调整',
  ];
  return {
    kind: 'voyage', id: voyage.id, title: `${voyage.vessel} · ${voyage.id}`,
    snapshot: { id: voyage.id, vessel: voyage.vessel, status: voyage.status, berth: voyage.berth, movesPlanned: voyage.movesPlanned, movesDone: voyage.movesDone, lateRisk: voyage.lateRisk, eta: voyage.eta, etd: voyage.etd },
    pendingActions, blockingReasons: [], confirmPoints, risk: voyage.lateRisk === 'high' ? 'high' : voyage.lateRisk === 'medium' ? 'medium' : 'low',
  };
}

function containerDef(container: Container): ObjectDef {
  const voyage = voyages.find(v => v.id === container.voyageId);
  const blockedTask = openTasksOf(container.id).find(t => t.status === 'blocked');
  const blockingReasons: string[] = [];
  if (container.customs === 'hold') blockingReasons.push('海关扣留，未放行');
  else if (container.customs === 'inspection') blockingReasons.push('海关查验中，不能提箱/装船');
  if (blockedTask) blockingReasons.push(...blockedTask.blockingReasons);
  const pendingActions: string[] = [];
  if (container.customs !== 'released') pendingActions.push('跟进海关查验/放行结果');
  if (container.status === 'at-gate') pendingActions.push('完成闸口核验并安排进场落位');
  if (container.reefer) pendingActions.push(`持续监控冷藏温度（设定 ${container.temperature ?? '?'}°C）与插座供电`);
  if (container.hazmatClass) pendingActions.push(`核对危险品 ${container.hazmatClass} 类隔离堆存要求`);
  if (container.priority === 'hot') pendingActions.push('急箱优先安排作业动线');
  openTasksOf(container.id).forEach(t => pendingActions.push(`任务 ${t.id}（${t.status}）按计划推进`));
  const apt = linkedAppointment(container);
  if (apt && apt.status !== 'completed' && apt.status !== 'cancelled') pendingActions.push(`跟进闸口预约 ${apt.id}（${apt.status}）`);
  if (!pendingActions.length) pendingActions.push('保持常规盯控');
  const confirmPoints = [
    container.customs !== 'released' ? `海关状态 ${container.customs} 是否已更新` : '海关放行状态保持有效',
    ...(container.reefer ? ['冷藏温度回传是否正常、插座是否占用'] : []),
    ...(container.hazmatClass ? ['危险品单证与隔离措施是否齐备'] : []),
    `堆位 ${container.yardSlot} 是否与实物一致`,
  ];
  const risk = maxRisk(
    container.customs !== 'released' ? 'high' : 'low',
    container.reefer && container.customs === 'inspection' ? 'high' : 'low',
    blockedTask ? 'high' : 'low',
    container.priority === 'hot' ? 'medium' : 'low',
  );
  return {
    kind: 'container', id: container.id, title: `箱 ${container.id} · ${container.yardSlot}`,
    snapshot: { id: container.id, voyageId: container.voyageId, status: container.status, customs: container.customs, priority: container.priority, yardSlot: container.yardSlot, reefer: container.reefer, temperature: container.temperature ?? null, hazmatClass: container.hazmatClass ?? null, weightT: container.weightT, appointmentId: container.appointmentId ?? null, lastEvent: container.lastEvent },
    pendingActions, blockingReasons, confirmPoints, risk,
  };
}

function taskDef(task: YardTask): ObjectDef {
  const machine = task.equipmentId ? equipment.find(e => e.id === task.equipmentId) : undefined;
  const blockingReasons = [...task.blockingReasons];
  if (machine && (machine.status === 'maintenance' || machine.status === 'offline')) blockingReasons.push(`${machine.name} 当前${machine.status === 'maintenance' ? '维护' : '离线'}中`);
  const pendingActions = task.status === 'done' ? [] : [
    ...(task.status === 'blocked' ? blockingReasons.map(reason => `解除阻塞：${reason}`) : []),
    task.equipmentId ? `确认设备 ${task.equipmentId} 按计划到位` : '完成设备指派',
    `按 ${new Date(task.scheduledAt).toLocaleString()} 计划窗口执行 ${task.kind} 作业`,
  ];
  const confirmPoints = [
    `作业路径 ${task.from} → ${task.to} 是否仍然可执行`,
    task.equipmentId ? `${task.equipmentId} 状态是否满足作业` : '是否需要立即指派设备',
    ...task.blockingReasons.map(reason => `阻塞因素是否解除：${reason}`),
  ];
  const risk = maxRisk(
    task.status === 'blocked' ? 'high' : 'low',
    blockingReasons.length ? 'medium' : 'low',
    task.priority >= 120 ? 'high' : 'low',
    task.status === 'executing' ? 'medium' : 'low',
  );
  return {
    kind: 'task', id: task.id, title: `任务 ${task.id} · ${task.kind} · ${task.containerId}`,
    snapshot: { id: task.id, kind: task.kind, containerId: task.containerId, status: task.status, equipmentId: task.equipmentId ?? null, equipmentStatus: machine?.status ?? null, priority: task.priority, from: task.from, to: task.to, scheduledAt: task.scheduledAt, estimatedMinutes: task.estimatedMinutes, blockingReasons: [...task.blockingReasons] },
    pendingActions, blockingReasons, confirmPoints, risk,
  };
}

function appointmentDef(appointment: GateAppointment): ObjectDef {
  const conflictReasons = gateConflictReasons(appointment.id);
  const blockingReasons: string[] = [...(appointment.exception ? [appointment.exception] : []), ...conflictReasons];
  const pendingActions = (appointment.status === 'completed' || appointment.status === 'cancelled') ? [] : [
    appointment.status === 'booked' ? '车辆到场后完成签到' : '完成 OCR/称重/封志核验后放行',
    ...(!appointment.sealVerified ? ['核验封志'] : []),
    ...(!appointment.weightVerified ? ['完成称重'] : []),
    ...conflictReasons.map(reason => `处理冲突：${reason}`),
  ];
  const confirmPoints = [
    `预约窗口 ${new Date(appointment.windowStart).toLocaleString()}–${new Date(appointment.windowEnd).toLocaleString()} 是否仍有效`,
    appointment.sealVerified ? '封志已核验' : '封志尚未核验',
    appointment.weightVerified ? '称重已完成' : '称重尚未完成',
    `车道（${laneLabels[appointment.lane] ?? appointment.lane}）排队是否可控`,
  ];
  const risk = maxRisk(
    conflictReasons.length || appointment.exception ? 'high' : 'low',
    appointment.status === 'checked-in' ? 'medium' : 'low',
    appointment.status === 'exception' ? 'high' : 'low',
  );
  return {
    kind: 'appointment', id: appointment.id, title: `预约 ${appointment.id} · ${appointment.truckNo}`,
    snapshot: { id: appointment.id, containerId: appointment.containerId, truckNo: appointment.truckNo, driver: appointment.driver, type: appointment.type, lane: appointment.lane, status: appointment.status, windowStart: appointment.windowStart, windowEnd: appointment.windowEnd, sealVerified: appointment.sealVerified, weightVerified: appointment.weightVerified, exception: appointment.exception ?? null },
    pendingActions, blockingReasons, confirmPoints, risk,
  };
}

function equipmentDef(item: Equipment): ObjectDef {
  const blockingReasons = item.status === 'maintenance' ? ['设备维护中，不能参与指派'] : item.status === 'offline' ? ['设备离线，不能参与指派'] : [];
  const pendingActions = item.status === 'maintenance' || item.status === 'offline'
    ? ['确认预计恢复时间并在复机后更新设备池']
    : item.queue >= 8 ? [`队列积压 ${item.queue}，协调疏解`] : ['保持设备池可用盯控'];
  const risk = item.status === 'offline' ? 'high' : item.status === 'maintenance' ? 'medium' : item.queue >= 8 ? 'medium' : 'low';
  return {
    kind: 'equipment', id: item.id, title: `${item.name}（${item.location}）`,
    snapshot: { id: item.id, name: item.name, kind: item.kind, status: item.status, location: item.location, battery: item.battery, queue: item.queue, movesPerHour: item.movesPerHour },
    pendingActions, blockingReasons, confirmPoints: item.status === 'available' || item.status === 'working' ? ['设备遥测状态是否正常'] : ['维修/离线原因与预计复机时间是否明确'], risk,
  };
}

function blockDef(block: YardBlock): ObjectDef {
  const freePlugs = block.reeferPlugs - block.usedPlugs;
  const blockingReasons: string[] = [];
  if (block.occupied >= block.capacity) blockingReasons.push('区块已满，无法再落箱');
  if (block.reeferPlugs > 0 && freePlugs <= 2) blockingReasons.push(`冷藏插座仅剩 ${freePlugs} 个`);
  const pendingActions = [
    ...(block.heat > 85 ? [`热度 ${block.heat}，优先疏解区块作业`] : []),
    ...(freePlugs <= 2 ? ['协调冷藏箱插座余量'] : []),
    block.occupied >= block.capacity ? '安排翻箱/外移释放容量' : '维持区块容量盯控',
  ];
  return {
    kind: 'block', id: block.id, title: `区块 ${block.id} · ${block.zone}`,
    snapshot: { id: block.id, zone: block.zone, capacity: block.capacity, occupied: block.occupied, reeferPlugs: block.reeferPlugs, usedPlugs: block.usedPlugs, hazmatAllowed: block.hazmatAllowed, heat: block.heat },
    pendingActions, blockingReasons,
    confirmPoints: [`占用 ${block.occupied}/${block.capacity} 是否与箱位图一致`, ...(block.reeferPlugs ? [`冷藏插座 ${block.usedPlugs}/${block.reeferPlugs} 是否准确`] : [])],
    risk: block.heat > 85 || block.occupied >= block.capacity ? 'high' : block.heat > 65 || freePlugs <= 2 ? 'medium' : 'low',
  };
}

/* ---------------- 事件目录（按事件选择对象） ---------------- */

export interface HandoverEvent {
  id: string;
  category: 'gate-conflict' | 'blocked-task' | 'equipment' | 'reefer' | 'hazmat' | 'late-voyage';
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  /** 事件当前是否仍未解决；每次查看实时计算 */
  open: boolean;
  risk: Risk;
  /** 事件关联的现场对象：选择事件交接时，底层对象一并纳入，避免“只交了事件、没人接管实物” */
  related: { kind: ObjectKind; id: string }[];
}

interface EventDef extends HandoverEvent { snapshot: () => Snapshot | null; }

function gateConflictReasons(appointmentId: string): string[] {
  const reasons: string[] = [];
  const a = appointments.find(item => item.id === appointmentId);
  if (!a) return reasons;
  appointments.forEach(b => {
    if (b.id === a.id) return;
    const overlap = a.truckNo === b.truckNo && new Date(a.windowStart).getTime() < new Date(b.windowEnd).getTime() && new Date(b.windowStart).getTime() < new Date(a.windowEnd).getTime();
    if (overlap) reasons.push(`车辆 ${a.truckNo} 与 ${b.id} 时间窗口重叠`);
  });
  const container = containers.find(c => c.id === a.containerId);
  if (a.status === 'booked' && container && container.customs !== 'released') reasons.push(`箱 ${container.id} 海关状态为 ${container.customs}`);
  return reasons;
}

function eventDefs(): EventDef[] {
  const defs: EventDef[] = [];
  appointments.forEach((a, i) => {
    appointments.slice(i + 1).forEach(b => {
      const overlap = a.truckNo === b.truckNo && new Date(a.windowStart).getTime() < new Date(b.windowEnd).getTime() && new Date(b.windowStart).getTime() < new Date(a.windowEnd).getTime();
      if (!overlap) return;
      const id = `EVT-GATE-${a.id}-${b.id}`;
      defs.push({
        id, category: 'gate-conflict', severity: 'critical', risk: 'high',
        title: `闸口冲突 · ${a.truckNo} · ${a.id}/${b.id}`,
        detail: `同车 ${a.truckNo} 两个预约窗口重叠，需重排时隙`,
        open: appointments.some(x => x.id === a.id) && appointments.some(x => x.id === b.id) && overlap,
        related: [{ kind: 'appointment', id: a.id }, { kind: 'appointment', id: b.id }],
        snapshot: () => {
          const x = appointments.find(v => v.id === a.id); const y = appointments.find(v => v.id === b.id);
          return x && y ? { eventOpen: true, truckNo: x.truckNo, appointmentA: x.id, statusA: x.status, appointmentB: y.id, statusB: y.status, windowStartA: x.windowStart, windowEndA: x.windowEnd, windowStartB: y.windowStart, windowEndB: y.windowEnd } : null;
        },
      });
    });
    const container = containers.find(c => c.id === a.containerId);
    if (a.status === 'booked' && container && container.customs !== 'released') {
      const id = `EVT-GATE-CUSTOMS-${a.id}`;
      defs.push({
        id, category: 'gate-conflict', severity: 'warning', risk: 'high',
        title: `闸口海关拦截 · ${a.id}`,
        detail: `箱 ${a.id} 海关状态 ${container.customs}，预约车辆无法无条件放行`,
        open: appointments.find(v => v.id === a.id)?.status === 'booked' && (containers.find(c => c.id === a.containerId)?.customs !== 'released'),
        related: [{ kind: 'appointment', id: a.id }, { kind: 'container', id: a.containerId }],
        snapshot: () => { const v = appointments.find(x => x.id === a.id); const c = v ? containers.find(x => x.id === v.containerId) : undefined; return v && c ? { eventOpen: true, appointmentId: v.id, appointmentStatus: v.status, lane: v.lane, containerId: c.id, customs: c.customs } : null; },
      });
    }
  });
  tasks.filter(t => t.status === 'blocked').forEach(t => defs.push({
    id: `EVT-BLOCKED-${t.id}`, category: 'blocked-task', severity: 'critical', risk: 'high',
    title: `作业阻塞 · ${t.id} · ${t.containerId}`,
    detail: `任务 ${t.id} 被阻塞：${t.blockingReasons.join('；') || '原因待补充'}`,
    open: tasks.find(x => x.id === t.id)?.status === 'blocked',
    related: [{ kind: 'task', id: t.id }, { kind: 'container', id: t.containerId }],
    snapshot: () => { const x = tasks.find(v => v.id === t.id); return x ? { eventOpen: true, taskId: x.id, status: x.status, blockingReasons: [...x.blockingReasons], equipmentId: x.equipmentId ?? null } : null; },
  }));
  equipment.filter(e => e.status === 'maintenance' || e.status === 'offline').forEach(e => defs.push({
    id: `EVT-EQUIP-${e.id}`, category: 'equipment', severity: 'warning', risk: e.status === 'offline' ? 'high' : 'medium',
    title: `设备异常 · ${e.name}`,
    detail: `${e.name} 当前${e.status === 'maintenance' ? '维护中' : '离线'}，位置 ${e.location}`,
    open: ['maintenance', 'offline'].includes(equipment.find(x => x.id === e.id)?.status ?? ''),
    related: [{ kind: 'equipment', id: e.id }],
    snapshot: () => { const x = equipment.find(v => v.id === e.id); return x ? { eventOpen: true, equipmentId: x.id, status: x.status, location: x.location, battery: x.battery } : null; },
  }));
  containers.filter(c => c.reefer && (c.customs === 'inspection' || (c.temperature ?? 0) > 5)).forEach(c => defs.push({
    id: `EVT-REEFER-${c.id}`, category: 'reefer', severity: 'warning', risk: 'high',
    title: `冷藏风险 · ${c.id}`,
    detail: `冷藏箱 ${c.id} 设定 ${c.temperature ?? '?'}°C，海关 ${c.customs}`,
    open: (() => { const x = containers.find(v => v.id === c.id); return Boolean(x && x.reefer && (x.customs === 'inspection' || (x.temperature ?? 0) > 5)); })(),
    related: [{ kind: 'container', id: c.id }],
    snapshot: () => { const x = containers.find(v => v.id === c.id); return x ? { eventOpen: true, containerId: x.id, temperature: x.temperature ?? null, customs: x.customs, yardSlot: x.yardSlot } : null; },
  }));
  containers.filter(c => Boolean(c.hazmatClass) && c.customs !== 'released').forEach(c => defs.push({
    id: `EVT-HAZMAT-${c.id}`, category: 'hazmat', severity: 'critical', risk: 'high',
    title: `危险品扣留 · ${c.id}`,
    detail: `${c.hazmatClass} 类危险品箱 ${c.id} 海关 ${c.customs}，滞留 ${c.yardSlot}`,
    open: (() => { const x = containers.find(v => v.id === c.id); return Boolean(x && x.hazmatClass && x.customs !== 'released'); })(),
    related: [{ kind: 'container', id: c.id }],
    snapshot: () => { const x = containers.find(v => v.id === c.id); return x ? { eventOpen: true, containerId: x.id, hazmatClass: x.hazmatClass ?? null, customs: x.customs, yardSlot: x.yardSlot } : null; },
  }));
  voyages.filter(v => v.lateRisk === 'high' && v.status !== 'departed').forEach(v => defs.push({
    id: `EVT-LATE-${v.id}`, category: 'late-voyage', severity: 'warning', risk: 'high',
    title: `航次延误风险 · ${v.vessel}`,
    detail: `${v.vessel}（${v.id}）延误风险高，泊位 ${v.berth}`,
    open: voyages.find(x => x.id === v.id)?.lateRisk === 'high',
    related: [{ kind: 'voyage', id: v.id }],
    snapshot: () => { const x = voyages.find(u => u.id === v.id); return x ? { eventOpen: true, voyageId: x.id, lateRisk: x.lateRisk, status: x.status, movesDone: x.movesDone, movesPlanned: x.movesPlanned } : null; },
  }));
  return defs;
}

function eventDef(id: string) { return eventDefs().find(def => def.id === id); }

/* 对象注册表：交接项与“无人负责”清单共用一套实时口径 */
function defFor(kind: ObjectKind, id: string): ObjectDef | undefined {
  switch (kind) {
    case 'voyage': { const v = voyages.find(item => item.id === id); return v ? voyageDef(v) : undefined; }
    case 'container': { const c = containers.find(item => item.id === id); return c ? containerDef(c) : undefined; }
    case 'task': { const t = tasks.find(item => item.id === id); return t ? taskDef(t) : undefined; }
    case 'appointment': { const a = appointments.find(item => item.id === id); return a ? appointmentDef(a) : undefined; }
    case 'equipment': { const e = equipment.find(item => item.id === id); return e ? equipmentDef(e) : undefined; }
    case 'block': { const b = blocks.find(item => item.id === id); return b ? blockDef(b) : undefined; }
    case 'event': {
      const event = eventDef(id);
      if (!event) return undefined;
      const snapshot = event.snapshot();
      if (!snapshot) return undefined;
      return {
        kind: 'event', id: event.id, title: event.title, snapshot,
        pendingActions: event.open ? ['核实事件最新状态并推动闭环'] : ['确认事件已闭环并记录结论'],
        blockingReasons: event.open ? [event.detail] : [],
        confirmPoints: [event.open ? '事件是否仍在持续、责任人是否明确' : '事件是否已彻底闭环、是否需要复盘'],
        risk: event.risk,
      };
    }
  }
}

const keyOf = (kind: ObjectKind, id: string) => `${kind}:${id}`;

/* ---------------- 范围展开（航次/区块/车道/事件） ---------------- */

function expandScope(scope: { kind: ScopeKind; ref: string }): { scope: HandoverScope; keys: string[] } {
  const { kind, ref } = scope;
  if (kind === 'voyage') {
    const voyage = voyages.find(v => v.id === ref);
    if (!voyage) throw new Error(`未知航次：${ref}`);
    const linkedContainers = containers.filter(c => c.voyageId === ref);
    const containerIds = new Set(linkedContainers.map(c => c.id));
    const keys = [
      keyOf('voyage', ref),
      ...linkedContainers.map(c => keyOf('container', c.id)),
      ...tasks.filter(t => containerIds.has(t.containerId)).map(t => keyOf('task', t.id)),
      ...appointments.filter(a => containerIds.has(a.containerId)).map(a => keyOf('appointment', a.id)),
    ];
    return { scope: { kind, ref, label: `航次 ${voyage.vessel}（${ref}）` }, keys };
  }
  if (kind === 'block') {
    const block = blocks.find(b => b.id === ref);
    if (!block) throw new Error(`未知区块：${ref}`);
    const inBlock = containers.filter(c => parseSlotBlock(c.yardSlot) === ref).map(c => c.id);
    const keys = [
      keyOf('block', ref),
      ...containers.filter(c => parseSlotBlock(c.yardSlot) === ref).map(c => keyOf('container', c.id)),
      ...tasks.filter(t => inBlock.includes(t.containerId) || parseSlotBlock(t.from) === ref || parseSlotBlock(t.to) === ref).map(t => keyOf('task', t.id)),
      ...equipment.filter(e => e.location.startsWith(ref)).map(e => keyOf('equipment', e.id)),
    ];
    return { scope: { kind, ref, label: `区块 ${ref} · ${block.zone}` }, keys };
  }
  if (kind === 'gate-lane') {
    const label = laneLabels[ref];
    if (!label) throw new Error(`未知闸口车道：${ref}`);
    const laneAppts = appointments.filter(a => a.lane === ref);
    const containerIds = new Set(laneAppts.map(a => a.containerId));
    const keys = [
      ...laneAppts.map(a => keyOf('appointment', a.id)),
      ...containers.filter(c => containerIds.has(c.id)).map(c => keyOf('container', c.id)),
      ...tasks.filter(t => t.from.includes(label) || t.to.includes(label)).map(t => keyOf('task', t.id)),
    ];
    return { scope: { kind, ref, label: `闸口车道 · ${label}` }, keys };
  }
  if (kind === 'event') {
    const event = eventDef(ref);
    if (!event) throw new Error(`未知或已不存在的事件：${ref}`);
    const keys = [keyOf('event', ref), ...event.related.map(r => keyOf(r.kind, r.id))];
    return { scope: { kind, ref, label: event.title }, keys };
  }
  throw new Error(`不支持的交接范围：${kind}`);
}

/* ---------------- 漂移比对 ---------------- */

function diffSnapshot(snapshot: Snapshot, live: Snapshot): FieldChange[] {
  const fields = new Set([...Object.keys(snapshot), ...Object.keys(live)]);
  const changes: FieldChange[] = [];
  fields.forEach(field => {
    if (JSON.stringify(snapshot[field]) !== JSON.stringify(live[field])) changes.push({ field, from: snapshot[field], to: live[field] });
  });
  return changes;
}

export function driftOf(item: HandoverItem): DriftInfo {
  if (item.objectKind === 'event') {
    const def = eventDef(item.objectId);
    const live = def?.snapshot() ?? null;
    if (!live) return { changed: true, liveMissing: false, eventResolved: true, fields: [{ field: 'eventOpen', from: true, to: false }] };
    const fields = diffSnapshot(item.snapshot, live);
    return { changed: fields.length > 0, liveMissing: false, eventResolved: Boolean(fields.some(f => f.field === 'eventOpen' && f.to === false)), fields };
  }
  const [kind, id] = [item.objectKind, item.objectId];
  const def = defFor(kind, id);
  if (!def) return { changed: true, liveMissing: true, eventResolved: false, fields: [{ field: 'source', from: 'exists', to: 'missing' }] };
  const fields = diffSnapshot(item.snapshot, def.snapshot);
  return { changed: fields.length > 0, liveMissing: false, eventResolved: false, fields };
}

/* ---------------- 交接包状态与视图 ---------------- */

export function isExpired(pkg: HandoverPackage, at = now()): boolean { return at.getTime() >= new Date(pkg.expiresAt).getTime(); }

export function packageStatus(pkg: HandoverPackage): PackageStatus {
  if (isExpired(pkg)) return 'expired';
  if (pkg.items.length > 0 && pkg.items.every(item => item.outcome === 'confirmed')) return 'confirmed';
  if (pkg.items.some(item => item.outcome !== 'pending')) return 'in-progress';
  return 'active';
}

function canSee(visibility: NoteVisibility, role: HandoverRole) { return visibility === 'internal' || role === 'outgoing' || role === 'supervisor'; }

export interface ItemView extends HandoverItem { drift: DriftInfo; }
export interface PackageView extends Omit<HandoverPackage, 'items' | 'notes'> {
  status: PackageStatus;
  expired: boolean;
  items: ItemView[];
  notes: (HandoverNote & { redacted?: boolean })[];
  risk: Risk;
  counts: { total: number; pending: number; confirmed: number; returned: number; drift: number };
}

function viewPackage(pkg: HandoverPackage, role: HandoverRole = 'incoming'): PackageView {
  const items = pkg.items.map(item => ({ ...item, drift: driftOf(item) }));
  const counts = {
    total: items.length,
    pending: items.filter(i => i.outcome === 'pending').length,
    confirmed: items.filter(i => i.outcome === 'confirmed').length,
    returned: items.filter(i => i.outcome === 'returned').length,
    drift: items.filter(i => i.drift.changed).length,
  };
  return {
    ...pkg,
    status: packageStatus(pkg),
    expired: isExpired(pkg),
    items,
    counts,
    risk: items.some(i => i.risk === 'high') ? 'high' : items.some(i => i.risk === 'medium') ? 'medium' : 'low',
    notes: pkg.notes.map(note => canSee(note.visibility, role) ? note : { ...note, text: '', redacted: true }),
  };
}

/* ---------------- 创建交接包 ---------------- */

function buildItem(kind: ObjectKind, id: string, addedAt: string): HandoverItem {
  const def = defFor(kind, id);
  if (!def) throw new Error(`交接对象不存在：${kind} ${id}`);
  const carriedChain = handoverPackages.filter(pkg => pkg.items.some(item => item.objectKind === kind && item.objectId === id)).map(pkg => pkg.id);
  return {
    id: nextId('HOI'), objectKind: kind, objectId: id, title: def.title,
    snapshot: def.snapshot, pendingActions: def.pendingActions, blockingReasons: def.blockingReasons,
    confirmPoints: def.confirmPoints, risk: def.risk,
    outcome: 'pending', acknowledgedDrift: false, supplements: [], history: [],
    carryCount: carriedChain.length, carriedChain, addedAt,
  };
}

export function createHandoverPackage(input: CreatePackageInput): { pkg: HandoverPackage; warnings: string[] } {
  if (!input.scopes?.length) throw new Error('请至少选择一个交接范围（航次/区块/车道/事件）');
  const scopes: HandoverScope[] = [];
  const seen = new Set<string>();
  input.scopes.forEach(raw => {
    const expanded = expandScope(raw);
    scopes.push(expanded.scope);
    expanded.keys.forEach(key => seen.add(key));
  });
  if (!seen.size) throw new Error('所选范围没有可交接的对象');

  const createdAt = now();
  const items = [...seen].map(key => {
    const sep = key.indexOf(':');
    return buildItem(key.slice(0, sep) as ObjectKind, key.slice(sep + 1), createdAt.toISOString());
  });
  if (!items.length) throw new Error('所选范围没有可交接的对象');

  const activeOthers = handoverPackages.filter(pkg => !isExpired(pkg) && packageStatus(pkg) !== 'confirmed');
  const warnings: string[] = [];
  items.forEach(item => {
    const clash = activeOthers.filter(pkg => pkg.items.some(other => other.objectKind === item.objectKind && other.objectId === item.objectId));
    clash.forEach(pkg => warnings.push(`${item.title} 已被未关闭的交接包 ${pkg.id}（${pkg.fromShift}→${pkg.toShift}）覆盖，需明确唯一责任人`));
  });
  items.filter(i => i.carryCount > 0).forEach(i => warnings.push(`${i.title} 已跨班次交接 ${i.carryCount} 次，本次为重复接管，请确认遗留原因`));

  const ttl = input.ttlMinutes ?? 120;
  const pkg: HandoverPackage = {
    id: nextId('PKG'),
    title: input.title?.trim() || `班次交接包 · ${createdAt.toLocaleString()}`,
    fromShift: input.fromShift?.trim() || '当前班次',
    toShift: input.toShift?.trim() || '下一班次',
    createdBy: input.createdBy?.trim() || '中控调度员',
    createdAt: createdAt.toISOString(),
    expiresAt: input.expiresAt ?? new Date(createdAt.getTime() + ttl * 60000).toISOString(),
    scopes, items, warnings,
    notes: (input.notes ?? []).filter(n => n.text?.trim()).map(n => ({ id: nextId('HON'), at: createdAt.toISOString(), author: input.createdBy?.trim() || '中控调度员', text: n.text.trim(), visibility: n.visibility ?? 'internal' })),
    timeline: [{ at: createdAt.toISOString(), actor: input.createdBy?.trim() || '中控调度员', text: `生成交接包，覆盖 ${items.length} 个对象${warnings.length ? `，产生 ${warnings.length} 条覆盖/重复接管提醒` : ''}` }],
    predecessorIds: [],
  };
  handoverPackages.unshift(pkg);
  recordAudit('HANDOVER_CREATE', pkg.id, `范围 ${scopes.map(s => s.label).join('、')}；对象 ${items.length} 个`, pkg.createdBy);
  return { pkg, warnings };
}

/* ---------------- 逐项确认 / 退回 / 补充 ---------------- */

function getPackageAndItem(packageId: string, itemId: string) {
  const pkg = handoverPackages.find(item => item.id === packageId);
  if (!pkg) return undefined;
  const item = pkg.items.find(entry => entry.id === itemId);
  if (!item) return undefined;
  return { pkg, item };
}

function assertOpen(pkg: HandoverPackage) {
  if (isExpired(pkg)) throw Object.assign(new Error(`交接包 ${pkg.id} 已过期，不能再确认或退回；请先做滚动交接生成新包`), { code: 'PACKAGE_EXPIRED' });
}

export function confirmItem(packageId: string, itemId: string, options: { actor?: string; note?: string; acknowledgeDrift?: boolean } = {}) {
  const found = getPackageAndItem(packageId, itemId);
  if (!found) return undefined;
  const { pkg, item } = found;
  assertOpen(pkg);
  if (item.outcome === 'confirmed') throw Object.assign(new Error('该事项已经确认，确认结果不可撤销'), { code: 'ALREADY_CONFIRMED' });
  const drift = driftOf(item);
  if (drift.changed && !item.acknowledgedDrift && !options.acknowledgeDrift) {
    throw Object.assign(new Error('源数据自交接包生成后已发生变化，必须先逐项核对漂移字段并勾选知悉'), { code: 'DRIFT_DETECTED', drift });
  }
  item.outcome = 'confirmed';
  if (drift.changed || options.acknowledgeDrift) item.acknowledgedDrift = true;
  item.history.push({ at: nowIso(), actor: options.actor ?? '接班人', action: 'confirm', note: options.note });
  pkg.timeline.push({ at: nowIso(), actor: options.actor ?? '接班人', text: `确认接管 ${item.title}${drift.changed ? '（已知悉源数据漂移）' : ''}` });
  recordAudit('HANDOVER_CONFIRM', packageId, `${item.objectKind}:${item.objectId}`, options.actor ?? '接班人');
  return item;
}

export function returnItem(packageId: string, itemId: string, options: { actor?: string; note: string }) {
  const found = getPackageAndItem(packageId, itemId);
  if (!found) return undefined;
  const { pkg, item } = found;
  assertOpen(pkg);
  if (!options.note?.trim()) throw new Error('退回必须填写退回原因');
  item.outcome = 'returned';
  item.history.push({ at: nowIso(), actor: options.actor ?? '接班人', action: 'return', note: options.note.trim() });
  pkg.timeline.push({ at: nowIso(), actor: options.actor ?? '接班人', text: `退回 ${item.title}：${options.note.trim()}` });
  recordAudit('HANDOVER_RETURN', packageId, `${item.objectKind}:${item.objectId}：${options.note.trim()}`, options.actor ?? '接班人');
  return item;
}

export function supplementItem(packageId: string, itemId: string, options: { actor?: string; text: string }) {
  const found = getPackageAndItem(packageId, itemId);
  if (!found) return undefined;
  const { pkg, item } = found;
  assertOpen(pkg);
  if (!options.text?.trim()) throw new Error('现场补充信息不能为空');
  const entry: ItemSupplement = { id: nextId('HOS'), at: nowIso(), author: options.actor ?? '接班人', text: options.text.trim() };
  item.supplements.push(entry);
  item.history.push({ at: nowIso(), actor: entry.author, action: 'supplement', note: entry.text });
  pkg.timeline.push({ at: nowIso(), actor: entry.author, text: `补充现场信息 · ${item.title}` });
  recordAudit('HANDOVER_SUPPLEMENT', packageId, `${item.objectKind}:${item.objectId}`, entry.author);
  return item;
}

export function addPackageNote(packageId: string, input: { text: string; visibility?: NoteVisibility; author?: string }) {
  const pkg = handoverPackages.find(item => item.id === packageId);
  if (!pkg) return undefined;
  if (!input.text?.trim()) throw new Error('备注内容不能为空');
  const note: HandoverNote = { id: nextId('HON'), at: nowIso(), author: input.author?.trim() || '调度员', text: input.text.trim(), visibility: input.visibility ?? 'internal' };
  pkg.notes.push(note);
  return note;
}

/* ---------------- 滚动交接（过期 / 跨班次） ---------------- */

export interface RolloverInput {
  fromPackageIds: string[];
  toShift?: string;
  title?: string;
  ttlMinutes?: number;
  actor?: string;
}

export function rolloverPackage(input: RolloverInput): HandoverPackage {
  if (!input.fromPackageIds?.length) throw new Error('请指定滚动交接的来源交接包');
  const sources = input.fromPackageIds.map(id => handoverPackages.find(pkg => pkg.id === id));
  if (sources.some(pkg => !pkg)) throw new Error('来源交接包不存在');
  const known = sources.filter((p): p is HandoverPackage => Boolean(p));

  /* 只带走未确认（含退回）的事项；确认完成的不重复接管 */
  const picked = new Map<string, HandoverItem>();
  known.forEach(pkg => pkg.items.forEach(item => {
    if (item.outcome === 'confirmed') return;
    const key = keyOf(item.objectKind, item.objectId);
    if (!picked.has(key)) picked.set(key, item);
  }));
  if (!picked.size) throw new Error('来源交接包没有需要滚动交接的未完成事项');

  const createdAt = now();
  const actor = input.actor?.trim() || '中控调度员';
  const items: HandoverItem[] = [];
  picked.forEach((oldItem, key) => {
    const sep = key.indexOf(':');
    const kind = key.slice(0, sep) as ObjectKind; const id = key.slice(sep + 1);
    const def = defFor(kind, id);
    if (!def) return; // 源对象已删除：进入新包没有意义，留在旧包漂移里可审计
    const chainPackages = new Set<string>([...oldItem.carriedChain, ...known.map(p => p.id)]);
    items.push({
      id: nextId('HOI'), objectKind: kind, objectId: id, title: def.title,
      snapshot: def.snapshot, pendingActions: def.pendingActions, blockingReasons: def.blockingReasons,
      confirmPoints: def.confirmPoints, risk: def.risk,
      outcome: 'pending', acknowledgedDrift: false,
      supplements: oldItem.supplements.map(s => ({ ...s })),
      history: [],
      carryCount: chainPackages.size,
      carriedChain: [...chainPackages],
      addedAt: createdAt.toISOString(),
    });
  });
  if (!items.length) throw new Error('未完成事项的源对象均已不存在，无法滚动交接');

  const scopes: HandoverScope[] = known.map(pkg => ({ kind: 'rollover' as ScopeKind, ref: pkg.id, label: `来自 ${pkg.id}（${pkg.fromShift}→${pkg.toShift}）的滚动交接` }));
  const warnings: string[] = [];
  const activeOthers = handoverPackages.filter(pkg => !isExpired(pkg) && packageStatus(pkg) !== 'confirmed' && !known.includes(pkg));
  items.forEach(item => {
    activeOthers.filter(p => p.items.some(o => o.objectKind === item.objectKind && o.objectId === item.objectId))
      .forEach(p => warnings.push(`${item.title} 同时被另一个未关闭交接包 ${p.id} 覆盖`));
  });
  items.filter(i => i.carryCount > 0).forEach(i => warnings.push(`${i.title} 已跨班次交接 ${i.carryCount} 次，本次为重复接管`));

  const fromShift = known.map(p => p.toShift).find(Boolean) ?? known[0].toShift;
  const pkg: HandoverPackage = {
    id: nextId('PKG'),
    title: input.title?.trim() || `滚动交接包 · ${createdAt.toLocaleString()}`,
    fromShift,
    toShift: input.toShift?.trim() || '下一班次',
    createdBy: actor,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + (input.ttlMinutes ?? 120) * 60000).toISOString(),
    scopes, items, warnings,
    notes: known.flatMap(p => p.notes).map(n => ({ ...n, id: nextId('HON') })),
    timeline: [{ at: createdAt.toISOString(), actor, text: `由 ${known.map(p => p.id).join('、')} 滚动交接，带走 ${items.length} 个未完成事项` }],
    predecessorIds: known.map(p => p.id),
  };
  handoverPackages.unshift(pkg);

  /* 来源包关闭，避免同一批事项被两个有效交接包同时覆盖；重复接管链路仍保留可查 */
  known.forEach(source => {
    if (!isExpired(source)) {
      source.expiresAt = createdAt.toISOString();
      source.timeline.push({ at: createdAt.toISOString(), actor, text: `滚动交接至 ${pkg.id}，本包关闭` });
    }
  });
  recordAudit('HANDOVER_ROLLOVER', pkg.id, `来源 ${input.fromPackageIds.join('、')}；事项 ${items.length} 个`, actor);
  return pkg;
}

/* ---------------- 交接控制台（无人负责/覆盖/过期/重复接管） ---------------- */

export interface ConsoleUnowned { key: string; objectKind: ObjectKind; objectId: string; title: string; reason: string; risk: Risk; blockingReasons: string[]; }
export interface ConsoleOverlap { key: string; objectKind: ObjectKind; objectId: string; title: string; packages: { packageId: string; shift: string; outcome: ItemOutcome; expired: boolean }[]; }
export interface RepeatTakeover { key: string; objectKind: ObjectKind; objectId: string; title: string; chain: { packageId: string; shift: string; at: string }[]; }

function attentionUniverse(): { kind: ObjectKind; id: string }[] {
  return [
    ...voyages.filter(v => v.status !== 'departed').map(v => ({ kind: 'voyage' as const, id: v.id })),
    ...containers
      .filter(c => c.customs !== 'released' || c.status === 'hold' || c.status === 'at-gate' || c.appointmentId)
      .map(c => ({ kind: 'container' as const, id: c.id })),
    ...tasks.filter(t => t.status !== 'done').map(t => ({ kind: 'task' as const, id: t.id })),
    ...appointments.filter(a => ['booked', 'checked-in', 'exception'].includes(a.status)).map(a => ({ kind: 'appointment' as const, id: a.id })),
    ...equipment.filter(e => e.status === 'maintenance' || e.status === 'offline' || e.queue >= 8).map(e => ({ kind: 'equipment' as const, id: e.id })),
    ...blocks.filter(b => b.heat > 65).map(b => ({ kind: 'block' as const, id: b.id })),
    ...eventDefs().filter(e => e.open).map(e => ({ kind: 'event' as const, id: e.id })),
  ];
}

export interface HandoverConsole {
  generatedAt: string;
  packages: PackageView[];
  unowned: ConsoleUnowned[];
  overlaps: ConsoleOverlap[];
  expiredPackages: PackageView[];
  repeatTakeovers: RepeatTakeover[];
  stats: { packages: number; active: number; expired: number; pendingItems: number; driftItems: number; unowned: number; overlaps: number; repeatTakeovers: number };
}

export function handoverConsole(role: HandoverRole = 'incoming'): HandoverConsole {
  const views = handoverPackages.map(pkg => viewPackage(pkg, role));
  const effective = views.filter(pkg => !pkg.expired);

  const coverage = new Map<string, ConsoleOverlap>();
  views.forEach(pkg => pkg.items.forEach(item => {
    const key = keyOf(item.objectKind, item.objectId);
    if (!coverage.has(key)) coverage.set(key, { key, objectKind: item.objectKind, objectId: item.objectId, title: item.title, packages: [] });
    coverage.get(key)!.packages.push({ packageId: pkg.id, shift: `${pkg.fromShift}→${pkg.toShift}`, outcome: item.outcome, expired: pkg.expired });
  }));
  const overlaps = [...coverage.values()].filter(entry => entry.packages.filter(p => !p.expired).length >= 2);

  const repeatTakeovers: RepeatTakeover[] = [];
  coverage.forEach((entry, key) => {
    const ordered = handoverPackages
      .filter(pkg => pkg.items.some(i => keyOf(i.objectKind, i.objectId) === key))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const shifts = new Set(ordered.map(p => `${p.fromShift}→${p.toShift}`));
    if (ordered.length >= 2 && shifts.size >= 2) {
      repeatTakeovers.push({ key, objectKind: entry.objectKind, objectId: entry.objectId, title: entry.title, chain: ordered.map(p => ({ packageId: p.id, shift: `${p.fromShift}→${p.toShift}`, at: p.createdAt })) });
    }
  });

  /* 接班所有权：仅未过期包中的“待确认/已确认”事项算有人负责；
     退回代表接班人拒绝接管，包内该事项及其同批对象全部回到无人负责口径 */
  const returnedKeys = new Set<string>();
  effective.forEach(pkg => pkg.items.forEach(item => {
    if (item.outcome === 'returned') returnedKeys.add(keyOf(item.objectKind, item.objectId));
  }));
  const ownedKeys = new Set<string>();
  effective.forEach(pkg => pkg.items.forEach(item => {
    const key = keyOf(item.objectKind, item.objectId);
    if (item.outcome !== 'returned' && !returnedKeys.has(key)) ownedKeys.add(key);
  }));

  const unowned: ConsoleUnowned[] = [];
  attentionUniverse().forEach(({ kind, id }) => {
    const key = keyOf(kind, id);
    if (ownedKeys.has(key)) return;
    const def = defFor(kind, id);
    if (!def) return;
    const covering = coverage.get(key)?.packages ?? [];
    let reason = '尚无交接包覆盖';
    if (covering.length) {
      if (returnedKeys.has(key)) reason = '接班人已退回，需交班人处理后重新交接';
      else if (covering.every(p => p.expired)) reason = '覆盖的交接包已过期，需要滚动交接';
      else reason = '覆盖的交接包中该事项未被有效接管';
    }
    unowned.push({ key, objectKind: kind, objectId: id, title: def.title, reason, risk: def.risk, blockingReasons: def.blockingReasons });
  });
  unowned.sort((a, b) => (b.risk === 'high' ? 1 : 0) - (a.risk === 'high' ? 1 : 0));

  return {
    generatedAt: nowIso(),
    packages: views,
    unowned,
    overlaps,
    expiredPackages: views.filter(pkg => pkg.expired),
    repeatTakeovers,
    stats: {
      packages: views.length,
      active: effective.length,
      expired: views.length - effective.length,
      pendingItems: effective.reduce((sum, pkg) => sum + pkg.counts.pending + pkg.counts.returned, 0),
      driftItems: effective.reduce((sum, pkg) => sum + pkg.counts.drift, 0),
      unowned: unowned.length,
      overlaps: overlaps.length,
      repeatTakeovers: repeatTakeovers.length,
    },
  };
}

/* ---------------- 查询辅助 ---------------- */

export function listPackages(role: HandoverRole = 'incoming'): PackageView[] { return handoverPackages.map(pkg => viewPackage(pkg, role)); }
export function getPackageView(id: string, role: HandoverRole = 'incoming'): PackageView | undefined {
  const pkg = handoverPackages.find(item => item.id === id);
  return pkg ? viewPackage(pkg, role) : undefined;
}

export function handoverCatalog() {
  return {
    voyages: voyages.map(v => ({ id: v.id, label: `${v.vessel}（${v.id}）`, status: v.status, lateRisk: v.lateRisk })),
    blocks: blocks.map(b => ({ id: b.id, label: `区块 ${b.id} · ${b.zone}`, heat: b.heat, occupied: b.occupied, capacity: b.capacity })),
    lanes: (['north', 'south', 'rail'] as const).map(id => ({ id, label: laneLabels[id], appointments: appointments.filter(a => a.lane === id).length })),
    events: eventDefs().map(({ snapshot: _snapshot, ...event }) => event),
  };
}

/* 供路由层读取创建结果（含覆盖提醒） */
export function createAndView(input: CreatePackageInput, role: HandoverRole = 'incoming') {
  const { pkg, warnings } = createHandoverPackage(input);
  return { pkg: viewPackage(pkg, role), warnings };
}

export function rolloverAndView(input: RolloverInput, role: HandoverRole = 'incoming') {
  const pkg = rolloverPackage(input);
  return viewPackage(pkg, role);
}
