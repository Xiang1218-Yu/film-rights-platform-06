import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  approvals, Approval, Asset, assets, contracts, Contract,
  projects, rightsProofs, RightsProof
} from './domain.js';
import { JsonStore } from './jsonStore.js';

export type DeliveryStatus = 'generating' | 'blocked' | 'ready' | 'failed';
export type CheckSeverity = 'critical' | 'warning' | 'info';
export type PackageStatus = 'not_created';

export interface DeliveryScope {
  deliveryId: string;
  assetIds: string[];
  territories: string[];
  platforms: string[];
  rightsUntil: string;
}

export interface DeliveryGenerationInput extends DeliveryScope {
  idempotencyKey: string;
  requestedBy: string;
}

export interface ApprovalSnapshot {
  id: string;
  entityType: Approval['entityType'];
  entityId: string;
  title: string;
  status: Approval['status'];
  approver: string;
  createdAt: string;
  comment?: string;
}

export interface MilestoneSnapshot {
  contractId: string;
  vendor: string;
  name: string;
  due: string;
  amount: number;
  status: string;
  critical: boolean;
}

export interface ProofSnapshot {
  id: string;
  contractId: string;
  title: string;
  status: RightsProof['status'];
  documentRef: string;
  issuedAt: string;
  expiresAt?: string;
  coversTags: string[];
  territories: string[];
  platforms: string[];
}

export interface AssetSnapshot {
  id: string;
  name: string;
  type: Asset['type'];
  version: number;
  status: Asset['status'];
  owner: string;
  checksum: string;
  territories: string[];
  platforms: string[];
  availableFrom: string;
  availableTo: string;
  rightsTags: string[];
  latestApproval?: ApprovalSnapshot;
  proofs: ProofSnapshot[];
}

export interface DeliveryCheck {
  code: string;
  severity: CheckSeverity;
  blocking: boolean;
  exceptionAllowed: boolean;
  subjectId: string;
  subjectName: string;
  message: string;
  evidence?: string;
  exceptionId?: string;
  resolvedByException?: boolean;
}

export interface DeliveryConflictSnapshot {
  severity: 'critical' | 'warning';
  subjectId: string;
  assetAId: string;
  assetBId: string;
  assetAName: string;
  assetBName: string;
  reason: string;
}

export interface ChecksumSummary {
  algorithm: 'sha256';
  assetCount: number;
  assetChecksums: { assetId: string; version: number; checksum: string }[];
  assetFingerprint: string;
  manifestDigest: string;
  objectStorageVerified: false;
  packageObjectKey: null;
}

export interface DeliveryManifest {
  id: string;
  projectId: string;
  idempotencyKey: string;
  deliveryId: string;
  scope: Omit<DeliveryScope, 'deliveryId'>;
  requestedBy: string;
  status: DeliveryStatus;
  packageStatus: PackageStatus;
  snapshotAt: string;
  createdAt: string;
  completedAt?: string;
  leaseExpiresAt?: string;
  attempts: number;
  candidateFingerprint: string;
  candidateAssetFingerprint: string;
  interruptionReason?: string;
  assets: AssetSnapshot[];
  deliveryApproval?: ApprovalSnapshot;
  milestones: MilestoneSnapshot[];
  conflicts: DeliveryConflictSnapshot[];
  checks: DeliveryCheck[];
  blockers: DeliveryCheck[];
  checksumSummary?: ChecksumSummary;
  lastError?: string;
}

export interface DeliveryException {
  id: string;
  projectId: string;
  deliveryId: string;
  code: string;
  severity: 'warning';
  subjectId: string;
  subjectName: string;
  reason: string;
  requestedBy: string;
  approver: string;
  approvedAt: string;
  expiresAt: string;
  assetIds: string[];
  status: 'approved' | 'revoked';
  revokedAt?: string;
}

interface StoreShape extends Record<string, unknown> {
  manifests: Record<string, DeliveryManifest>;
  exceptions: Record<string, DeliveryException>;
}

export class DeliveryValidationError extends Error {
  constructor(public status: number, message: string, public code = 'DELIVERY_REQUEST_INVALID') { super(message); }
}

const DEFAULT_STORE_PATH = resolve(process.cwd(), '.data/delivery-manifests.json');
const LEASE_MS = Number(process.env.DELIVERY_LEASE_MS || 30_000);
const store = new JsonStore<StoreShape>(process.env.DELIVERY_STORE_PATH || DEFAULT_STORE_PATH, { manifests: {}, exceptions: {} });
const activeLocks = new Set<string>();

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const stable = (value: unknown): string => JSON.stringify(value);
const today = () => new Date().toISOString().slice(0, 10);
const unique = <T>(items: T[]) => Array.from(new Set(items));
const hasCoverage = (holder: string[], required: string[]) => holder.includes('全球') || required.every(item => holder.includes(item));
const overlapsCoverage = (a: string[], b: string[]) => a.includes('全球') || b.includes('全球') || a.some(item => b.includes(item));

const EXCEPTIONABLE_CHECKS = new Set(['RIGHTS_CONFLICT_WARNING', 'RIGHTS_WINDOW_NOT_ACTIVE', 'CONTRACT_MILESTONE_OPEN']);
const criticalBlocker = (code: string, subjectId: string, subjectName: string, message: string, evidence?: string): DeliveryCheck => ({ code, severity: 'critical', blocking: true, exceptionAllowed: false, subjectId, subjectName, message, evidence });
const exceptionableWarning = (code: string, subjectId: string, subjectName: string, message: string, evidence?: string): DeliveryCheck => ({ code, severity: 'warning', blocking: true, exceptionAllowed: true, subjectId, subjectName, message, evidence });
const info = (code: string, subjectId: string, subjectName: string, message: string): DeliveryCheck => ({ code, severity: 'info', blocking: false, exceptionAllowed: false, subjectId, subjectName, message });

function fingerprintSnapshots(assetsForFingerprint: Pick<AssetSnapshot, 'id' | 'version' | 'checksum' | 'status' | 'availableFrom' | 'availableTo' | 'territories' | 'platforms' | 'rightsTags'>[]) {
  return sha256(stable(assetsForFingerprint.map(asset => {
    const normalized = {
      id: asset.id, version: asset.version, checksum: asset.checksum, status: asset.status,
      availableFrom: asset.availableFrom, availableTo: asset.availableTo,
      territories: [...asset.territories].sort(), platforms: [...asset.platforms].sort(),
      rightsTags: [...asset.rightsTags].sort()
    };
    return normalized;
  })));
}

function fingerprintAssets(assetsForFingerprint: Pick<Asset, 'id' | 'version' | 'checksum' | 'status' | 'availableFrom' | 'availableTo' | 'territories' | 'platforms' | 'rightsTags'>[]) {
  return fingerprintSnapshots(assetsForFingerprint);
}

function candidateFingerprint(projectId: string, request: DeliveryScope) {
  const selected = request.assetIds.map(id => assets.find(asset => asset.projectId === projectId && asset.id === id)).filter((asset): asset is Asset => Boolean(asset));
  return sha256(stable({ projectId, deliveryId: request.deliveryId, territories: [...request.territories].sort(), platforms: [...request.platforms].sort(), rightsUntil: request.rightsUntil, assets: fingerprintAssets(selected) }));
}

function latestApproval(projectId: string, entityType: Approval['entityType'], entityId: string) {
  const matching = approvals
    .filter(item => item.projectId === projectId && item.entityType === entityType && item.entityId === entityId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matching[0];
}

function approvalSnapshot(approval: Approval | undefined): ApprovalSnapshot | undefined {
  if (!approval) return undefined;
  const { id, entityType, entityId, title, status, approver, createdAt, comment } = approval;
  return { id, entityType, entityId, title, status, approver, createdAt, comment };
}

function snapshotAsset(asset: Asset): AssetSnapshot {
  return {
    id: asset.id, name: asset.name, type: asset.type, version: asset.version, status: asset.status,
    owner: asset.owner, checksum: asset.checksum, territories: asset.territories, platforms: asset.platforms,
    availableFrom: asset.availableFrom, availableTo: asset.availableTo, rightsTags: asset.rightsTags,
    latestApproval: approvalSnapshot(latestApproval(asset.projectId, 'asset', asset.id)),
    proofs: rightsProofs.filter(proof => proof.projectId === asset.projectId && proof.assetId === asset.id)
      .map(proof => ({ id: proof.id, contractId: proof.contractId, title: proof.title, status: proof.status, documentRef: proof.documentRef, issuedAt: proof.issuedAt, expiresAt: proof.expiresAt, coversTags: proof.coversTags, territories: proof.territories, platforms: proof.platforms }))
  };
}

function selectedConflicts(selected: AssetSnapshot[]): DeliveryConflictSnapshot[] {
  const result: DeliveryConflictSnapshot[] = [];
  for (let i = 0; i < selected.length; i += 1) for (let j = i + 1; j < selected.length; j += 1) {
    const a = selected[i], b = selected[j];
    const tags = a.rightsTags.filter(tag => b.rightsTags.includes(tag));
    const sameTerritory = overlapsCoverage(a.territories, b.territories);
    const samePlatform = a.platforms.some(platform => b.platforms.includes(platform));
    if (tags.length && sameTerritory && samePlatform && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom) {
      const severity = a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning';
      result.push({
        severity, subjectId: [a.id, b.id].sort().join('::'),
        assetAId: a.id, assetBId: b.id, assetAName: a.name, assetBName: b.name,
        reason: `同一授权标签在重叠窗口内覆盖相同地域/平台：${tags.join('、')}`
      });
    }
  }
  return result;
}

function validateScope(projectId: string, request: DeliveryGenerationInput) {
  if (!projects.some(project => project.id === projectId)) throw new DeliveryValidationError(404, '项目不存在', 'PROJECT_NOT_FOUND');
  if (!request.idempotencyKey.trim()) throw new DeliveryValidationError(400, 'idempotencyKey 不能为空');
  if (!request.deliveryId.trim() || !request.requestedBy.trim()) throw new DeliveryValidationError(400, '交付编号和申请人不能为空');
  if (!request.assetIds.length) throw new DeliveryValidationError(400, '至少选择一个母版、预告、字幕或音频资产');
  if (!request.territories.length || !request.platforms.length) throw new DeliveryValidationError(400, '交付地域和平台不能为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.rightsUntil)) throw new DeliveryValidationError(400, '授权有效期格式必须为 YYYY-MM-DD');
  const ids = unique(request.assetIds);
  if (ids.length !== request.assetIds.length) throw new DeliveryValidationError(400, '交付范围中存在重复资产');
  const selected = ids.map(id => {
    const asset = assets.find(item => item.projectId === projectId && item.id === id);
    if (!asset) throw new DeliveryValidationError(400, `资产 ${id} 不属于当前项目或已不存在`, 'ASSET_OUT_OF_SCOPE');
    return asset;
  });
  return { selected, territories: unique(request.territories), platforms: unique(request.platforms) };
}

function checkAssetBasics(asset: AssetSnapshot) {
  const checks: DeliveryCheck[] = [];
  if (asset.status === 'draft' || asset.status === 'review') checks.push(criticalBlocker('ASSET_NOT_LOCKED', asset.id, asset.name, `资产状态为 ${asset.status}，尚未完成锁定审批`));
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.checksum)) checks.push(criticalBlocker('ASSET_CHECKSUM_INVALID', asset.id, asset.name, '资产 checksum 不是 64 位 sha256，无法生成可复核清单', asset.checksum));
  return checks;
}

function checkApprovals(projectId: string, selected: AssetSnapshot[], deliveryId: string, deliveryApproval: ApprovalSnapshot | undefined) {
  const checks: DeliveryCheck[] = [];
  for (const asset of selected) {
    const approval = asset.latestApproval;
    if (!approval) checks.push(criticalBlocker('ASSET_APPROVAL_MISSING', asset.id, asset.name, '缺少资产锁定审批记录'));
    else if (approval.status === 'rejected') checks.push(criticalBlocker('ASSET_APPROVAL_REJECTED', asset.id, asset.name, `最新资产审批已被 ${approval.approver} 驳回`, approval.comment));
    else if (approval.status === 'pending') checks.push(criticalBlocker('ASSET_APPROVAL_PENDING', asset.id, asset.name, `资产锁定审批仍等待 ${approval.approver} 处理`));
  }
  const delivery = deliveryApproval;
  if (!delivery) checks.push(criticalBlocker('DELIVERY_APPROVAL_MISSING', deliveryId, deliveryId, '缺少本次海外节展交付审批'));
  else if (delivery.status === 'rejected') checks.push(criticalBlocker('DELIVERY_APPROVAL_REJECTED', deliveryId, deliveryId, `交付审批刚被 ${delivery.approver} 驳回`, delivery.comment));
  else if (delivery.status === 'pending') checks.push(criticalBlocker('DELIVERY_APPROVAL_PENDING', deliveryId, deliveryId, `交付审批仍等待 ${delivery.approver} 处理`));
  return checks;
}

function checkRights(projectId: string, selected: AssetSnapshot[], scope: DeliveryGenerationInput) {
  const checks: DeliveryCheck[] = [];
  for (const asset of selected) {
    if (!hasCoverage(asset.territories, scope.territories)) checks.push(criticalBlocker('ASSET_TERRITORY_NOT_COVERED', asset.id, asset.name, `资产地域不覆盖交付范围：${scope.territories.join('、')}`));
    if (!asset.platforms.some(platform => scope.platforms.includes(platform))) checks.push(criticalBlocker('ASSET_PLATFORM_NOT_COVERED', asset.id, asset.name, `资产平台不包含交付平台：${scope.platforms.join('、')}`));
    if (asset.availableFrom > scope.rightsUntil) checks.push(criticalBlocker('RIGHTS_WINDOW_UNAVAILABLE', asset.id, asset.name, `授权从 ${asset.availableFrom} 才开始，晚于交付需要的 ${scope.rightsUntil}`));
    else if (asset.availableFrom > today()) checks.push(exceptionableWarning('RIGHTS_WINDOW_NOT_ACTIVE', asset.id, asset.name, `授权窗口在 ${asset.availableFrom} 才生效；生成快照时尚不可下载`, '需记录已批准的定时生效例外，并在生效后复核'));
    if (asset.availableTo < scope.rightsUntil) checks.push(criticalBlocker('RIGHTS_WINDOW_EXPIRES_BEFORE_DELIVERY', asset.id, asset.name, `授权于 ${asset.availableTo} 到期，早于交付需要的 ${scope.rightsUntil}`));

    for (const tag of asset.rightsTags) {
      const proofs = asset.proofs.filter(proof => proof.coversTags.includes(tag));
      const validProofs = proofs.filter(proof => {
        if (proof.status !== 'received' || !proof.documentRef) return false;
        if (proof.expiresAt && proof.expiresAt < scope.rightsUntil) return false;
        return proof.issuedAt <= scope.rightsUntil;
      });
      if (!proofs.length || proofs.every(proof => proof.status === 'missing')) checks.push(criticalBlocker('RIGHTS_PROOF_MISSING', asset.id, asset.name, `法务授权证明缺失：${tag}`));
      else if (proofs.some(proof => proof.status === 'expired') || proofs.some(proof => proof.expiresAt && proof.expiresAt < scope.rightsUntil)) checks.push(criticalBlocker('RIGHTS_PROOF_EXPIRED', asset.id, asset.name, `授权证明在交付有效期前失效：${tag}`));
      else if (!validProofs.length) checks.push(criticalBlocker('RIGHTS_PROOF_INVALID', asset.id, asset.name, `授权证明未覆盖完整交付窗口：${tag}`));
      else {
        const territories = unique(validProofs.flatMap(proof => proof.territories));
        const platforms = unique(validProofs.flatMap(proof => proof.platforms));
        if (!hasCoverage(territories, scope.territories)) checks.push(criticalBlocker('RIGHTS_PROOF_TERRITORY_GAP', asset.id, asset.name, `授权证明地域未覆盖 ${scope.territories.join('、')}：${tag}`));
        const missingPlatforms = scope.platforms.filter(platform => !platforms.includes(platform) && !platforms.includes('全球'));
        if (missingPlatforms.length) checks.push(criticalBlocker('RIGHTS_PROOF_PLATFORM_GAP', asset.id, asset.name, `授权证明平台未覆盖 ${missingPlatforms.join('、')}：${tag}`));
        for (const proof of validProofs) {
          if (!contracts.some(contract => contract.projectId === projectId && contract.id === proof.contractId)) checks.push(criticalBlocker('CONTRACT_REFERENCE_MISSING', proof.id, proof.title, `授权证明引用的合同 ${proof.contractId} 不存在或不属于项目`));
        }
      }
    }
  }
  return checks;
}

function checkContracts(projectId: string, selected: AssetSnapshot[], scope: DeliveryGenerationInput) {
  const checks: DeliveryCheck[] = [];
  const proofContractIds = unique(selected.flatMap(asset => asset.proofs.map(proof => proof.contractId)));
  const linkedContracts = contracts.filter(contract => proofContractIds.includes(contract.id));
  for (const contract of linkedContracts) {
    if (!contract.id || !contract.vendor || !(contract.ceiling >= 0) || !(contract.committed >= 0) || !(contract.paid >= 0) || !Array.isArray(contract.milestones)) {
      checks.push(criticalBlocker('CONTRACT_DATA_MISSING', contract.id || 'UNKNOWN', contract.vendor || '未知合同', '合同关键字段缺失，财务不能确认交付里程碑'));
      continue;
    }
    for (const milestone of contract.milestones) {
      if (!milestone.name || !(milestone.amount >= 0) || !milestone.status || !milestone.due) {
        checks.push(criticalBlocker('CONTRACT_MILESTONE_DATA_MISSING', contract.id, contract.vendor, `合同 ${contract.vendor} 存在字段不完整的里程碑`));
        continue;
      }
      const relevant = proofContractIds.includes(contract.id) || milestone.critical;
      if (relevant && milestone.status !== 'paid' && milestone.due <= scope.rightsUntil) {
        const subjectId = `${contract.id}::${milestone.name}`;
        const message = `${contract.vendor} / ${milestone.name} 仍为 ${milestone.status}，金额 ${milestone.amount}`;
        if (milestone.critical) checks.push(criticalBlocker('CRITICAL_CONTRACT_MILESTONE_OPEN', subjectId, contract.vendor, message, `到期日 ${milestone.due}`));
        else checks.push(exceptionableWarning('CONTRACT_MILESTONE_OPEN', subjectId, contract.vendor, message, `非关键结点可凭财务记录的例外继续；到期日 ${milestone.due}`));
      }
    }
  }
  return checks;
}

async function activeExceptions(projectId: string, deliveryId: string) {
  const data = await store.read();
  const current = today();
  return Object.values(data.exceptions).filter(item =>
    item.projectId === projectId && item.deliveryId === deliveryId && item.status === 'approved' && item.expiresAt >= current
  );
}

function applyExceptions(checks: DeliveryCheck[], exceptions: DeliveryException[], conflicts: DeliveryConflictSnapshot[], selectedIds: string[]) {
  const conflictBySubject = new Map(conflicts.map(conflict => [conflict.subjectId, conflict]));
  return checks.map(check => {
    if (!check.exceptionAllowed) return check;
    const match = exceptions.find(exception => {
      if (exception.code !== check.code || exception.subjectId !== check.subjectId) return false;
      if (check.code === 'RIGHTS_CONFLICT_WARNING') {
        const conflict = conflictBySubject.get(check.subjectId);
        return Boolean(conflict && conflict.assetAId && conflict.assetBId && exception.assetIds.includes(conflict.assetAId) && exception.assetIds.includes(conflict.assetBId));
      }
      if (check.code === 'RIGHTS_WINDOW_NOT_ACTIVE') return exception.assetIds.includes(check.subjectId);
      if (check.code === 'CONTRACT_MILESTONE_OPEN') return selectedIds.length > 0;
      return true;
    });
    return match ? { ...check, blocking: false, resolvedByException: true, exceptionId: match.id } : check;
  });
}

function runChecks(projectId: string, selected: AssetSnapshot[], deliveryApproval: ApprovalSnapshot | undefined, request: DeliveryGenerationInput, snapshotAt: string, candidateAssetDigest: string, exceptions: DeliveryException[], frozenConflicts: DeliveryConflictSnapshot[] = selectedConflicts(selected)) {
  const conflicts = frozenConflicts;
  const checks: DeliveryCheck[] = [
    info('SNAPSHOT_CREATED', request.deliveryId, request.deliveryId, `快照创建于 ${snapshotAt}；对象存储未接入，未验证远端包体`),
    ...selected.flatMap(checkAssetBasics),
    ...checkApprovals(projectId, selected, request.deliveryId, deliveryApproval),
    ...checkRights(projectId, selected, request),
    ...checkContracts(projectId, selected, request)
  ];

  for (const conflict of conflicts) {
    const message = `${conflict.assetAName} ↔ ${conflict.assetBName}：${conflict.reason}`;
    if (conflict.severity === 'critical') checks.push(criticalBlocker('RIGHTS_CONFLICT_CRITICAL', conflict.subjectId, conflict.assetAName, message));
    else checks.push(exceptionableWarning('RIGHTS_CONFLICT_WARNING', conflict.subjectId, conflict.assetAName, message));
  }

  const currentFingerprint = fingerprintSnapshots(selected);
  if (currentFingerprint !== candidateAssetDigest) checks.push(criticalBlocker('ASSET_SNAPSHOT_DRIFT', 'selected-assets', '交付资产范围', '预检期间资产版本、checksum 或授权窗口已变化，必须以新版本重新发起交付清单'));

  return { checks: applyExceptions(checks, exceptions, conflicts, selected.map(asset => asset.id)), conflicts };
}

function buildChecksumSummary(selected: AssetSnapshot[], manifest: Omit<DeliveryManifest, 'checksumSummary'>): ChecksumSummary {
  const assetFingerprint = fingerprintSnapshots(selected);
  const digestSource = {
    id: manifest.id, projectId: manifest.projectId, deliveryId: manifest.deliveryId, scope: manifest.scope,
    snapshotAt: manifest.snapshotAt, assets: manifest.assets, approvals: [manifest.deliveryApproval].filter(Boolean),
    milestones: manifest.milestones, conflicts: manifest.conflicts, checks: manifest.checks
  };
  return {
    algorithm: 'sha256', assetCount: selected.length,
    assetChecksums: selected.map(asset => ({ assetId: asset.id, version: asset.version, checksum: asset.checksum })),
    assetFingerprint, manifestDigest: sha256(stable(digestSource)), objectStorageVerified: false, packageObjectKey: null
  };
}

async function persistManifest(manifest: DeliveryManifest) {
  await store.mutate(data => {
    data.manifests[manifest.id] = manifest;
  });
}

async function finalizeManifest(manifest: DeliveryManifest, hooks?: DeliveryHooks) {
  if (activeLocks.has(manifest.id)) return (await store.read()).manifests[manifest.id];
  activeLocks.add(manifest.id);
  try {
    const request: DeliveryGenerationInput = {
      deliveryId: manifest.deliveryId, assetIds: manifest.scope.assetIds,
      territories: manifest.scope.territories, platforms: manifest.scope.platforms,
      rightsUntil: manifest.scope.rightsUntil, idempotencyKey: manifest.idempotencyKey, requestedBy: manifest.requestedBy
    };
    const liveAssets = validateScope(manifest.projectId, request).selected;
    const exceptions = await activeExceptions(manifest.projectId, manifest.deliveryId);
    let selected = manifest.assets;
    let deliveryApproval = manifest.deliveryApproval;
    let milestones = manifest.milestones;
    const snapshotMatchesLive = fingerprintSnapshots(selected) === fingerprintAssets(liveAssets);
    if (!snapshotMatchesLive) {
      const drifted: DeliveryManifest = { ...manifest, status: 'blocked', leaseExpiresAt: undefined, lastError: undefined, blockers: [criticalBlocker('ASSET_SNAPSHOT_DRIFT', 'selected-assets', '交付资产范围', '重试时发现资产版本、checksum 或授权窗口已变化；旧快照不能继续交付')] };
      await persistManifest(drifted);
      return drifted;
    }
    const liveDeliveryApproval = approvalSnapshot(latestApproval(manifest.projectId, 'delivery', manifest.deliveryId));
    if (JSON.stringify(deliveryApproval) !== JSON.stringify(liveDeliveryApproval)) {
      const drifted: DeliveryManifest = { ...manifest, status: 'blocked', leaseExpiresAt: undefined, lastError: undefined, blockers: [criticalBlocker('APPROVAL_SNAPSHOT_DRIFT', manifest.deliveryId, manifest.deliveryId, '预检期间交付审批状态或意见发生变化，必须重新确认并发起新清单')] };
      await persistManifest(drifted);
      return drifted;
    }
    const liveMilestones = contracts.filter(contract => contract.projectId === manifest.projectId).flatMap(contract =>
      contract.milestones.map(milestone => ({ contractId: contract.id, vendor: contract.vendor, name: milestone.name, due: milestone.due, amount: milestone.amount, status: milestone.status, critical: Boolean(milestone.critical) }))
    );
    if (JSON.stringify(milestones) !== JSON.stringify(liveMilestones)) {
      const drifted: DeliveryManifest = { ...manifest, status: 'blocked', leaseExpiresAt: undefined, lastError: undefined, blockers: [criticalBlocker('CONTRACT_SNAPSHOT_DRIFT', 'contracts', '合同里程碑', '预检期间合同或关键里程碑状态发生变化，必须重新确认财务放行')] };
      await persistManifest(drifted);
      return drifted;
    }
    const { checks, conflicts } = runChecks(manifest.projectId, selected, deliveryApproval, request, manifest.snapshotAt, manifest.candidateAssetFingerprint, exceptions, manifest.conflicts);
    const draft: Omit<DeliveryManifest, 'checksumSummary'> = {
      ...manifest,
      assets: selected, deliveryApproval, milestones, conflicts, checks,
      blockers: [], leaseExpiresAt: undefined
    };
    const blockers = checks.filter(check => check.blocking);
    const finalized: DeliveryManifest = { ...draft, blockers, checksumSummary: buildChecksumSummary(selected, draft), completedAt: new Date().toISOString(), status: blockers.length ? 'blocked' : 'ready' };
    await persistManifest(finalized);
    await hooks?.afterManifestFinalized?.(finalized);
    return finalized;
  } catch (error) {
    const failed: DeliveryManifest = { ...manifest, status: 'failed', lastError: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString(), leaseExpiresAt: undefined };
    await persistManifest(failed);
    throw error;
  } finally {
    activeLocks.delete(manifest.id);
  }
}

export interface DeliveryHooks {
  afterSnapshotPersisted?: (manifest: DeliveryManifest) => void | Promise<void>;
  afterManifestFinalized?: (manifest: DeliveryManifest) => void | Promise<void>;
}

export async function generateDeliveryManifest(projectId: string, input: DeliveryGenerationInput, hooks?: DeliveryHooks): Promise<{ manifest: DeliveryManifest; duplicate: boolean }> {
  const request: DeliveryGenerationInput = {
    ...input,
    assetIds: unique(input.assetIds),
    territories: unique(input.territories),
    platforms: unique(input.platforms)
  };

  const { selected } = validateScope(projectId, request);
  const fingerprint = candidateFingerprint(projectId, request);
  const selectedSnapshots = selected.map(snapshotAsset);
  const assetFingerprint = fingerprintSnapshots(selectedSnapshots);
  const initialDeliveryApproval = approvalSnapshot(latestApproval(projectId, 'delivery', request.deliveryId));
  const initialMilestones = contracts.filter(contract => contract.projectId === projectId).flatMap(contract =>
    contract.milestones.map(milestone => ({ contractId: contract.id, vendor: contract.vendor, name: milestone.name, due: milestone.due, amount: milestone.amount, status: milestone.status, critical: Boolean(milestone.critical) }))
  );
  const current = await store.read();
  const existing = Object.values(current.manifests).find(manifest => manifest.projectId === projectId && manifest.idempotencyKey === request.idempotencyKey);

  if (existing) {
    if (existing.candidateFingerprint !== fingerprint) throw new DeliveryValidationError(409, '相同幂等键对应不同交付范围或资产版本，请发起新的交付预检', 'IDEMPOTENCY_KEY_REUSED');
    if (existing.status !== 'generating') return { manifest: existing, duplicate: true };
    if (existing.leaseExpiresAt && new Date(existing.leaseExpiresAt).getTime() > Date.now()) return { manifest: existing, duplicate: true };
    const resumed: DeliveryManifest = { ...existing, attempts: existing.attempts + 1, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(), status: 'generating', lastError: undefined };
    await persistManifest(resumed);
    await hooks?.afterSnapshotPersisted?.(resumed);
    return { manifest: await finalizeManifest(resumed, hooks), duplicate: false };
  }

  const result = await store.mutate(data => {
    data.seq += 1;
    const timestamp = new Date().toISOString();
    const id = `MFT-${String(data.seq).padStart(4, '0')}`;
    const manifest: DeliveryManifest = {
      id, projectId, idempotencyKey: request.idempotencyKey, deliveryId: request.deliveryId,
      scope: { assetIds: request.assetIds, territories: request.territories, platforms: request.platforms, rightsUntil: request.rightsUntil },
      requestedBy: request.requestedBy, status: 'generating', packageStatus: 'not_created',
      snapshotAt: timestamp, createdAt: timestamp, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      attempts: 1, candidateFingerprint: fingerprint, candidateAssetFingerprint: assetFingerprint,
      assets: selectedSnapshots,
      deliveryApproval: initialDeliveryApproval,
      milestones: initialMilestones,
      conflicts: selectedConflicts(selectedSnapshots), checks: [], blockers: []
    };
    data.manifests[id] = manifest;
    return manifest;
  });
  try {
    await hooks?.afterSnapshotPersisted?.(result);
  } catch (error) {
    const interrupted = { ...result, status: 'failed' as const, leaseExpiresAt: undefined, interruptionReason: error instanceof Error ? error.message : String(error) };
    await persistManifest(interrupted);
    throw error;
  }
  return { manifest: await finalizeManifest(result, hooks), duplicate: false };
}

export async function listDeliveryManifests(projectId: string) {
  if (!projects.some(project => project.id === projectId)) throw new DeliveryValidationError(404, '项目不存在', 'PROJECT_NOT_FOUND');
  const data = await store.read();
  return Object.values(data.manifests).filter(manifest => manifest.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getDeliveryManifest(projectId: string, manifestId: string) {
  const data = await store.read();
  const manifest = data.manifests[manifestId];
  if (!manifest || manifest.projectId !== projectId) throw new DeliveryValidationError(404, '交付清单不存在', 'MANIFEST_NOT_FOUND');
  return manifest;
}

export async function retryDeliveryManifest(projectId: string, manifestId: string, hooks?: DeliveryHooks) {
  const manifest = await getDeliveryManifest(projectId, manifestId);
  if (manifest.status === 'ready') return manifest;
  if (manifest.status === 'generating' && manifest.leaseExpiresAt && new Date(manifest.leaseExpiresAt).getTime() > Date.now()) {
    throw new DeliveryValidationError(409, '已有生成进程持有租约，请勿重复点击', 'GENERATION_IN_PROGRESS');
  }
  const resumed = { ...manifest, attempts: manifest.attempts + 1, status: 'generating' as const, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(), lastError: undefined };
  await persistManifest(resumed);
  return finalizeManifest(resumed, hooks);
}

export interface CreateExceptionInput {
  deliveryId: string;
  code: string;
  subjectId: string;
  subjectName: string;
  reason: string;
  requestedBy: string;
  approver: string;
  expiresAt: string;
  assetIds: string[];
}

export async function listDeliveryExceptions(projectId: string, deliveryId?: string) {
  const data = await store.read();
  return Object.values(data.exceptions)
    .filter(item => item.projectId === projectId && (!deliveryId || item.deliveryId === deliveryId))
    .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
}

export async function createDeliveryException(projectId: string, input: CreateExceptionInput) {
  if (!projects.some(project => project.id === projectId)) throw new DeliveryValidationError(404, '项目不存在', 'PROJECT_NOT_FOUND');
  if (!EXCEPTIONABLE_CHECKS.has(input.code)) throw new DeliveryValidationError(400, 'critical 阻断项必须修正，不能通过例外继续', 'EXCEPTION_NOT_ALLOWED');
  if (!input.subjectId || !input.subjectName || !input.reason || !input.requestedBy || !input.approver) throw new DeliveryValidationError(400, '例外必须包含事由、申请人、批准人和可追溯说明');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt) || input.expiresAt < today()) throw new DeliveryValidationError(400, '例外到期日无效');
  const exception: DeliveryException = {
    id: `EXC-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, projectId, ...input,
    severity: 'warning', approvedAt: new Date().toISOString(), assetIds: unique(input.assetIds), status: 'approved'
  };
  await store.mutate(data => { data.exceptions[exception.id] = exception; });
  return exception;
}

export function deliveryPolicy() {
  return {
    failClosed: [
      'critical 版权冲突、授权证明缺失/失效或地域平台窗口不覆盖',
      '资产未锁定、checksum 不合规、预检期间版本/checksum/授权字段漂移',
      '交付或资产审批缺失、待处理或刚被驳回',
      '关键合同里程碑未付款、合同引用或关键字段缺失',
      '空范围、生成中断后重试发现源数据变化、幂等键复用'
    ],
    recordedException: [
      '非 critical 版权冲突（warning）',
      '授权窗口尚未生效但会在交付日前生效',
      '不影响关键交付义务的非关键合同未结节点'
    ],
    notDelivery: 'ready 仅代表预检清单生成成功；packageStatus 固定为 not_created，未接入对象存储，不代表包已上传或交付。'
  };
}
