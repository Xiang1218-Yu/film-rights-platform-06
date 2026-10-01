process.env.DELIVERY_STORE_PATH = '/tmp/frame-ledger-delivery-test.json';

import test from 'node:test';
import assert from 'node:assert/strict';
import { after, beforeEach } from 'node:test';
import { rm } from 'node:fs/promises';
import { approvals, assets, contracts, rightsProofs } from './domain.js';
import { createDeliveryException, generateDeliveryManifest, getDeliveryManifest, retryDeliveryManifest } from './delivery.js';

const baseInput = () => ({
  deliveryId: 'DEL-007',
  assetIds: ['AST-006', 'AST-005'],
  territories: ['CN'],
  platforms: ['StreamBox'],
  rightsUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  idempotencyKey: `key-${Math.random()}`,
  requestedBy: '发行部'
});

const savedAssets = assets.map(asset => ({ ...asset, territories: [...asset.territories], platforms: [...asset.platforms], rightsTags: [...asset.rightsTags] }));
const savedApprovals = approvals.map(approval => ({ ...approval }));
const savedProofs = rightsProofs.map(proof => ({ ...proof, territories: [...proof.territories], platforms: [...proof.platforms], coversTags: [...proof.coversTags] }));
const savedContracts = contracts.map(contract => ({ ...contract, milestones: contract.milestones.map(milestone => ({ ...milestone })) }));
const restore = () => {
  assets.splice(0, assets.length, ...savedAssets.map(asset => ({ ...asset, territories: [...asset.territories], platforms: [...asset.platforms], rightsTags: [...asset.rightsTags] })));
  approvals.splice(0, approvals.length, ...savedApprovals.map(approval => ({ ...approval })));
  rightsProofs.splice(0, rightsProofs.length, ...savedProofs.map(proof => ({ ...proof, territories: [...proof.territories], platforms: [...proof.platforms], coversTags: [...proof.coversTags] })));
  contracts.splice(0, contracts.length, ...savedContracts.map(contract => ({ ...contract, milestones: contract.milestones.map(milestone => ({ ...milestone })) })));
};

beforeEach(restore);
after(async () => {
  restore();
  await rm(process.env.DELIVERY_STORE_PATH!, { force: true });
});

test('delivery precheck fails closed and never reports an empty ready shell', async () => {
  const input = { ...baseInput(), assetIds: ['AST-001', 'AST-003'] };
  const { manifest, duplicate } = await generateDeliveryManifest('PRJ-001', input);
  assert.equal(duplicate, false);
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.packageStatus, 'not_created');
  assert.ok(manifest.checksumSummary);
  assert.equal(manifest.checksumSummary.objectStorageVerified, false);
  assert.equal(manifest.checksumSummary.assetCount, 2);
  assert.ok(manifest.blockers.some(check => check.code === 'RIGHTS_PROOF_MISSING'));
  assert.ok(manifest.blockers.some(check => check.code === 'CRITICAL_CONTRACT_MILESTONE_OPEN'));
});

test('duplicate clicks return the same immutable snapshot and digest', async () => {
  const input = baseInput();
  const first = await generateDeliveryManifest('PRJ-001', input);
  const second = await generateDeliveryManifest('PRJ-001', input);
  assert.equal(first.manifest.id, second.manifest.id);
  assert.equal(second.duplicate, true);
  assert.equal(first.manifest.snapshotAt, second.manifest.snapshotAt);
  assert.equal(first.manifest.checksumSummary?.manifestDigest, second.manifest.checksumSummary?.manifestDigest);
});

test('asset swap during generation is detected and blocks retry unless a fresh manifest is created', async t => {
  const input = baseInput();
  const first = await generateDeliveryManifest('PRJ-001', input, {
    afterSnapshotPersisted: () => {
      const asset = assets.find(item => item.id === 'AST-006');
      if (!asset) throw new Error('AST-006 missing');
      asset.version += 1;
      asset.checksum = `sha256:${'88'.repeat(32)}`;
    }
  });
  assert.equal(first.manifest.status, 'blocked');
  assert.ok(first.manifest.blockers.some(check => check.code === 'ASSET_SNAPSHOT_DRIFT'));

  const retried = await retryDeliveryManifest('PRJ-001', first.manifest.id);
  assert.equal(retried.status, 'blocked');
  assert.ok(retried.blockers.some(check => check.code === 'ASSET_SNAPSHOT_DRIFT'));

  const fresh = await generateDeliveryManifest('PRJ-001', { ...input, idempotencyKey: `fresh-${Math.random()}` });
  assert.equal(fresh.manifest.status, 'ready');
  assert.equal(fresh.duplicate, false);
  t.after(restore);
});

test('an interrupted stale generation can be retried against the same snapshot', async () => {
  const input = baseInput();
  let interruptedId = '';
  let firstFailure: unknown;
  try {
    await generateDeliveryManifest('PRJ-001', input, {
      afterSnapshotPersisted: manifest => {
        interruptedId = manifest.id;
        throw new Error('network interrupted');
      }
    });
  } catch (error) {
    firstFailure = error;
  }
  assert.ok(firstFailure instanceof Error);

  const stored = await getDeliveryManifest('PRJ-001', interruptedId);
  assert.equal(stored.interruptionReason, 'network interrupted');
  const resumed = await retryDeliveryManifest('PRJ-001', interruptedId);
  assert.equal(resumed.status, 'ready');
  assert.equal(resumed.id, interruptedId);
  assert.equal(resumed.attempts, 2);
  assert.equal(resumed.snapshotAt, stored.snapshotAt);
});

test('critical rights conflict is fail-closed and cannot use a warning exception', async () => {
  const input = { ...baseInput(), assetIds: ['AST-001', 'AST-003'] };
  const { manifest } = await generateDeliveryManifest('PRJ-001', input);
  const conflict = manifest.blockers.find(check => check.code === 'RIGHTS_CONFLICT_CRITICAL');
  assert.ok(conflict);
  assert.equal(conflict.exceptionAllowed, false);
});

test('rights window crossing a boundary while generating fails closed on the frozen snapshot', async () => {
  const input = baseInput();
  const result = await generateDeliveryManifest('PRJ-001', input, {
    afterSnapshotPersisted: () => {
      const asset = assets.find(item => item.id === 'AST-006');
      if (!asset) throw new Error('AST-006 missing');
      asset.availableTo = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    }
  });
  assert.equal(result.manifest.status, 'blocked');
  assert.ok(result.manifest.blockers.some(check => check.code === 'ASSET_SNAPSHOT_DRIFT'));
  assert.ok(result.manifest.assets.some(asset => asset.id === 'AST-006' && asset.availableTo !== new Date(Date.now() + 86400000).toISOString().slice(0, 10)));
});

test('newly rejected delivery approval is a critical blocker without exception', async () => {
  const approval = approvals.find(item => item.id === 'APR-04');
  assert.ok(approval);
  approval.status = 'rejected';
  approval.comment = '法务发现新增放映地未授权';
  const { manifest } = await generateDeliveryManifest('PRJ-001', baseInput());
  assert.equal(manifest.status, 'blocked');
  const blocker = manifest.blockers.find(check => check.code === 'DELIVERY_APPROVAL_REJECTED');
  assert.ok(blocker);
  assert.equal(blocker.exceptionAllowed, false);
});

test('missing contract data fails closed for finance review', async () => {
  const contract = contracts.find(item => item.id === 'CTR-04');
  assert.ok(contract);
  contract.vendor = '';
  const { manifest } = await generateDeliveryManifest('PRJ-001', baseInput());
  assert.equal(manifest.status, 'blocked');
  assert.ok(manifest.blockers.some(check => check.code === 'CONTRACT_DATA_MISSING'));
});

test('recorded warning exception can allow generation while retaining traceability', async () => {
  const trailer = assets.find(item => item.id === 'AST-006');
  assert.ok(trailer);
  trailer.availableFrom = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const input = { ...baseInput(), idempotencyKey: `blocked-${Math.random()}`, assetIds: ['AST-006', 'AST-005'] };
  const blocked = await generateDeliveryManifest('PRJ-001', input);
  const warning = blocked.manifest.blockers.find(check => check.code === 'RIGHTS_WINDOW_NOT_ACTIVE');
  assert.ok(warning);

  const exception = await createDeliveryException('PRJ-001', {
    deliveryId: input.deliveryId, code: 'RIGHTS_WINDOW_NOT_ACTIVE', subjectId: 'AST-006',
    subjectName: warning.subjectName, reason: '节展平台确认预交付后播放，授权将于五日后生效',
    requestedBy: '发行部', approver: '法务负责人', expiresAt: input.rightsUntil, assetIds: ['AST-006']
  });
  const resumed = await retryDeliveryManifest('PRJ-001', blocked.manifest.id);
  assert.equal(resumed.status, 'ready');
  const resolved = resumed.checks.find(check => check.code === 'RIGHTS_WINDOW_NOT_ACTIVE');
  assert.equal(resolved?.resolvedByException, true);
  assert.equal(resolved?.exceptionId, exception.id);
});
