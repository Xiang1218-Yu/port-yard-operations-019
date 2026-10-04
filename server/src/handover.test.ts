import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetHandoverPackages, __setHandoverNow, addPackageNote, confirmItem, createHandoverPackage, driftOf,
  getPackageView, handoverConsole, handoverCatalog, listPackages,
  rolloverPackage, returnItem, supplementItem,
} from './handover.js';
import { equipment, tasks, updateYardTask } from './domain.js';

const T0 = new Date('2026-10-04T08:00:00.000Z').getTime();
const reset = (m = 0, clear = true) => { if (clear) __resetHandoverPackages(); __setHandoverNow(T0 + m * 60000); };

const voyageScope = () => ({ kind: 'voyage' as const, ref: 'VOY-AX7' });

test('交接包：按航次生成快照、阻塞原因、风险与待确认事项', () => {
  reset();
  const { pkg } = createHandoverPackage({ scopes: [voyageScope()], fromShift: '夜班', toShift: '白班' });
  assert.ok(pkg.items.length >= 3, '航次范围应展开为航次+箱+任务/预约');
  const blocked = pkg.items.find(i => i.objectId === 'TASK-103');
  assert.equal(blocked?.risk, 'high');
  assert.ok(blocked.blockingReasons.some(r => r.includes('RS-02')));
  assert.ok(blocked.confirmPoints.length > 0);
  const hold = pkg.items.find(i => i.objectId === 'TGHU-9831204');
  assert.ok(hold?.blockingReasons.some(r => r.includes('海关')));
});

test('交接包：确认结果不改变原始作业状态', () => {
  reset();
  const { pkg } = createHandoverPackage({ scopes: [{ kind: 'block', ref: 'D05' }] });
  const item = pkg.items.find(i => i.objectKind === 'task' && i.objectId === 'TASK-103')!;
  const before = tasks.find(t => t.id === 'TASK-103')!.status;
  confirmItem(pkg.id, item.id, { actor: '白班接班人' });
  assert.equal(tasks.find(t => t.id === 'TASK-103')!.status, before, '原始任务状态不得被确认动作修改');
  const eqBefore = JSON.stringify(equipment.find(e => e.id === 'RS-02'));
  assert.ok(eqBefore.includes('maintenance'), '设备原始状态保持维护中');
});

test('交接包：生成后源数据变化会被漂移检测拦住，知悉后才允许确认，且快照不变', () => {
  reset();
  const { pkg } = createHandoverPackage({ scopes: [{ kind: 'event', ref: 'EVT-EQUIP-RS-02' }] });
  const item = pkg.items[0];
  const snapshotCopy = JSON.parse(JSON.stringify(item.snapshot));
  equipment.find(e => e.id === 'RS-02')!.status = 'available';
  assert.equal(driftOf(item).changed, true, '事件应随设备恢复而出现漂移/已解决');
  assert.throws(
    () => confirmItem(pkg.id, item.id),
    (err: Error & { code?: string }) => err.code === 'DRIFT_DETECTED',
    '存在漂移时不能直接确认',
  );
  assert.doesNotThrow(() => confirmItem(pkg.id, item.id, { acknowledgeDrift: true }));
  assert.deepEqual(item.snapshot, snapshotCopy, '冻结快照保持生成时内容');
  equipment.find(e => e.id === 'RS-02')!.status = 'maintenance';
});

test('交接包：同一对象被两个交接包覆盖时给出覆盖提醒，控制台输出重叠清单', () => {
  reset();
  const first = createHandoverPackage({ scopes: [{ kind: 'block', ref: 'D05' }], fromShift: '夜班', toShift: '白班' });
  const second = createHandoverPackage({ scopes: [{ kind: 'event', ref: 'EVT-BLOCKED-TASK-103' }], fromShift: '夜班', toShift: '白班' });
  assert.ok(second.warnings.some(w => w.includes(first.pkg.id)), '第二个包必须提示与未关闭包的覆盖');
  assert.ok(second.pkg.items.some(i => i.objectId === 'TASK-103'), '事件交接应同时纳入底层阻塞任务');
  const consoleView = handoverConsole();
  const overlap = consoleView.overlaps.find(o => o.objectId === 'TASK-103');
  assert.ok(overlap, '控制台能看到 TASK-103 被两个有效包同时覆盖');
  assert.equal(overlap!.packages.filter(p => !p.expired).length, 2);
});

test('交接包：过期后禁止确认/退回/补充，只能滚动交接', () => {
  reset();
  const { pkg } = createHandoverPackage({ scopes: [{ kind: 'gate-lane', ref: 'south' }], ttlMinutes: 60 });
  const item = pkg.items[0];
  reset(61, false);
  assert.throws(() => confirmItem(pkg.id, item.id), /已过期/);
  assert.throws(() => supplementItem(pkg.id, item.id, { text: '现场补充' }), /已过期/);
  assert.throws(() => returnItem(pkg.id, item.id, { note: '退回原因' }), /已过期/);
  assert.ok(handoverConsole().expiredPackages.some(p => p.id === pkg.id));
});

test('交接包：部分确认时包状态为进行中，退回必须填原因，确认不可撤销', () => {
  reset();
  const { pkg } = createHandoverPackage({ scopes: [{ kind: 'gate-lane', ref: 'south' }] });
  const [a, b] = pkg.items;
  confirmItem(pkg.id, a.id);
  assert.equal(getPackageView(pkg.id)!.status, 'in-progress');
  assert.throws(() => returnItem(pkg.id, b.id, { note: '   ' }), /退回必须填写退回原因/);
  returnItem(pkg.id, b.id, { note: '车道称重数据与单据不符，需要复核' });
  assert.throws(() => confirmItem(pkg.id, a.id), /已经确认/, '确认结果不可改变');
  const view = getPackageView(pkg.id)!;
  assert.equal(view.counts.confirmed, 1);
  assert.equal(view.counts.returned, 1);
});

test('交接包：滚动交接只带走未完成事项，形成跨班次重复接管链路', () => {
  reset();
  const night = createHandoverPackage({ scopes: [{ kind: 'block', ref: 'D05' }], fromShift: '夜班', toShift: '白班', ttlMinutes: 60 });
  reset(30, false);
  confirmItem(night.pkg.id, night.pkg.items[0].id);
  reset(61, false);
  const day = rolloverPackage({ fromPackageIds: [night.pkg.id], toShift: '晚班' });
  assert.equal(day.items.length, night.pkg.items.length - 1, '已确认事项不进入滚动交接');
  assert.deepEqual(day.predecessorIds, [night.pkg.id]);
  assert.ok(day.items.every(i => i.carryCount >= 1), '滚动事项带跨班次重复接管计数');
  const repeat = handoverConsole().repeatTakeovers.find(r => r.objectId === day.items[0].objectId);
  assert.ok(repeat && repeat.chain.length >= 2, '控制台可见跨班次重复接管链路');
});

test('交接包：敏感备注按角色控制展示范围', () => {
  reset();
  const { pkg } = createHandoverPackage({
    scopes: [voyageScope()],
    notes: [{ text: '普通交接备注' }, { text: '司机与货主有费用纠纷，仅限交班团队知悉', visibility: 'restricted' }],
  });
  const incoming = getPackageView(pkg.id, 'incoming')!;
  assert.equal(incoming.notes.find(n => n.visibility === 'restricted')?.redacted, true);
  const supervisor = getPackageView(pkg.id, 'supervisor')!;
  assert.ok(supervisor.notes.find(n => n.visibility === 'restricted')?.text.includes('费用纠纷'));
  const outgoing = listPackages('outgoing').find(p => p.id === pkg.id)!;
  assert.ok(outgoing.notes.find(n => n.visibility === 'restricted')?.text.includes('费用纠纷'));
  addPackageNote(pkg.id, { text: '交班人追加的内部说明', visibility: 'restricted', author: '交班调度员' });
  assert.equal(getPackageView(pkg.id, 'incoming')!.notes.filter(n => n.redacted).length, 2);
});

test('交接包：控制台输出仍无人负责的事项（未覆盖 / 退回 / 过期）', () => {
  reset();
  /* TASK-103 高风险阻塞任务，没有任何交接包覆盖时应出现在无人负责清单 */
  const c1 = handoverConsole();
  assert.ok(c1.unowned.some(u => u.objectId === 'TASK-103'), '未覆盖的高风险任务必须可见');

  const { pkg } = createHandoverPackage({ scopes: [{ kind: 'event', ref: 'EVT-BLOCKED-TASK-103' }] });
  /* 事件包同时覆盖底层阻塞任务；退回后事件与任务都回到无人负责清单 */
  const c2 = handoverConsole();
  assert.ok(!c2.unowned.some(u => u.objectId === 'TASK-103'), '事件交接已带上底层任务，任务有人负责');

  const eventItem = pkg.items.find(i => i.objectId === 'EVT-BLOCKED-TASK-103')!;
  returnItem(pkg.id, eventItem.id, { note: '现场无法核实，退回交班' });
  const c3 = handoverConsole();
  const entry = c3.unowned.find(u => u.objectId === eventItem.objectId);
  assert.ok(entry?.reason.includes('退回'), '退回事项回到无人负责清单并标明原因');
  assert.ok(!c3.unowned.some(u => u.objectId === 'TASK-103'), '同包仅退回事件项时，底层任务仍由该包待确认项覆盖');
  const taskItem = pkg.items.find(i => i.objectId === 'TASK-103')!;
  returnItem(pkg.id, taskItem.id, { note: '设备未到位，任务也退回' });
  const c3b = handoverConsole();
  assert.ok(c3b.unowned.some(u => u.objectId === 'TASK-103' && u.reason.includes('退回')), '任务自身被退回后重新无人负责');

  reset(200, false); // 包随时间过期（不清空交接包集合）
  const c4 = handoverConsole();
  assert.ok(c4.expiredPackages.length > 0);
  assert.ok(c4.unowned.some(u => u.objectId === 'TASK-103' && u.reason.includes('过期')), '过期覆盖应重新进入无人负责清单');
});

test('交接包：对象删除/任务完成时以漂移形式提示，不影响其他事项确认', () => {
  reset();
  const { pkg } = createHandoverPackage({ scopes: [{ kind: 'block', ref: 'D05' }] });
  const taskItem = pkg.items.find(i => i.objectId === 'TASK-103')!;
  updateYardTask('TASK-103', { status: 'done' });
  const drift = driftOf(taskItem);
  assert.ok(drift.changed);
  assert.ok(drift.fields.some(f => f.field === 'status' && f.to === 'done'));
  updateYardTask('TASK-103', { status: 'blocked' });
});

test('交接包：事件目录与车道范围展开可用，补充信息随事项保留', () => {
  reset();
  const catalog = handoverCatalog();
  assert.ok(catalog.events.some(e => e.id === 'EVT-BLOCKED-TASK-103'));
  assert.ok(catalog.lanes.some(l => l.id === 'south'));
  const { pkg } = createHandoverPackage({ scopes: [{ kind: 'gate-lane', ref: 'north' }] });
  const item = pkg.items.find(i => i.objectKind === 'appointment')!;
  supplementItem(pkg.id, item.id, { text: '集卡已到车道排队，OCR 待复核' });
  const view = getPackageView(pkg.id)!;
  assert.ok(view.items.find(i => i.id === item.id)?.supplements[0]?.text.includes('OCR'));
});
