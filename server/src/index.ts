import express from 'express';
import { approve, assets, budgetLines, contracts, createApproval, dashboard, projectSummary, projects, rightsConflicts, rightsEvidence } from './domain.js';
import { deliveryService } from './delivery.js';

const app = express();
app.use(express.json());

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => {
  const result = projectSummary(req.params.id);
  if (!result.project) return res.status(404).json({ message: '项目不存在' });
  res.json(result);
});
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
app.get('/api/projects/:id/rights-evidence', (req, res) => res.json(rightsEvidence.filter(item => item.projectId === req.params.id)));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));
app.post('/api/approvals', (req, res) => res.status(201).json(createApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => {
  const result = approve(req.params.id, req.body.status, req.body.comment);
  if (!result) return res.status(404).json({ message: '审批不存在' });
  res.json(result);
});

app.post('/api/projects/:id/delivery/preview', (req, res) => {
  try { res.json(deliveryService.previewDelivery(req.params.id, req.body?.scope)); }
  catch (error) { res.status((error as { status?: number }).status ?? 500).json({ message: (error as Error).message }); }
});
app.post('/api/projects/:id/delivery/packages', (req, res) => {
  try {
    const result = deliveryService.generateDelivery({
      projectId: req.params.id,
      scope: req.body?.scope,
      idempotencyKey: req.body?.idempotencyKey,
      failBeforePrecheck: Boolean(req.body?.failBeforePrecheck),
      failAfterPrecheck: Boolean(req.body?.failAfterPrecheck),
    });
    res.status(result.manifest.status === 'generated' ? 200 : 202).json(result);
  } catch (error) { res.status((error as { status?: number }).status ?? 500).json({ message: (error as Error).message }); }
});
app.get('/api/projects/:id/delivery/packages', (req, res) => res.json({ packages: deliveryService.listPackages(req.params.id) }));
app.get('/api/delivery/packages/:packageId', (req, res) => {
  try { res.json(deliveryService.getPackage(req.params.packageId)); }
  catch (error) { res.status((error as { status?: number }).status ?? 500).json({ message: (error as Error).message }); }
});
app.post('/api/delivery/packages/:packageId/exceptions', (req, res) => {
  try { res.status(201).json(deliveryService.addExceptions(req.params.packageId, req.body?.exceptions ?? [])); }
  catch (error) { res.status((error as { status?: number }).status ?? 500).json({ message: (error as Error).message }); }
});
app.post('/api/delivery/packages/:packageId/retry', (req, res) => {
  try { res.json(deliveryService.retryInterrupted(req.params.packageId)); }
  catch (error) { res.status((error as { status?: number }).status ?? 500).json({ message: (error as Error).message }); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));
const port = Number(process.env.PORT || 4104);
app.listen(port, () => console.log(`film rights API listening on ${port}`));
