import { appointments, auditEvents, blocks, containers, equipment, tasks, voyages } from './domain.js';
import type { Container, Equipment, GateAppointment, YardTask } from './domain.js';

export type SelectorType = 'voyage' | 'block' | 'lane' | 'event';
export type HandoverObjectKind = 'container' | 'appointment' | 'task' | 'equipment';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ItemStatus = 'pending' | 'confirmed' | 'returned';
export type PackageStatus = 'open' | 'partial' | 'acknowledged' | 'expired';
export type ViewerRole = 'dispatcher' | 'supervisor';

type SourceObject = Container | GateAppointment | YardTask | Equipment;
interface ObjectRef { kind: HandoverObjectKind; object: SourceObject }

export interface Supplement { at: string; actor: string; text: string; sensitive: boolean }
export interface HandoverItem {
  id: string; objectKind: HandoverObjectKind; objectId: string; label: string;
  snapshot: SourceObject; snapshotHash: string;
  openActions: string[]; blockingReasons: string[]; riskLevel: RiskLevel;
  status: ItemStatus;
  confirmedBy?: string; confirmedAt?: string; confirmedWithDrift?: boolean; duplicateTakeover?: boolean;
  returnedBy?: string; returnedAt?: string; returnReason?: string;
  supplements: Supplement[];
  takeoverOf?: { packageId: string; confirmedBy?: string };
}
export interface HandoverPackage {
  id: string; title: string;
  selector: { type: SelectorType; value: string };
  fromShift: string; toShift: string; createdBy: string;
  note?: string; noteSensitive: boolean;
  createdAt: string; expiresAt: string;
  items: HandoverItem[];
}

export const handoverPackages: HandoverPackage[] = [];
let sequence = 1;
const now = () => new Date().toISOString();
const MASKED = '【敏感备注】仅值班经理及以上角色可见';

export const kindLabel: Record<HandoverObjectKind, string> = { container: '箱务', appointment: '闸口预约', task: '作业任务', equipment: '设备' };
const riskRank: Record<RiskLevel, number> = { critical: 3, high: 2, medium: 1, low: 0 };

function hashOf(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

function findSource(kind: HandoverObjectKind, id: string): SourceObject | undefined {
  if (kind === 'container') return containers.find(item => item.id === id);
  if (kind === 'appointment') return appointments.find(item => item.id === id);
  if (kind === 'task') return tasks.find(item => item.id === id);
  return equipment.find(item => item.id === id);
}

function diffFields(snapshot: SourceObject, current: SourceObject): string[] {
  const before = snapshot as unknown as Record<string, unknown>;
  const after = current as unknown as Record<string, unknown>;
  return Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function resolveSelector(selector: { type: SelectorType; value: string }): ObjectRef[] {
  const refs: ObjectRef[] = [];
  const push = (kind: HandoverObjectKind, object: SourceObject | undefined) => {
    if (!object) return;
    const id = (object as { id: string }).id;
    if (!refs.some(ref => ref.kind === kind && (ref.object as { id: string }).id === id)) refs.push({ kind, object });
  };
  if (selector.type === 'voyage') {
    const voyage = voyages.find(item => item.id === selector.value);
    if (!voyage) throw new Error(`航次 ${selector.value} 不存在`);
    const scoped = containers.filter(item => item.voyageId === voyage.id && item.status !== 'released');
    const ids = new Set(scoped.map(item => item.id));
    scoped.forEach(item => push('container', item));
    appointments.filter(item => ids.has(item.containerId) && item.status !== 'completed' && item.status !== 'cancelled').forEach(item => push('appointment', item));
    tasks.filter(item => ids.has(item.containerId) && item.status !== 'done').forEach(item => push('task', item));
    return refs;
  }
  if (selector.type === 'block') {
    const block = blocks.find(item => item.id === selector.value);
    if (!block) throw new Error(`区块 ${selector.value} 不存在`);
    containers.filter(item => item.yardSlot.startsWith(`${block.id}-`)).forEach(item => push('container', item));
    tasks.filter(item => item.status !== 'done' && (item.from.includes(block.id) || item.to.includes(block.id))).forEach(item => push('task', item));
    equipment.filter(item => item.location.includes(block.id)).forEach(item => push('equipment', item));
    return refs;
  }
  if (selector.type === 'lane') {
    if (!['north', 'south', 'rail'].includes(selector.value)) throw new Error('闸口车道必须是 north / south / rail');
    const scoped = appointments.filter(item => item.lane === selector.value && ['booked', 'checked-in', 'exception'].includes(item.status));
    scoped.forEach(item => push('appointment', item));
    scoped.forEach(item => push('container', containers.find(entry => entry.id === item.containerId)));
    return refs;
  }
  const broken = equipment.filter(item => item.status === 'maintenance' || item.status === 'offline');
  broken.forEach(item => push('equipment', item));
  tasks.filter(item => item.status === 'blocked' || item.blockingReasons.length > 0).forEach(item => push('task', item));
  containers.filter(item => item.customs !== 'released' || item.status === 'hold').forEach(item => push('container', item));
  appointments.filter(item => item.exception || item.status === 'exception').forEach(item => push('appointment', item));
  return refs;
}

function derive(kind: HandoverObjectKind, object: SourceObject): { label: string; openActions: string[]; blockingReasons: string[]; riskLevel: RiskLevel } {
  if (kind === 'container') {
    const item = object as Container;
    const openActions: string[] = [];
    const blockingReasons: string[] = [];
    if (item.customs === 'inspection') { openActions.push('等待海关查验与放行'); blockingReasons.push('海关查验中'); }
    if (item.customs === 'hold') { openActions.push('等待海关扣留解除'); blockingReasons.push('海关扣留'); }
    if (item.status === 'at-gate') openActions.push('闸口作业中，待出场/进场确认');
    if (item.status === 'in-transit') openActions.push('在途，待到港交接');
    if (item.status === 'hold') blockingReasons.push('箱状态挂起');
    if (item.reefer) openActions.push(`冷藏箱温度 ${item.temperature ?? '?'}°C 需持续监控`);
    if (item.appointmentId) openActions.push(`关联预约 ${item.appointmentId} 待闭环`);
    let riskLevel: RiskLevel = 'low';
    if (item.hazmatClass && item.customs !== 'released') riskLevel = 'critical';
    else if (item.hazmatClass || (item.reefer && item.customs !== 'released')) riskLevel = 'high';
    else if (item.customs !== 'released' || item.priority === 'hot') riskLevel = 'medium';
    return { label: `${item.id} · ${item.direction} · ${item.yardSlot}`, openActions, blockingReasons, riskLevel };
  }
  if (kind === 'appointment') {
    const item = object as GateAppointment;
    const openActions: string[] = [];
    const blockingReasons: string[] = [];
    if (item.status === 'booked') openActions.push('预约待签到进场');
    if (item.status === 'checked-in') openActions.push('车辆已进场，待闸口作业完成');
    if (item.status === 'exception') openActions.push('预约异常待处理');
    if (item.exception) blockingReasons.push(item.exception);
    if (item.status === 'checked-in' && (!item.sealVerified || !item.weightVerified)) blockingReasons.push('封志/称重未全部核验');
    const riskLevel: RiskLevel = item.exception || item.status === 'exception' ? 'high' : item.status === 'checked-in' ? 'medium' : 'low';
    return { label: `${item.id} · ${item.truckNo} · ${item.lane} 车道`, openActions, blockingReasons, riskLevel };
  }
  if (kind === 'task') {
    const item = object as YardTask;
    const openActions: string[] = [`${item.kind} 任务待执行（${item.from} → ${item.to}）`];
    if (!item.equipmentId) openActions.push('待指派作业设备');
    const blockingReasons = [...item.blockingReasons];
    let riskLevel: RiskLevel = 'low';
    if (item.status === 'blocked' && item.kind === 'inspect') riskLevel = 'critical';
    else if (item.status === 'blocked') riskLevel = 'high';
    else if (item.blockingReasons.length > 0 || item.priority >= 90) riskLevel = 'medium';
    return { label: `${item.id} · ${item.kind} · ${item.containerId}`, openActions, blockingReasons, riskLevel };
  }
  const item = object as Equipment;
  const openActions: string[] = [];
  const blockingReasons: string[] = [];
  if (item.status === 'maintenance') { openActions.push('设备维护中，待恢复上线'); blockingReasons.push(`${item.name} 维护中不可用`); }
  if (item.status === 'offline') { openActions.push('设备离线，待排查恢复'); blockingReasons.push(`${item.name} 离线`); }
  if (item.queue > 5) openActions.push(`作业队列积压 ${item.queue} 单，需疏导`);
  const riskLevel: RiskLevel = item.status === 'maintenance' || item.status === 'offline' ? 'high' : item.queue > 5 ? 'medium' : 'low';
  return { label: `${item.name} · ${item.location}`, openActions, blockingReasons, riskLevel };
}

function recordAudit(action: string, entityId: string, details: string) {
  auditEvents.unshift({ id: `AUD-${Date.now()}-${sequence}`, actor: '交接班调度', action, entity: 'handover', entityId, at: now(), details });
}

export function selectorDescription(selector: { type: SelectorType; value: string }): string {
  if (selector.type === 'voyage') { const voyage = voyages.find(item => item.id === selector.value); return `航次 ${selector.value}${voyage ? ` · ${voyage.vessel}` : ''}`; }
  if (selector.type === 'block') return `区块 ${selector.value}`;
  if (selector.type === 'lane') return `闸口车道 ${selector.value}`;
  return '设备与作业异常事件';
}

export interface HandoverInput {
  title?: string; selector: { type: SelectorType; value: string };
  fromShift: string; toShift: string; createdBy: string;
  ttlMinutes?: number; note?: string; noteSensitive?: boolean;
}

export function createHandoverPackage(input: HandoverInput): HandoverPackage {
  if (!input.selector || !input.selector.value) throw new Error('必须选择交接范围（航次 / 区块 / 闸口车道 / 事件）');
  if (!input.fromShift?.trim() || !input.toShift?.trim()) throw new Error('必须填写交班班次与接班班次');
  if (!input.createdBy?.trim()) throw new Error('必须填写交班人');
  const refs = resolveSelector(input.selector);
  if (!refs.length) throw new Error('该条件下没有需要交接的对象');
  const ttl = Math.min(1440, Math.max(1, Math.round(input.ttlMinutes ?? 480)));
  const createdAt = now();
  const pkg: HandoverPackage = {
    id: `HO-${String(sequence++).padStart(3, '0')}`,
    title: input.title?.trim() || `${selectorDescription(input.selector)} · ${input.fromShift}→${input.toShift}`,
    selector: { type: input.selector.type, value: input.selector.value },
    fromShift: input.fromShift.trim(), toShift: input.toShift.trim(), createdBy: input.createdBy.trim(),
    note: input.note?.trim() || undefined, noteSensitive: Boolean(input.noteSensitive),
    createdAt, expiresAt: new Date(Date.parse(createdAt) + ttl * 60000).toISOString(),
    items: []
  };
  pkg.items = refs.map((ref, index) => {
    const derived = derive(ref.kind, ref.object);
    const objectId = (ref.object as { id: string }).id;
    const prior = handoverPackages
      .flatMap(other => other.items.map(item => ({ pkg: other, item })))
      .filter(entry => entry.item.objectKind === ref.kind && entry.item.objectId === objectId && entry.item.status === 'confirmed')
      .sort((a, b) => (b.item.confirmedAt ?? '').localeCompare(a.item.confirmedAt ?? ''))[0];
    return {
      id: `IT-${pkg.id}-${String(index + 1).padStart(2, '0')}`,
      objectKind: ref.kind, objectId, label: derived.label,
      snapshot: JSON.parse(JSON.stringify(ref.object)) as SourceObject, snapshotHash: hashOf(ref.object),
      openActions: derived.openActions, blockingReasons: derived.blockingReasons, riskLevel: derived.riskLevel,
      status: 'pending' as ItemStatus, supplements: [],
      ...(prior ? { takeoverOf: { packageId: prior.pkg.id, confirmedBy: prior.item.confirmedBy } } : {})
    };
  });
  handoverPackages.unshift(pkg);
  recordAudit('HANDOVER_CREATE', pkg.id, `按「${selectorDescription(pkg.selector)}」生成交接包，覆盖 ${pkg.items.length} 个对象，${input.fromShift} → ${input.toShift}`);
  return pkg;
}

export function packageStatus(pkg: HandoverPackage): PackageStatus {
  if (pkg.items.length > 0 && pkg.items.every(item => item.status === 'confirmed')) return 'acknowledged';
  if (Date.now() > Date.parse(pkg.expiresAt)) return 'expired';
  if (pkg.items.some(item => item.status !== 'pending')) return 'partial';
  return 'open';
}

function overlaps(item: HandoverItem, self: HandoverPackage): string[] {
  return handoverPackages
    .filter(other => other.id !== self.id && ['open', 'partial'].includes(packageStatus(other)) && other.items.some(entry => entry.objectKind === item.objectKind && entry.objectId === item.objectId))
    .map(other => other.id);
}

export interface ItemView extends HandoverItem {
  stale: boolean; sourceMissing: boolean; changedFields: string[]; overlapWith: string[];
}

function itemView(item: HandoverItem, pkg: HandoverPackage, role: ViewerRole): ItemView {
  const current = findSource(item.objectKind, item.objectId);
  const stale = Boolean(current) && hashOf(current) !== item.snapshotHash;
  return {
    ...item,
    supplements: item.supplements.map(entry => entry.sensitive && role !== 'supervisor' ? { ...entry, text: MASKED } : entry),
    stale, sourceMissing: !current,
    changedFields: current && stale ? diffFields(item.snapshot, current) : [],
    overlapWith: overlaps(item, pkg)
  };
}

export interface PackageView extends HandoverPackage { status: PackageStatus; selectorText: string; items: ItemView[] }

export function packageView(pkg: HandoverPackage, role: ViewerRole = 'dispatcher'): PackageView {
  return {
    ...pkg,
    note: pkg.noteSensitive && role !== 'supervisor' && pkg.note ? MASKED : pkg.note,
    status: packageStatus(pkg),
    selectorText: selectorDescription(pkg.selector),
    items: pkg.items.map(item => itemView(item, pkg, role))
  };
}

export function listHandoverPackages(role: ViewerRole = 'dispatcher') {
  return handoverPackages.map(pkg => {
    const view = packageView(pkg, role);
    return {
      id: pkg.id, title: pkg.title, selector: pkg.selector, selectorText: selectorDescription(pkg.selector),
      fromShift: pkg.fromShift, toShift: pkg.toShift, createdBy: pkg.createdBy,
      note: view.note, noteSensitive: pkg.noteSensitive,
      createdAt: pkg.createdAt, expiresAt: pkg.expiresAt, status: view.status,
      total: pkg.items.length,
      confirmed: pkg.items.filter(item => item.status === 'confirmed').length,
      returned: pkg.items.filter(item => item.status === 'returned').length,
      staleCount: view.items.filter(item => item.stale || item.sourceMissing).length,
      overlapCount: view.items.filter(item => item.overlapWith.length > 0).length
    };
  });
}

export function handoverPackageView(id: string, role: ViewerRole = 'dispatcher'): PackageView | undefined {
  const pkg = handoverPackages.find(item => item.id === id);
  return pkg ? packageView(pkg, role) : undefined;
}

function findItem(packageId: string, itemId: string) {
  const pkg = handoverPackages.find(item => item.id === packageId);
  const item = pkg?.items.find(entry => entry.id === itemId);
  return pkg && item ? { pkg, item } : undefined;
}

function assertActionable(pkg: HandoverPackage, item: HandoverItem) {
  if (packageStatus(pkg) === 'expired') throw new Error('交接包已过期，未确认事项已转入无人负责清单');
  if (item.status === 'confirmed') throw new Error('该事项已完成确认，不能重复操作');
}

export function confirmItem(packageId: string, itemId: string, actor: string): PackageView | undefined {
  const found = findItem(packageId, itemId);
  if (!found) return undefined;
  if (!actor?.trim()) throw new Error('必须填写接班人姓名');
  assertActionable(found.pkg, found.item);
  const { pkg, item } = found;
  const current = findSource(item.objectKind, item.objectId);
  item.status = 'confirmed';
  item.confirmedBy = actor.trim();
  item.confirmedAt = now();
  item.confirmedWithDrift = !current || hashOf(current) !== item.snapshotHash;
  item.duplicateTakeover = handoverPackages.some(other => other.id !== pkg.id && other.items.some(entry => entry.objectKind === item.objectKind && entry.objectId === item.objectId && entry.status === 'confirmed'));
  recordAudit('HANDOVER_CONFIRM', pkg.id, `${actor} 确认接管 ${item.objectId}${item.confirmedWithDrift ? '（源数据已变化）' : ''}${item.duplicateTakeover ? '（跨班次重复接管）' : ''}`);
  return packageView(pkg, 'supervisor');
}

export function returnItem(packageId: string, itemId: string, actor: string, reason: string): PackageView | undefined {
  const found = findItem(packageId, itemId);
  if (!found) return undefined;
  if (!reason?.trim()) throw new Error('退回必须填写原因');
  assertActionable(found.pkg, found.item);
  const { pkg, item } = found;
  item.status = 'returned';
  item.returnedBy = actor?.trim() || '接班人';
  item.returnedAt = now();
  item.returnReason = reason.trim();
  recordAudit('HANDOVER_RETURN', pkg.id, `${item.returnedBy} 退回 ${item.objectId}：${item.returnReason}`);
  return packageView(pkg, 'supervisor');
}

export function addSupplement(packageId: string, itemId: string, actor: string, text: string, sensitive: boolean): PackageView | undefined {
  const found = findItem(packageId, itemId);
  if (!found) return undefined;
  if (!text?.trim()) throw new Error('补充内容不能为空');
  assertActionable(found.pkg, found.item);
  const { pkg, item } = found;
  item.supplements.push({ at: now(), actor: actor?.trim() || '接班人', text: text.trim(), sensitive: Boolean(sensitive) });
  recordAudit('HANDOVER_SUPPLEMENT', pkg.id, `${item.objectId} 补充现场信息${sensitive ? '（敏感）' : ''}`);
  return packageView(pkg, 'supervisor');
}

export interface UnownedEntry { packageId: string; packageTitle: string; reason: string; item: ItemView }

export function unownedItems(role: ViewerRole = 'dispatcher'): UnownedEntry[] {
  const result: UnownedEntry[] = [];
  for (const pkg of handoverPackages) {
    const status = packageStatus(pkg);
    for (const item of pkg.items) {
      if (item.status === 'confirmed') continue;
      if (status === 'expired') result.push({ packageId: pkg.id, packageTitle: pkg.title, reason: '交接包已过期，接班人未确认接管', item: itemView(item, pkg, role) });
      else if (item.status === 'returned') result.push({ packageId: pkg.id, packageTitle: pkg.title, reason: `接班人退回：${item.returnReason ?? '未填写原因'}`, item: itemView(item, pkg, role) });
    }
  }
  return result.sort((a, b) => riskRank[b.item.riskLevel] - riskRank[a.item.riskLevel]);
}

export function normalizeRole(value: unknown): ViewerRole {
  return value === 'supervisor' ? 'supervisor' : 'dispatcher';
}
