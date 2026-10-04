import test from 'node:test';
import assert from 'node:assert/strict';
import { containers, tasks } from './domain.js';
import {
  addSupplement, confirmItem, createHandoverPackage, handoverPackageView, handoverPackages,
  listHandoverPackages, packageStatus, returnItem, unownedItems
} from './handover.js';

const base = { fromShift: '白班', toShift: '夜班', createdBy: '交班调度员甲' };

test('按航次生成的交接包包含快照、未完成动作、阻塞原因与风险等级', () => {
  const pkg = createHandoverPackage({ ...base, selector: { type: 'voyage', value: 'VOY-AX7' } });
  assert.ok(pkg.items.length >= 5);
  const held = pkg.items.find(item => item.objectId === 'TGHU-9831204');
  assert.ok(held);
  assert.equal(held.riskLevel, 'critical');
  assert.ok(held.blockingReasons.some(reason => reason.includes('海关')));
  assert.ok(held.openActions.length > 0);
  assert.deepEqual(held.snapshot, containers.find(item => item.id === 'TGHU-9831204'));
  const inspectTask = pkg.items.find(item => item.objectId === 'TASK-103');
  assert.ok(inspectTask);
  assert.ok(inspectTask.blockingReasons.some(reason => reason.includes('RS-02')));
  assert.equal(packageStatus(pkg), 'open');
});

test('按区块、闸口车道与事件选择器解析交接对象', () => {
  const byBlock = createHandoverPackage({ ...base, selector: { type: 'block', value: 'D05' } });
  assert.ok(byBlock.items.some(item => item.objectId === 'RS-02'));
  assert.ok(byBlock.items.some(item => item.objectId === 'TASK-103'));
  const byLane = createHandoverPackage({ ...base, selector: { type: 'lane', value: 'south' } });
  assert.ok(byLane.items.some(item => item.objectId === 'APT-9001'));
  assert.ok(byLane.items.some(item => item.objectId === 'OOLU-7734201'));
  const byEvent = createHandoverPackage({ ...base, selector: { type: 'event', value: 'exceptions' } });
  assert.ok(byEvent.items.some(item => item.objectKind === 'equipment' && item.objectId === 'RS-02'));
  assert.ok(byEvent.items.some(item => item.objectId === 'APT-9004'));
  assert.throws(() => createHandoverPackage({ ...base, selector: { type: 'voyage', value: 'VOY-NONE' } }), /不存在/);
});

test('确认、退回与补充不改变原始作业状态', () => {
  const pkg = createHandoverPackage({ ...base, selector: { type: 'voyage', value: 'VOY-AX7' } });
  const taskBefore = JSON.stringify(tasks.find(item => item.id === 'TASK-103'));
  const containerBefore = JSON.stringify(containers.find(item => item.id === 'TGHU-9831204'));
  const target = pkg.items.find(item => item.objectId === 'TASK-103');
  assert.ok(target);
  confirmItem(pkg.id, target.id, '接班人乙');
  const held = pkg.items.find(item => item.objectId === 'TGHU-9831204');
  assert.ok(held);
  returnItem(pkg.id, held.id, '接班人乙', '现场查验窗口未开，无法接管');
  addSupplement(pkg.id, held.id, '接班人乙', '海关通知明早 9 点开箱', true);
  assert.equal(JSON.stringify(tasks.find(item => item.id === 'TASK-103')), taskBefore);
  assert.equal(JSON.stringify(containers.find(item => item.id === 'TGHU-9831204')), containerBefore);
  const view = handoverPackageView(pkg.id, 'supervisor');
  assert.equal(view?.items.find(item => item.id === target.id)?.status, 'confirmed');
  assert.equal(view?.items.find(item => item.id === held.id)?.supplements.at(-1)?.text, '海关通知明早 9 点开箱');
});

test('没有任何待交接对象时拒绝生成空交接包', () => {
  assert.throws(() => createHandoverPackage({ ...base, selector: { type: 'lane', value: 'rail' } }), /没有需要交接的对象/);
  assert.throws(() => createHandoverPackage({ ...base, selector: { type: 'lane', value: 'east' } }), /车道/);
  assert.throws(() => createHandoverPackage({ ...base, selector: { type: 'voyage', value: 'VOY-AX7' }, fromShift: '', toShift: '夜班' }), /班次/);
});

test('部分确认使交接包处于 partial 状态', () => {
  const pkg = createHandoverPackage({ ...base, selector: { type: 'lane', value: 'north' } });
  assert.ok(pkg.items.length >= 2);
  confirmItem(pkg.id, pkg.items[0].id, '接班人丙');
  assert.equal(packageStatus(pkg), 'partial');
  for (const item of pkg.items.slice(1)) confirmItem(pkg.id, item.id, '接班人丙');
  assert.equal(packageStatus(pkg), 'acknowledged');
});

test('生成后源数据变化会被标记为漂移并记录变化字段', () => {
  const pkg = createHandoverPackage({ ...base, selector: { type: 'block', value: 'C03' } });
  const target = pkg.items.find(item => item.objectId === 'FCIU-9920310');
  assert.ok(target);
  const container = containers.find(item => item.id === 'FCIU-9920310');
  assert.ok(container);
  const original = container.yardSlot;
  container.yardSlot = 'C03-R09-T4';
  const view = handoverPackageView(pkg.id);
  const drifted = view?.items.find(item => item.id === target.id);
  assert.equal(drifted?.stale, true);
  assert.ok(drifted?.changedFields.includes('yardSlot'));
  confirmItem(pkg.id, target.id, '接班人丁');
  assert.equal(pkg.items.find(item => item.id === target.id)?.confirmedWithDrift, true);
  container.yardSlot = original;
});

test('同一对象被两个交接包覆盖时双方都能看到重叠告警', () => {
  const first = createHandoverPackage({ ...base, selector: { type: 'event', value: 'exceptions' } });
  const second = createHandoverPackage({ ...base, selector: { type: 'block', value: 'D05' } });
  const shared = second.items.find(item => item.objectId === 'TASK-103');
  assert.ok(shared);
  const firstView = handoverPackageView(first.id);
  const secondView = handoverPackageView(second.id);
  assert.ok(firstView?.items.find(item => item.objectId === 'TASK-103')?.overlapWith.includes(second.id));
  assert.ok(secondView?.items.find(item => item.objectId === 'TASK-103')?.overlapWith.includes(first.id));
  const summaries = listHandoverPackages();
  assert.ok((summaries.find(item => item.id === first.id)?.overlapCount ?? 0) > 0);
});

test('交接包过期后禁止确认，未确认事项进入无人负责清单', () => {
  const pkg = createHandoverPackage({ ...base, selector: { type: 'lane', value: 'south' }, ttlMinutes: 1 });
  pkg.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(packageStatus(pkg), 'expired');
  assert.throws(() => confirmItem(pkg.id, pkg.items[0].id, '接班人戊'), /已过期/);
  assert.throws(() => returnItem(pkg.id, pkg.items[0].id, '接班人戊', '太迟了'), /已过期/);
  const unowned = unownedItems();
  const entries = unowned.filter(entry => entry.packageId === pkg.id);
  assert.ok(entries.length >= pkg.items.length - 0);
  assert.ok(entries.every(entry => entry.reason.includes('过期')));
});

test('退回的事项在交接包未过期时即进入无人负责清单', () => {
  const pkg = createHandoverPackage({ ...base, selector: { type: 'lane', value: 'north' } });
  const target = pkg.items[0];
  returnItem(pkg.id, target.id, '接班人际', '车道拥堵，需调度长协调');
  const entry = unownedItems().find(candidate => candidate.item.id === target.id);
  assert.ok(entry);
  assert.ok(entry.reason.includes('车道拥堵'));
});

test('跨班次重复接管会被标记并写入审计', () => {
  const first = createHandoverPackage({ ...base, selector: { type: 'block', value: 'D05' } });
  const target = first.items.find(item => item.objectId === 'RS-02');
  assert.ok(target);
  confirmItem(first.id, target.id, '早班接班人');
  const second = createHandoverPackage({ ...base, fromShift: '夜班', toShift: '早班', selector: { type: 'event', value: 'exceptions' } });
  const repeated = second.items.find(item => item.objectId === 'RS-02');
  assert.ok(repeated);
  assert.equal(repeated.takeoverOf?.packageId, first.id);
  assert.equal(repeated.takeoverOf?.confirmedBy, '早班接班人');
  confirmItem(second.id, repeated.id, '晚班接班人');
  assert.equal(second.items.find(item => item.objectId === 'RS-02')?.duplicateTakeover, true);
});

test('敏感备注仅对值班经理角色可见', () => {
  const pkg = createHandoverPackage({ ...base, selector: { type: 'block', value: 'D05' }, note: '船长私下要求优先放行', noteSensitive: true });
  const target = pkg.items[0];
  addSupplement(pkg.id, target.id, '调度长', '海关关系户，注意措辞', true);
  addSupplement(pkg.id, target.id, '现场员', '堆位已拍照留存', false);
  const dispatcherView = handoverPackageView(pkg.id, 'dispatcher');
  assert.ok(dispatcherView?.note?.includes('敏感备注'));
  const masked = dispatcherView?.items[0].supplements;
  assert.ok(masked?.[0].text.includes('敏感备注'));
  assert.equal(masked?.[1].text, '堆位已拍照留存');
  const supervisorView = handoverPackageView(pkg.id, 'supervisor');
  assert.equal(supervisorView?.note, '船长私下要求优先放行');
  assert.equal(supervisorView?.items[0].supplements[0].text, '海关关系户，注意措辞');
  const summary = listHandoverPackages().find(item => item.id === pkg.id);
  assert.ok(summary?.note?.includes('敏感备注'));
});

test('已确认事项不能重复确认或退回', () => {
  const pkg = createHandoverPackage({ ...base, selector: { type: 'lane', value: 'south' } });
  const target = pkg.items[0];
  confirmItem(pkg.id, target.id, '接班人己');
  assert.throws(() => confirmItem(pkg.id, target.id, '接班人己'), /不能重复操作/);
  assert.throws(() => returnItem(pkg.id, target.id, '接班人己', '反悔'), /不能重复操作/);
  assert.ok(handoverPackages.length > 0);
});
