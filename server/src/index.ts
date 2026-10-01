import express from 'express';
import { approve, assets, budgetLines, contracts, createApproval, dashboard, projectSummary, projects, rightsConflicts } from './domain.js';
import {
  createDeliveryException, DeliveryValidationError, generateDeliveryManifest, getDeliveryManifest,
  listDeliveryExceptions, listDeliveryManifests, retryDeliveryManifest, deliveryPolicy
} from './delivery.js';

const app = express();
app.use(express.json());

const asyncRoute = (worker: express.RequestHandler): express.RequestHandler => (req, res, next) => {
  Promise.resolve(worker(req, res, next)).catch(error => {
    if (error instanceof DeliveryValidationError) return res.status(error.status).json({ message: error.message, code: error.code });
    console.error(error);
    res.status(500).json({ message: '服务端预检失败', code: 'DELIVERY_PRECHECK_FAILED' });
  });
};

const param = (value: string | string[] | undefined): string => Array.isArray(value) ? value[0] : value ?? '';
const queryParam = (value: unknown): string | undefined => typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => { const result = projectSummary(param(req.params.id)); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); });
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(param(req.params.id))));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === param(req.params.id))));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === param(req.params.id))));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));

app.get('/api/projects/:id/delivery-policy', (_req, res) => res.json(deliveryPolicy()));
app.get('/api/projects/:id/delivery-manifests', asyncRoute(async (req, res) => res.json(await listDeliveryManifests(param(req.params.id)))));
app.get('/api/projects/:id/delivery-manifests/:manifestId', asyncRoute(async (req, res) => res.json(await getDeliveryManifest(param(req.params.id), param(req.params.manifestId)))));
app.post('/api/projects/:id/delivery-manifests', asyncRoute(async (req, res) => {
  const result = await generateDeliveryManifest(param(req.params.id), req.body);
  res.status(result.duplicate ? 200 : 201).json(result);
}));
app.post('/api/projects/:id/delivery-manifests/:manifestId/retry', asyncRoute(async (req, res) => res.json(await retryDeliveryManifest(param(req.params.id), param(req.params.manifestId)))));
app.get('/api/projects/:id/delivery-exceptions', asyncRoute(async (req, res) => res.json(await listDeliveryExceptions(param(req.params.id), queryParam(req.query.deliveryId)))));
app.post('/api/projects/:id/delivery-exceptions', asyncRoute(async (req, res) => res.status(201).json(await createDeliveryException(param(req.params.id), req.body))));

app.post('/api/approvals', (req, res) => res.status(201).json(createApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => { const result = approve(param(req.params.id), req.body.status, req.body.comment); if (!result) return res.status(404).json({ message: '审批不存在' }); res.json(result); });
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));

const port = Number(process.env.PORT || 4104);
app.listen(port, () => console.log(`film rights API listening on ${port}`));
