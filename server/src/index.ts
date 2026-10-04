import express from 'express';
import { appointments, assignTask, blocks, containerDetail, containers, createContainer, createGateAppointment, createYardTask, dashboard, deleteContainer, deleteGateAppointment, deleteYardTask, editGateAppointment, equipment, gateConflicts, prioritizeTasks, tasks, updateContainer, updateYardTask, voyages, yardHeatmap } from './domain.js';
import { addPackageNote, createAndView, getPackageView, handoverCatalog, handoverConsole, listPackages, rolloverAndView, supplementItem, confirmItem, returnItem, type HandoverRole } from './handover.js';
const app = express(); app.use(express.json());
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/voyages', (_req, res) => res.json(voyages));
app.get('/api/containers', (req, res) => res.json(req.query.status ? containers.filter(c => c.status === req.query.status) : containers));
app.post('/api/containers', (req, res) => { try { res.status(201).json(createContainer(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建箱务记录失败' }); } });
app.patch('/api/containers/:id', (req, res) => { try { const result = updateContainer(req.params.id, req.body); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新箱务记录失败' }); } });
app.delete('/api/containers/:id', (req, res) => { const result = deleteContainer(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/containers/:id', (req, res) => { const result = containerDetail(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); });
app.get('/api/yard/heatmap', (_req, res) => res.json(yardHeatmap()));
app.get('/api/yard/blocks', (_req, res) => res.json(blocks));
app.get('/api/gate/appointments', (_req, res) => res.json(appointments));
app.get('/api/gate/conflicts', (_req, res) => res.json(gateConflicts()));
app.post('/api/gate/appointments', (req, res) => { try { res.status(201).json(createGateAppointment(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '预约失败' }); } });
app.patch('/api/gate/appointments/:id', (req, res) => { try { const result = editGateAppointment(req.params.id, req.body); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新预约失败' }); } });
app.delete('/api/gate/appointments/:id', (req, res) => { const result = deleteGateAppointment(req.params.id); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/equipment', (_req, res) => res.json(equipment));
app.get('/api/tasks', (_req, res) => res.json(prioritizeTasks()));
app.post('/api/tasks', (req, res) => { try { res.status(201).json(createYardTask(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建作业任务失败' }); } });
app.patch('/api/tasks/:id', (req, res) => { try { const result = updateYardTask(req.params.id, req.body); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新作业任务失败' }); } });
app.delete('/api/tasks/:id', (req, res) => { const result = deleteYardTask(req.params.id); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json({ deleted: true, id: result.id }); });
app.patch('/api/tasks/:id/assign', (req, res) => { const result = assignTask(req.params.id, req.body.equipmentId); if (!result) return res.status(404).json({ message: '任务或设备不存在' }); res.json(result); });

/* ---------------- 班次交接包 ---------------- */
const roleOf = (req: express.Request): HandoverRole => {
  const role = req.header('X-Handover-Role');
  return role === 'outgoing' || role === 'supervisor' ? role : 'incoming';
};
const handoverError = (error: unknown, res: express.Response, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback;
  const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
  const drift = error instanceof Error && 'drift' in error ? (error as { drift?: unknown }).drift : undefined;
  const status = code === 'PACKAGE_EXPIRED' ? 410 : code === 'DRIFT_DETECTED' ? 409 : code === 'ALREADY_CONFIRMED' ? 409 : 400;
  res.status(status).json({ message, code, ...(drift ? { drift } : {}) });
};
app.get('/api/handover/catalog', (_req, res) => res.json(handoverCatalog()));
app.get('/api/handover/console', (req, res) => res.json(handoverConsole(roleOf(req))));
app.get('/api/handover/packages', (req, res) => res.json(listPackages(roleOf(req))));
app.post('/api/handover/packages', (req, res) => {
  try {
    const result = createAndView({ ...req.body, createdBy: req.body.createdBy ?? (roleOf(req) === 'incoming' ? '接班人' : '交班调度员') }, roleOf(req));
    res.status(201).json(result);
  } catch (error) { handoverError(error, res, '生成交接包失败'); }
});
app.get('/api/handover/packages/:id', (req, res) => { const pkg = getPackageView(req.params.id, roleOf(req)); if (!pkg) return res.status(404).json({ message: '交接包不存在' }); res.json(pkg); });
app.post('/api/handover/packages/:id/items/:itemId/confirm', (req, res) => {
  try { const result = confirmItem(req.params.id, req.params.itemId, { actor: req.body.actor ?? '接班人', note: req.body.note, acknowledgeDrift: Boolean(req.body.acknowledgeDrift) }); if (!result) return res.status(404).json({ message: '交接包或事项不存在' }); res.json(result); }
  catch (error) { handoverError(error, res, '确认失败'); }
});
app.post('/api/handover/packages/:id/items/:itemId/return', (req, res) => {
  try { const result = returnItem(req.params.id, req.params.itemId, { actor: req.body.actor ?? '接班人', note: String(req.body.note ?? '') }); if (!result) return res.status(404).json({ message: '交接包或事项不存在' }); res.json(result); }
  catch (error) { handoverError(error, res, '退回失败'); }
});
app.post('/api/handover/packages/:id/items/:itemId/supplement', (req, res) => {
  try { const result = supplementItem(req.params.id, req.params.itemId, { actor: req.body.actor ?? '接班人', text: String(req.body.text ?? '') }); if (!result) return res.status(404).json({ message: '交接包或事项不存在' }); res.json(result); }
  catch (error) { handoverError(error, res, '补充信息失败'); }
});
app.post('/api/handover/packages/:id/notes', (req, res) => {
  try { const result = addPackageNote(req.params.id, { text: String(req.body.text ?? ''), visibility: req.body.visibility, author: req.body.actor ?? '调度员' }); if (!result) return res.status(404).json({ message: '交接包不存在' }); res.status(201).json(result); }
  catch (error) { handoverError(error, res, '备注保存失败'); }
});
app.post('/api/handover/rollover', (req, res) => {
  try { res.status(201).json({ pkg: rolloverAndView({ ...req.body, actor: req.body.actor ?? '接班人' }, roleOf(req)) }); }
  catch (error) { handoverError(error, res, '滚动交接失败'); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'port-yard-operations' }));
const port = Number(process.env.PORT || 4107); app.listen(port, () => console.log(`port yard API listening on ${port}`));
