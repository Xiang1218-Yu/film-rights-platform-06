import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Approval, Asset, Contract, Project, RightsEvidence } from './domain.js';
import { createDeliveryService } from './delivery.js';
import type { DeliveryScope } from './delivery.js';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const iso = (days: number, base = '2026-09-30T12:00:00.000Z') => new Date(Date.parse(base) + days * 86400000).toISOString().slice(0, 10);
const current = new Date('2026-09-30T12:00:00.000Z');

interface Store { projects: Project[]; assets: Asset[]; approvals: Approval[]; contracts: Contract[]; evidence: RightsEvidence[]; }

function fixture(): Store {
  const project: Project = { id: 'PRJ-T', code: 'TEST-FEST', title: 'Test Festival', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-T1', deliveryDate: iso(60) };
  const assets: Asset[] = [
    { id: 'AST-MASTER', projectId: project.id, name: 'Master', type: 'master', version: 1, status: 'locked', owner: 'post', checksum: hash('master'), territories: ['全球'], platforms: ['StreamBox'], availableFrom: iso(-10), availableTo: iso(100), rightsTags: ['music'] },
    { id: 'AST-SUB', projectId: project.id, name: 'Subtitle', type: 'subtitle', version: 1, status: 'approved', owner: 'localization', checksum: hash('subtitle'), territories: ['全球'], platforms: ['StreamBox'], availableFrom: iso(-10), availableTo: iso(100), rightsTags: ['subtitle'] },
    { id: 'AST-TRAILER', projectId: project.id, name: 'Trailer', type: 'trailer', version: 1, status: 'approved', owner: 'marketing', checksum: hash('trailer'), territories: ['全球'], platforms: ['StreamBox'], availableFrom: iso(-10), availableTo: iso(100), rightsTags: ['trailer'] },
    { id: 'AST-AUDIO', projectId: project.id, name: 'Audio', type: 'audio', version: 1, status: 'locked', owner: 'music', checksum: hash('audio'), territories: ['全球'], platforms: ['StreamBox'], availableFrom: iso(-10), availableTo: iso(100), rightsTags: ['music'] },
  ];
  const approvals: Approval[] = [
    { id: 'APR-B', projectId: project.id, entityType: 'budget', entityId: project.budgetVersionId, title: 'budget', requestedBy: 'producer', status: 'approved', approver: 'finance', createdAt: iso(-3), decidedAt: iso(-3) },
    { id: 'APR-D', projectId: project.id, entityType: 'delivery', entityId: 'DEL-T', title: 'festival delivery', requestedBy: 'distribution', status: 'approved', approver: 'legal', createdAt: iso(-3), decidedAt: iso(-3) },
    { id: 'APR-M', projectId: project.id, entityType: 'asset', entityId: 'AST-MASTER', title: 'master lock', requestedBy: 'post', status: 'approved', approver: 'producer', createdAt: iso(-3), decidedAt: iso(-3) },
  ];
  const contracts: Contract[] = [{ id: 'CTR-T', projectId: project.id, vendor: 'Vendor', scope: 'music', ceiling: 100, committed: 100, paid: 100, milestones: [{ name: 'after-festival', due: iso(90), amount: 100, status: 'open' }] }];
  const evidence: RightsEvidence[] = [
    { id: 'EVD-M', projectId: project.id, assetId: 'AST-MASTER', rightsTag: 'music', status: 'accepted', issuer: 'publisher', contractId: 'CTR-T', validFrom: iso(-10), validTo: iso(100), territories: ['全球'], platforms: ['StreamBox'], acceptedBy: 'legal' },
    { id: 'EVD-S', projectId: project.id, assetId: 'AST-SUB', rightsTag: 'subtitle', status: 'accepted', issuer: 'sub house', validFrom: iso(-10), validTo: iso(100), territories: ['全球'], platforms: ['StreamBox'], acceptedBy: 'legal' },
    { id: 'EVD-T', projectId: project.id, assetId: 'AST-TRAILER', rightsTag: 'trailer', status: 'accepted', issuer: 'talent', validFrom: iso(-10), validTo: iso(100), territories: ['全球'], platforms: ['StreamBox'], acceptedBy: 'legal' },
    { id: 'EVD-A', projectId: project.id, assetId: 'AST-AUDIO', rightsTag: 'music', status: 'accepted', issuer: 'publisher', validFrom: iso(-10), validTo: iso(100), territories: ['全球'], platforms: ['StreamBox'], acceptedBy: 'legal' },
  ];
  return { projects: [project], assets, approvals, contracts, evidence };
}

function service(store: Store) {
  return createDeliveryService({ source: () => store, now: () => current });
}
const scope = (store: Store, ids = ['AST-MASTER', 'AST-SUB']): DeliveryScope => ({ name: 'Festival package', assetIds: ids, territories: ['US'], platforms: ['StreamBox'], deliveryFrom: iso(5), deliveryTo: iso(30), requiredAssetTypes: ['master', 'subtitle'] });
const request = (store: Store, ids = ['AST-MASTER', 'AST-SUB']) => ({ projectId: store.projects[0].id, scope: scope(store, ids), idempotencyKey: randomUUID() });

test('delivery manifest passes a clean selected scope and freezes versions and checksums', () => {
  const store = fixture();
  const result = service(store).generateDelivery(request(store));
  assert.equal(result.manifest.status, 'generated');
  assert.equal(result.manifest.findings.length, 0);
  assert.equal(result.manifest.snapshot.assets.length, 2);
  assert.equal(result.manifest.snapshot.checksumSummary.assetsDigest.startsWith('sha256:'), true);
  assert.match(result.manifest.digest, /^sha256:/);
  assert.equal(result.manifest.storageDescriptor.kind, 'manifest-only');
});

test('empty selection is fail-closed and cannot look like a generated package', () => {
  const store = fixture();
  const result = service(store).generateDelivery({ ...request(store), scope: { ...scope(store), assetIds: [] } });
  assert.equal(result.manifest.status, 'blocked');
  assert.equal(result.manifest.findings.some(item => item.code === 'EMPTY_SCOPE' && item.severity === 'blocking'), true);
});

test('missing legal proof is a hard blocker with no exception path', () => {
  const store = fixture();
  store.evidence = store.evidence.filter(item => item.id !== 'EVD-S');
  const delivery = service(store);
  const output = delivery.generateDelivery(request(store));
  const item = output.manifest.findings.find(finding => finding.code === 'LEGAL_PROOF_MISSING');
  assert.equal(output.manifest.status, 'blocked');
  assert.equal(item?.exceptionAllowed, false);
  assert.throws(() => delivery.addExceptions(output.manifest.id, [{ code: 'LEGAL_PROOF_MISSING', target: 'AST-SUB:subtitle', reason: 'late', actor: 'legal' }]), /fail-closed/);
});

test('critical rights conflicts, rejected approvals, and missing contract data are fail-closed', () => {
  const conflictStore = fixture();
  const conflict = service(conflictStore).generateDelivery(request(conflictStore, ['AST-MASTER', 'AST-AUDIO', 'AST-SUB']));
  assert.equal(conflict.manifest.status, 'blocked');
  assert.equal(conflict.manifest.findings.some(item => item.code === 'RIGHTS_CONFLICT_CRITICAL'), true);

  const rejectedStore = fixture();
  rejectedStore.approvals[0].status = 'rejected';
  rejectedStore.approvals[0].decidedAt = current.toISOString();
  const rejected = service(rejectedStore).generateDelivery(request(rejectedStore));
  assert.equal(rejected.manifest.findings.some(item => item.code === 'BUDGET_APPROVAL_REJECTED'), true);
  assert.equal(rejected.manifest.status, 'blocked');

  const missingContractStore = fixture();
  missingContractStore.contracts = [];
  const missingContract = service(missingContractStore).generateDelivery(request(missingContractStore));
  assert.equal(missingContract.manifest.findings.some(item => item.code === 'CONTRACT_DATA_MISSING' || item.code === 'CONTRACT_MILESTONE_MISSING'), true);
  assert.equal(missingContract.manifest.status, 'blocked');
});

test('recorded exception can continue only for explicitly exception-allowed warnings', () => {
  const store = fixture();
  store.assets[0].checksum = 'sha256:truncated…hash';
  const delivery = service(store);
  const initial = delivery.generateDelivery(request(store));
  assert.equal(initial.manifest.status, 'exception_required');
  const warning = initial.manifest.findings.find(item => item.code === 'CHECKSUM_TRUNCATED')!;
  assert.equal(warning.exceptionAllowed, true);
  const continued = delivery.addExceptions(initial.manifest.id, [{ code: warning.code, target: warning.target, reason: '完整哈希已由法务邮件另行保存，下载前替换', actor: '法务负责人' }]);
  assert.equal(continued.manifest.status, 'generated');
  assert.equal(continued.manifest.exceptions.length, 1);
});

test('duplicate generate click returns the same manifest for the same idempotency key', () => {
  const store = fixture();
  const delivery = service(store);
  const payload = request(store);
  const first = delivery.generateDelivery(payload);
  const second = delivery.generateDelivery(payload);
  assert.equal(second.reused, true);
  assert.equal(second.manifest.id, first.manifest.id);
});

test('precheck interruption retries against the same snapshot but post-final drift is fail-closed', () => {
  const store = fixture();
  const delivery = service(store);
  const interrupted = delivery.generateDelivery({ ...request(store), failAfterPrecheck: true });
  assert.equal(interrupted.manifest.status, 'interrupted');
  store.assets[0].version += 1;
  store.assets[0].checksum = hash('master-v2');
  const retried = delivery.retryInterrupted(interrupted.manifest.id);
  assert.equal(retried.manifest.status, 'blocked');
  assert.equal(retried.manifest.findings.some(item => item.code === 'SNAPSHOT_DRIFT'), true);
  assert.equal(retried.manifest.id, interrupted.manifest.id);
});

test('license window crossing during generation blocks reuse of the old snapshot', () => {
  const store = fixture();
  const delivery = service(store);
  const interrupted = delivery.generateDelivery({ ...request(store), failAfterPrecheck: true });
  store.assets[1].availableTo = iso(20);
  const retried = delivery.retryInterrupted(interrupted.manifest.id);
  assert.equal(retried.manifest.status, 'blocked');
  assert.equal(retried.manifest.findings.some(item => item.code === 'LICENSE_WINDOW_CROSSED_GENERATION'), true);
});

test('reopening a generated package still reports the same immutable snapshot and current drift', () => {
  const store = fixture();
  const delivery = service(store);
  const generated = delivery.generateDelivery(request(store));
  store.assets[0].version += 1;
  const reopened = delivery.getPackage(generated.manifest.id);
  assert.equal(reopened.manifest.snapshot.assets[0].version, 1);
  assert.equal(reopened.drift?.some(item => item.code === 'SNAPSHOT_DRIFT'), true);
});
