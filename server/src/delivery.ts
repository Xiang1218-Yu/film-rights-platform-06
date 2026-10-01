import { createHash, randomUUID } from 'node:crypto';
import type { Approval, Asset, Contract, Project, RightsEvidence } from './domain.js';
import { approvals as defaultApprovals, assets as defaultAssets, contracts as defaultContracts, projects as defaultProjects, rightsEvidence as defaultEvidence, auditEvents } from './domain.js';

export type PackageStatusCode = 'blocked' | 'exception_required' | 'interrupted' | 'ready' | 'generated';
export type FindingCategory = 'scope' | 'asset' | 'checksum' | 'rights' | 'approval' | 'contract' | 'snapshot';
export type FindingSeverity = 'blocking' | 'warning';

export interface DeliveryScope {
  name: string;
  assetIds: string[];
  territories: string[];
  platforms: string[];
  deliveryFrom: string;
  deliveryTo: string;
  requiredAssetTypes: Asset['type'][];
}

export interface DeliveryFinding {
  code: string;
  severity: FindingSeverity;
  category: FindingCategory;
  message: string;
  target: string;
  exceptionAllowed: boolean;
  waiverId?: string;
  detectedAt: string;
}

export interface DeliveryException {
  id: string;
  code: string;
  target: string;
  reason: string;
  actor: string;
  at: string;
}

export interface ScopedAssetSnapshot {
  assetId: string;
  name: string;
  type: Asset['type'];
  version: number;
  status: Asset['status'];
  checksum: string;
  territories: string[];
  platforms: string[];
  availableFrom: string;
  availableTo: string;
  rightsTags: string[];
}

export interface ApprovalSnapshot { id: string; entityType: Approval['entityType']; entityId: string; status: Approval['status']; decidedAt?: string; }
export interface MilestoneSnapshot { contractId: string; vendor: string; name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid'; }
export interface EvidenceSnapshot { id: string; assetId: string; rightsTag: string; status: RightsEvidence['status']; validFrom: string; validTo: string; territories: string[]; platforms: string[]; contractId?: string; }

export interface DeliverySnapshot {
  at: string;
  projectId: string;
  budgetVersionId: string;
  scope: DeliveryScope;
  assets: ScopedAssetSnapshot[];
  approvals: ApprovalSnapshot[];
  milestones: MilestoneSnapshot[];
  evidence: EvidenceSnapshot[];
  checksumSummary: { assetCount: number; assetsDigest: string; truncatedChecksumCount: number };
}

export interface PackageLifecycleEvent { at: string; stage: string; result: string; detail?: string; }

export interface DeliveryManifest {
  schemaVersion: 1;
  id: string;
  projectId: string;
  idempotencyKey: string;
  status: PackageStatusCode;
  scope: DeliveryScope;
  snapshot: DeliverySnapshot;
  finalizedAt?: string;
  findings: DeliveryFinding[];
  exceptions: DeliveryException[];
  storageDescriptor: { kind: 'manifest-only'; note: string };
  lifecycle: PackageLifecycleEvent[];
  digest: string;
}

export interface DeliveryPackageResult {
  manifest: DeliveryManifest;
  reused: boolean;
  currentBlockers?: DeliveryFinding[];
  drift?: DeliveryFinding[];
}

export interface GenerateDeliveryRequest {
  projectId: string;
  scope: DeliveryScope;
  idempotencyKey: string;
  failBeforePrecheck?: boolean;
  failAfterPrecheck?: boolean;
}

interface DeliveryDataSource {
  projects: Project[];
  assets: Asset[];
  approvals: Approval[];
  contracts: Contract[];
  evidence: RightsEvidence[];
}

interface DeliveryServiceOptions {
  source?: () => DeliveryDataSource;
  now?: () => Date;
}

const DAY_MS = 86_400_000;
const dateMs = (value: string) => Date.parse(`${value}T00:00:00.000Z`);
const isISODate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dateMs(value));
const sortText = (values: string[]) => [...values].map(String).sort();
const overlapTerritory = (wanted: string[], actual: string[]) => actual.includes('全球') || wanted.some(item => actual.includes(item));
const coversTerritory = (wanted: string[], actual: string[]) => actual.includes('全球') || wanted.every(item => actual.includes(item));
const coversPlatform = (wanted: string[], actual: string[]) => wanted.every(item => actual.includes(item));

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestManifest(manifest: Omit<DeliveryManifest, 'digest'>) {
  return `sha256:${createHash('sha256').update(stableStringify(manifest)).digest('hex')}`;
}

function assetsDigest(assets: Pick<ScopedAssetSnapshot, 'assetId' | 'version' | 'checksum'>[]) {
  const payload = sortText(assets.map(asset => `${asset.assetId}|v${asset.version}|${asset.checksum}`)).join('\n');
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function finding(code: string, severity: FindingSeverity, category: FindingCategory, target: string, message: string, exceptionAllowed: boolean, at: Date = new Date()): DeliveryFinding {
  return { code, severity, category, target, message, exceptionAllowed, detectedAt: at.toISOString() };
}

function makeSnapshot(project: Project, scope: DeliveryScope, source: DeliveryDataSource, at: Date): DeliverySnapshot {
  const assets = source.assets
    .filter(asset => asset.projectId === project.id && scope.assetIds.includes(asset.id))
    .map(asset => ({ assetId: asset.id, name: asset.name, type: asset.type, version: asset.version, status: asset.status, checksum: asset.checksum, territories: [...asset.territories], platforms: [...asset.platforms], availableFrom: asset.availableFrom, availableTo: asset.availableTo, rightsTags: [...asset.rightsTags] }));
  const approvals = source.approvals.filter(item => item.projectId === project.id).map(item => ({ id: item.id, entityType: item.entityType, entityId: item.entityId, status: item.status, decidedAt: item.decidedAt }));
  const milestones = source.contracts.filter(contract => contract.projectId === project.id).flatMap(contract => contract.milestones.map(milestone => ({ contractId: contract.id, vendor: contract.vendor, name: milestone.name, due: milestone.due, amount: milestone.amount, status: milestone.status })));
  const evidence = source.evidence.filter(item => item.projectId === project.id).map(item => ({ id: item.id, assetId: item.assetId, rightsTag: item.rightsTag, status: item.status, validFrom: item.validFrom, validTo: item.validTo, territories: [...item.territories], platforms: [...item.platforms], contractId: item.contractId }));
  return {
    at: at.toISOString(),
    projectId: project.id,
    budgetVersionId: project.budgetVersionId,
    scope,
    assets,
    approvals,
    milestones,
    evidence,
    checksumSummary: { assetCount: assets.length, assetsDigest: assetsDigest(assets), truncatedChecksumCount: assets.filter(asset => asset.checksum.includes('…')).length },
  };
}

function latestApproval(rows: Approval[]) {
  return [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

function evaluateSnapshot(snapshot: DeliverySnapshot, project: Project, source: DeliveryDataSource, at: Date): DeliveryFinding[] {
  const findings: DeliveryFinding[] = [];
  const add = (...args: [string, FindingSeverity, FindingCategory, string, string, boolean]) => findings.push(finding(...args, at));
  const scope = snapshot.scope;

  if (!scope.assetIds.length) add('EMPTY_SCOPE', 'blocking', 'scope', 'scope.assetIds', '交付范围未选择任何资产，fail-closed 拒绝生成空交付包。', false);
  if (!scope.territories.length) add('SCOPE_TERRITORY_MISSING', 'blocking', 'scope', 'scope.territories', '交付范围缺少地域。', false);
  if (!scope.platforms.length) add('SCOPE_PLATFORM_MISSING', 'blocking', 'scope', 'scope.platforms', '交付范围缺少平台。', false);
  if (!isISODate(scope.deliveryFrom) || !isISODate(scope.deliveryTo) || dateMs(scope.deliveryFrom) > dateMs(scope.deliveryTo)) add('DELIVERY_WINDOW_INVALID', 'blocking', 'scope', 'scope.deliveryWindow', '交付有效期缺失或起止顺序错误。', false);

  const selectedIds = new Set(scope.assetIds);
  for (const assetId of scope.assetIds) {
    if (!source.assets.some(asset => asset.id === assetId && asset.projectId === project.id)) add('ASSET_NOT_FOUND', 'blocking', 'asset', assetId, '所选资产不存在或不属于当前项目。', false);
  }
  for (const requiredType of scope.requiredAssetTypes) {
    if (!snapshot.assets.some(asset => asset.type === requiredType)) add('REQUIRED_ASSET_MISSING', 'blocking', 'asset', requiredType, `交付范围缺少必需资产类型：${requiredType}。`, false);
  }

  for (const asset of snapshot.assets) {
    if (!asset.checksum.startsWith('sha256:') || asset.checksum.length < 16) add('CHECKSUM_INVALID', 'blocking', 'checksum', asset.assetId, `${asset.name} 缺少有效 sha256 校验值，无法形成可复核清单。`, false);
    else if (asset.checksum.includes('…')) add('CHECKSUM_TRUNCATED', 'warning', 'checksum', asset.assetId, `${asset.name} 当前登记的是缩略 checksum；对象存储下载前应替换为完整哈希。此问题可凭书面例外继续预检，但不能当作字节级验收。`, true);
    if (asset.status === 'draft' || asset.status === 'review') add('ASSET_NOT_LOCKED', 'blocking', 'asset', asset.assetId, `${asset.name} 仍为 ${asset.status}，未完成资产审批/锁定。`, false);
    if (!coversTerritory(scope.territories, asset.territories)) add('ASSET_TERRITORY_NOT_LICENSED', 'blocking', 'rights', asset.assetId, `${asset.name} 的资产授权地域不覆盖交付地域 ${scope.territories.join('、')}。`, false);
    if (!coversPlatform(scope.platforms, asset.platforms)) add('ASSET_PLATFORM_NOT_LICENSED', 'blocking', 'rights', asset.assetId, `${asset.name} 的资产授权平台不覆盖交付平台 ${scope.platforms.join('、')}。`, false);
    if (isISODate(scope.deliveryFrom) && isISODate(scope.deliveryTo)) {
      if (dateMs(asset.availableFrom) > dateMs(scope.deliveryFrom) || dateMs(asset.availableTo) < dateMs(scope.deliveryTo)) add('LICENSE_WINDOW_OUT_OF_BOUNDS', 'blocking', 'rights', asset.assetId, `${asset.name} 授权窗口 ${asset.availableFrom} 至 ${asset.availableTo} 不覆盖完整交付窗口。`, false);
      if (Math.abs(dateMs(asset.availableFrom) - dateMs(scope.deliveryFrom)) <= DAY_MS || Math.abs(dateMs(asset.availableTo) - dateMs(scope.deliveryTo)) <= DAY_MS) add('LICENSE_WINDOW_BOUNDARY_RISK', 'warning', 'rights', asset.assetId, `${asset.name} 授权窗口与交付边界相距不超过一天，发行前需由法务再次核对时区与续约凭证。`, true);
    }

    const evidenceRows = snapshot.evidence.filter(item => item.assetId === asset.assetId);
    for (const tag of asset.rightsTags) {
      const matches = evidenceRows.filter(item => item.rightsTag === tag);
      const accepted = matches.find(item => item.status === 'accepted' && coversTerritory(scope.territories, item.territories) && coversPlatform(scope.platforms, item.platforms) && dateMs(item.validFrom) <= dateMs(scope.deliveryFrom) && dateMs(item.validTo) >= dateMs(scope.deliveryTo));
      if (!matches.length) add('LEGAL_PROOF_MISSING', 'blocking', 'rights', `${asset.assetId}:${tag}`, `${asset.name} 的「${tag}」没有授权证明登记，法务下载前无法核验。`, false);
      else if (!accepted) {
        const item = matches[0];
        if (item.status !== 'accepted') add('LEGAL_PROOF_NOT_ACCEPTED', 'blocking', 'rights', item.id, `${asset.name} 的「${tag}」授权证明状态为 ${item.status}，尚未经法务接受。`, false);
        else add('LEGAL_PROOF_SCOPE_MISMATCH', 'blocking', 'rights', item.id, `${asset.name} 的「${tag}」授权证明未覆盖所选地域、平台或完整交付有效期。`, false);
      }
      const referencedContract = matches.find(item => item.contractId)?.contractId;
      if (referencedContract && !source.contracts.some(contract => contract.id === referencedContract && contract.projectId === project.id)) add('CONTRACT_DATA_MISSING', 'blocking', 'contract', referencedContract, `${asset.name} 的授权证明引用了不存在或已移出项目的合同 ${referencedContract}。`, false);
    }
  }

  const currentAssets = source.assets.filter(asset => selectedIds.has(asset.id));
  for (let i = 0; i < currentAssets.length; i += 1) {
    for (let j = i + 1; j < currentAssets.length; j += 1) {
      const a = currentAssets[i], b = currentAssets[j];
      const sharedTags = a.rightsTags.filter(tag => b.rightsTags.includes(tag));
      const sameTerritory = overlapTerritory(a.territories, b.territories);
      const overlaps = sharedTags.length && sameTerritory && dateMs(a.availableTo) >= dateMs(b.availableFrom) && dateMs(b.availableTo) >= dateMs(a.availableFrom);
      if (overlaps) {
        const target = `${a.id}|${b.id}`;
        const reason = `同一授权标签 ${sharedTags.join('、')} 在重叠窗口覆盖相同地域。`;
        if (a.status === 'locked' || b.status === 'locked') add('RIGHTS_CONFLICT_CRITICAL', 'blocking', 'rights', target, `CRITICAL 版权冲突：${a.name} ↔ ${b.name}；${reason}`, false);
        else add('RIGHTS_CONFLICT_WARNING', 'warning', 'rights', target, `版权冲突需复核：${a.name} ↔ ${b.name}；${reason}`, true);
      }
    }
  }

  const budgetApproval = latestApproval(source.approvals.filter(item => item.projectId === project.id && item.entityType === 'budget' && item.entityId === project.budgetVersionId));
  if (!budgetApproval) add('BUDGET_APPROVAL_MISSING', 'blocking', 'approval', project.budgetVersionId, `预算版本 ${project.budgetVersionId} 没有审批记录。`, false);
  else if (budgetApproval.status === 'rejected') add('BUDGET_APPROVAL_REJECTED', 'blocking', 'approval', budgetApproval.id, `预算审批刚被驳回：${budgetApproval.title}。`, false);
  else if (budgetApproval.status === 'pending') add('BUDGET_APPROVAL_PENDING', 'blocking', 'approval', budgetApproval.id, `关键预算审批仍待处理：${budgetApproval.title}。`, false);

  const deliveryApproval = latestApproval(source.approvals.filter(item => item.projectId === project.id && item.entityType === 'delivery'));
  if (!deliveryApproval) add('DELIVERY_APPROVAL_MISSING', 'blocking', 'approval', 'delivery', '没有交付包审批记录。', false);
  else if (deliveryApproval.status === 'rejected') add('DELIVERY_APPROVAL_REJECTED', 'blocking', 'approval', deliveryApproval.id, `交付审批刚被驳回：${deliveryApproval.title}。`, false);
  else if (deliveryApproval.status === 'pending') add('DELIVERY_APPROVAL_PENDING', 'blocking', 'approval', deliveryApproval.id, `交付审批仍待处理：${deliveryApproval.title}。`, false);

  for (const asset of snapshot.assets) {
    const assetApproval = latestApproval(source.approvals.filter(item => item.projectId === project.id && item.entityType === 'asset' && item.entityId === asset.assetId));
    if (assetApproval?.status === 'rejected') add('ASSET_APPROVAL_REJECTED', 'blocking', 'approval', assetApproval.id, `${asset.name} 的审批已被驳回。`, false);
    else if (assetApproval?.status === 'pending') add('ASSET_APPROVAL_PENDING', 'blocking', 'approval', assetApproval.id, `${asset.name} 的审批仍待处理。`, false);
  }

  if (isISODate(scope.deliveryTo)) {
    for (const contract of source.contracts.filter(item => item.projectId === project.id)) {
      if (contract.milestones.length === 0) add('CONTRACT_MILESTONE_MISSING', 'blocking', 'contract', contract.id, `合同 ${contract.vendor} 没有任何里程碑数据。`, false);
      for (const milestone of contract.milestones) {
        if (milestone.status === 'paid') continue;
        const target = `${contract.id}:${milestone.name}`;
        const message = `合同 ${contract.vendor} 的里程碑「${milestone.name}」仍为 ${milestone.status}，金额 ${milestone.amount}。`;
        if (dateMs(milestone.due) <= dateMs(scope.deliveryTo)) add('CONTRACT_MILESTONE_OPEN', 'blocking', 'contract', target, message, false);
        else if (dateMs(milestone.due) <= dateMs(project.deliveryDate)) add('CONTRACT_MILESTONE_AFTER_SCOPE', 'warning', 'contract', target, `${message} 该结点晚节节展窗口但早于项目总交付日，可记录例外先交付节展。`, true);
      }
    }
  }

  return findings;
}

function detectDrift(snapshot: DeliverySnapshot, source: DeliveryDataSource, at: Date): DeliveryFinding[] {
  const findings: DeliveryFinding[] = [];
  const add = (...args: [string, FindingSeverity, FindingCategory, string, string, boolean]) => findings.push(finding(...args, at));

  for (const oldAsset of snapshot.assets) {
    const current = source.assets.find(asset => asset.id === oldAsset.assetId);
    if (!current) { add('SNAPSHOT_ASSET_REMOVED', 'blocking', 'snapshot', oldAsset.assetId, `预检后资产 ${oldAsset.name} 已被移出登记。`, false); continue; }
    const fields: Array<[keyof ScopedAssetSnapshot, unknown, unknown, string]> = [
      ['version', oldAsset.version, current.version, '版本被换版'],
      ['status', oldAsset.status, current.status, '资产状态变化'],
      ['checksum', oldAsset.checksum, current.checksum, 'checksum 变化'],
      ['territories', sortText(oldAsset.territories).join('|'), sortText(current.territories).join('|'), '地域变化'],
      ['platforms', sortText(oldAsset.platforms).join('|'), sortText(current.platforms).join('|'), '平台变化'],
      ['availableFrom', oldAsset.availableFrom, current.availableFrom, '授权开始时间变化'],
      ['availableTo', oldAsset.availableTo, current.availableTo, '授权截止时间变化'],
      ['rightsTags', sortText(oldAsset.rightsTags).join('|'), sortText(current.rightsTags).join('|'), '版权标签变化'],
    ];
    for (const [field, before, after, label] of fields) if (before !== after) add('SNAPSHOT_DRIFT', 'blocking', 'snapshot', `${oldAsset.assetId}:${field}`, `预检后${label}：${oldAsset.name}（${field}）。必须回到当前数据重新生成。`, false);
  }

  for (const oldEvidence of snapshot.evidence) {
    const current = source.evidence.find(item => item.id === oldEvidence.id);
    if (!current) add('SNAPSHOT_EVIDENCE_REMOVED', 'blocking', 'snapshot', oldEvidence.id, '预检后授权证明被移除。', false);
    else if (current.status !== oldEvidence.status || current.validFrom !== oldEvidence.validFrom || current.validTo !== oldEvidence.validTo || sortText(current.territories).join('|') !== sortText(oldEvidence.territories).join('|') || sortText(current.platforms).join('|') !== sortText(oldEvidence.platforms).join('|')) add('SNAPSHOT_DRIFT', 'blocking', 'snapshot', oldEvidence.id, '预检后授权证明状态或授权范围发生变化。', false);
  }

  for (const oldApproval of snapshot.approvals) {
    const current = source.approvals.find(item => item.id === oldApproval.id);
    if (!current) add('SNAPSHOT_APPROVAL_REMOVED', 'blocking', 'snapshot', oldApproval.id, '预检后审批记录消失。', false);
    else if (current.status !== oldApproval.status) add('SNAPSHOT_DRIFT', 'blocking', 'snapshot', oldApproval.id, `预检后审批 ${current.title} 状态从 ${oldApproval.status} 变为 ${current.status}。`, false);
  }

  for (const oldMilestone of snapshot.milestones) {
    const contract = source.contracts.find(item => item.id === oldMilestone.contractId);
    const current = contract?.milestones.find(item => item.name === oldMilestone.name);
    if (!contract || !current) add('SNAPSHOT_CONTRACT_REMOVED', 'blocking', 'snapshot', `${oldMilestone.contractId}:${oldMilestone.name}`, '预检后合同或里程碑数据消失。', false);
    else if (current.status !== oldMilestone.status) add('SNAPSHOT_DRIFT', 'blocking', 'snapshot', `${oldMilestone.contractId}:${oldMilestone.name}`, `预检后合同里程碑状态从 ${oldMilestone.status} 变为 ${current.status}。`, false);
  }

  return findings;
}

function recheckWindowAtFinalize(snapshot: DeliverySnapshot, source: DeliveryDataSource, at: Date): DeliveryFinding[] {
  return snapshot.assets.flatMap(asset => {
    const current = source.assets.find(item => item.id === asset.assetId);
    if (!current) return [];
    if (dateMs(current.availableFrom) > dateMs(snapshot.scope.deliveryFrom) || dateMs(current.availableTo) < dateMs(snapshot.scope.deliveryTo)) return [finding('LICENSE_WINDOW_CROSSED_GENERATION', 'blocking', 'snapshot', asset.assetId, `生成期间授权窗口已跨过交付边界：${asset.name} 当前窗口 ${current.availableFrom} 至 ${current.availableTo}。`, false, at)];
    return [];
  });
}

function audit(action: string, entityId: string, details: string, actor = 'delivery-precheck') {
  auditEvents.unshift({ id: `AUD-${Date.now()}-${randomUUID().slice(0, 8)}`, action, entity: 'delivery-package', entityId, actor, at: new Date().toISOString(), details });
}

export function createDeliveryService(options: DeliveryServiceOptions = {}) {
  const getSource = options.source ?? (() => ({ projects: defaultProjects, assets: defaultAssets, approvals: defaultApprovals, contracts: defaultContracts, evidence: defaultEvidence }));
  const clock = options.now ?? (() => new Date());
  const packages = new Map<string, DeliveryManifest>();

  function projectOrThrow(projectId: string) {
    const project = getSource().projects.find(item => item.id === projectId);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    return project;
  }

  function normalizeScope(input: Partial<DeliveryScope> | undefined): DeliveryScope {
    return {
      name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : '海外节展交付包',
      assetIds: Array.from(new Set(Array.isArray(input?.assetIds) ? input.assetIds.filter((id): id is string => typeof id === 'string') : [])),
      territories: Array.from(new Set(Array.isArray(input?.territories) ? input.territories.filter((id): id is string => typeof id === 'string' && Boolean(id)) : [])),
      platforms: Array.from(new Set(Array.isArray(input?.platforms) ? input.platforms.filter((id): id is string => typeof id === 'string' && Boolean(id)) : [])),
      deliveryFrom: typeof input?.deliveryFrom === 'string' ? input.deliveryFrom : '',
      deliveryTo: typeof input?.deliveryTo === 'string' ? input.deliveryTo : '',
      requiredAssetTypes: Array.from(new Set(Array.isArray(input?.requiredAssetTypes) ? input.requiredAssetTypes.filter((type): type is Asset['type'] => ['master', 'trailer', 'poster', 'audio', 'subtitle'].includes(type as Asset['type'])) : ['master', 'trailer', 'subtitle'])),
    };
  }

  function persist(manifest: Omit<DeliveryManifest, 'digest'>): DeliveryManifest {
    packages.set(manifest.id, { ...manifest, digest: digestManifest(manifest) });
    return packages.get(manifest.id)!;
  }

  function attachWaivers(findings: DeliveryFinding[], exceptions: DeliveryException[]) {
    return findings.map(item => {
      const waiver = exceptions.find(exception => exception.code === item.code && exception.target === item.target);
      return waiver ? { ...item, waiverId: waiver.id } : item;
    });
  }

  function unresolvedBlockers(manifest: DeliveryManifest) {
    return manifest.findings.filter(item => item.severity === 'blocking' && !item.waiverId);
  }

  function previewDelivery(projectId: string, scopeInput?: Partial<DeliveryScope>) {
    const project = projectOrThrow(projectId);
    const scope = normalizeScope(scopeInput);
    const at = clock();
    const snapshot = makeSnapshot(project, scope, getSource(), at);
    const findings = evaluateSnapshot(snapshot, project, getSource(), at);
    return { snapshotAt: at.toISOString(), scope, snapshot, findings, blocking: findings.filter(item => item.severity === 'blocking'), requiresExceptions: findings.some(item => item.severity === 'warning') };
  }

  function generateDelivery(input: GenerateDeliveryRequest): DeliveryPackageResult {
    const project = projectOrThrow(input.projectId);
    if (!input.idempotencyKey) throw Object.assign(new Error('缺少 idempotencyKey，重复点击无法安全去重。'), { status: 400 });
    for (const existing of packages.values()) {
      if (existing.idempotencyKey === input.idempotencyKey) {
        if (existing.projectId !== input.projectId || stableStringify(existing.scope) !== stableStringify(normalizeScope(input.scope))) throw Object.assign(new Error('相同幂等键对应不同项目或交付范围，拒绝复用。'), { status: 409 });
        return { manifest: existing, reused: true, ...currentView(existing) };
      }
    }

    const scope = normalizeScope(input.scope);
    const at = clock();
    const snapshot = makeSnapshot(project, scope, getSource(), at);
    const base: Omit<DeliveryManifest, 'digest'> = {
      schemaVersion: 1,
      id: `PKG-${randomUUID()}`,
      projectId: project.id,
      idempotencyKey: input.idempotencyKey,
      status: 'interrupted',
      scope,
      snapshot,
      findings: [],
      exceptions: [],
      storageDescriptor: { kind: 'manifest-only', note: '未接对象存储；本记录仅证明预检清单与校验摘要，不声称素材已上传或交付完成。' },
      lifecycle: [{ at: at.toISOString(), stage: 'create', result: 'STARTED', detail: '已冻结交付快照，等待预检。' }],
    };
    let manifest = persist(base);
    audit('DELIVERY_PACKAGE_CREATE', manifest.id, `创建交付包预检任务：${scope.name}`);

    if (input.failBeforePrecheck) {
      manifest = persist({ ...manifest, status: 'interrupted', lifecycle: [...manifest.lifecycle, { at: clock().toISOString(), stage: 'precheck', result: 'INTERRUPTED', detail: '预检执行前模拟进程中断；未产生放行结论。' }] });
      audit('DELIVERY_PACKAGE_INTERRUPT', manifest.id, '预检前中断，可使用同一幂等键重试');
      return { manifest, reused: false };
    }

    const findings = evaluateSnapshot(snapshot, project, getSource(), clock());
    manifest = persist({ ...manifest, findings });
    const blocking = findings.filter(item => item.severity === 'blocking');
    if (blocking.length) {
      manifest = persist({ ...manifest, status: 'blocked', lifecycle: [...manifest.lifecycle, { at: clock().toISOString(), stage: 'precheck', result: 'BLOCKED', detail: `${blocking.length} 个阻断项；fail-closed，未生成可交付包。` }] });
      audit('DELIVERY_PACKAGE_BLOCKED', manifest.id, blocking.map(item => item.code).join(','));
      return { manifest, reused: false };
    }

    const warnings = findings.filter(item => item.severity === 'warning');
    if (warnings.length) {
      manifest = persist({ ...manifest, status: 'exception_required', lifecycle: [...manifest.lifecycle, { at: clock().toISOString(), stage: 'precheck', result: 'EXCEPTION_REQUIRED', detail: `${warnings.length} 个警告必须补充有记录的例外后才能继续。` }] });
      audit('DELIVERY_PACKAGE_EXCEPTION_REQUIRED', manifest.id, warnings.map(item => item.code).join(','));
      return { manifest, reused: false };
    }

    if (input.failAfterPrecheck) {
      manifest = persist({ ...manifest, status: 'interrupted', lifecycle: [...manifest.lifecycle, { at: clock().toISOString(), stage: 'precheck', result: 'PASSED', detail: '预检通过。' }, { at: clock().toISOString(), stage: 'finalize', result: 'INTERRUPTED', detail: '最终写 manifest 前模拟中断；重试仍使用原快照。' }] });
      audit('DELIVERY_PACKAGE_INTERRUPT', manifest.id, '预检后、定稿前中断');
      return { manifest, reused: false };
    }

    return finalize(manifest.id);
  }

  function finalize(id: string): DeliveryPackageResult {
    const stored = packages.get(id);
    if (!stored) throw Object.assign(new Error('交付包记录不存在。'), { status: 404 });
    const project = projectOrThrow(stored.projectId);
    const at = clock();
    const drift = detectDrift(stored.snapshot, getSource(), at);
    const crossed = recheckWindowAtFinalize(stored.snapshot, getSource(), at);
    const newFindings = [...drift, ...crossed];
    if (newFindings.length) {
      const manifest = persist({ ...stored, status: 'blocked', findings: attachWaivers([...stored.findings, ...newFindings], stored.exceptions), finalizedAt: at.toISOString(), lifecycle: [...stored.lifecycle, { at: at.toISOString(), stage: 'finalize', result: 'BLOCKED', detail: `定稿前复核发现 ${newFindings.length} 个快照/授权边界变化，旧快照不得继续交付。` }] });
      audit('DELIVERY_PACKAGE_BLOCKED', id, newFindings.map(item => item.code).join(','));
      return { manifest, reused: false, drift: newFindings };
    }

    const currentFindings = evaluateSnapshot(stored.snapshot, project, getSource(), at);
    const currentBlocking = currentFindings.filter(item => item.severity === 'blocking');
    if (currentBlocking.length) {
      const manifest = persist({ ...stored, status: 'blocked', findings: attachWaivers([...stored.findings, ...currentBlocking], stored.exceptions), finalizedAt: at.toISOString(), lifecycle: [...stored.lifecycle, { at: at.toISOString(), stage: 'finalize', result: 'BLOCKED', detail: '定稿前重新预检出现阻断项。' }] });
      audit('DELIVERY_PACKAGE_BLOCKED', id, currentBlocking.map(item => item.code).join(','));
      return { manifest, reused: false, currentBlockers: currentBlocking };
    }

    const manifest = persist({ ...stored, status: 'generated', findings: attachWaivers(stored.findings, stored.exceptions), finalizedAt: at.toISOString(), lifecycle: [...stored.lifecycle, { at: at.toISOString(), stage: 'finalize', result: 'GENERATED', detail: 'manifest 已生成并加盖快照摘要；未代表对象存储上传完成。' }] });
    audit('DELIVERY_PACKAGE_GENERATED', id, manifest.digest);
    return { manifest, reused: false };
  }

  function addExceptions(id: string, requests: Array<Pick<DeliveryException, 'code' | 'target' | 'reason' | 'actor'>>) {
    const stored = packages.get(id);
    if (!stored) throw Object.assign(new Error('交付包记录不存在。'), { status: 404 });
    if (!Array.isArray(requests) || requests.length === 0) throw Object.assign(new Error('例外必须包含原因和责任人记录。'), { status: 400 });

    const additions: DeliveryException[] = [];
    for (const request of requests) {
      const match = stored.findings.find(item => item.code === request.code && item.target === request.target);
      if (!match) throw Object.assign(new Error(`找不到可例外的预检项 ${request.code}/${request.target}。`), { status: 400 });
      if (!match.exceptionAllowed) throw Object.assign(new Error(`${match.code} 是 fail-closed 阻断项，不能通过例外绕过。`), { status: 409 });
      if (!request.reason?.trim() || !request.actor?.trim()) throw Object.assign(new Error('例外必须填写业务原因和授权人。'), { status: 400 });
    }
    if (stored.status === 'blocked' || stored.status === 'generated') throw Object.assign(new Error(`状态 ${stored.status} 不允许补例外；阻断项必须修复后换快照重新生成。`), { status: 409 });
    for (const request of requests) {
      if (stored.exceptions.some(item => item.code === request.code && item.target === request.target)) continue;
      additions.push({ id: `WVR-${randomUUID()}`, code: request.code, target: request.target, reason: request.reason.trim(), actor: request.actor.trim(), at: clock().toISOString() });
    }
    if (!additions.length) return { manifest: stored, reused: true, ...currentView(stored) };

    const exceptions = [...stored.exceptions, ...additions];
    const exceptionManifest = persist({ ...stored, exceptions, findings: attachWaivers(stored.findings, exceptions), lifecycle: [...stored.lifecycle, { at: clock().toISOString(), stage: 'exception', result: 'RECORDED', detail: `记录 ${additions.length} 条书面例外；例外仅对该快照有效。` }] });
    audit('DELIVERY_EXCEPTION_RECORDED', id, additions.map(item => item.id).join(','), additions[0]?.actor);
    const stillMissing = exceptionManifest.findings.some(item => item.severity === 'warning' && !item.waiverId);
    if (stillMissing) return { manifest: exceptionManifest, reused: false, ...currentView(exceptionManifest) };
    return finalize(exceptionManifest.id);
  }

  function retryInterrupted(id: string) {
    const stored = packages.get(id);
    if (!stored) throw Object.assign(new Error('交付包记录不存在。'), { status: 404 });
    if (stored.status === 'generated' || stored.status === 'blocked') throw Object.assign(new Error(`状态 ${stored.status} 不是可重试的中断态；请修复后用新幂等键重新生成。`), { status: 409 });
    if (stored.status === 'exception_required') throw Object.assign(new Error('仍有未记录的警告例外；例外补齐后才能继续。'), { status: 409 });

    const at = clock();
    const project = projectOrThrow(stored.projectId);
    let findings = stored.findings.length ? stored.findings : evaluateSnapshot(stored.snapshot, project, getSource(), at);
    const blocking = findings.filter(item => item.severity === 'blocking');
    if (blocking.length) {
      const manifest = persist({ ...stored, status: 'blocked', findings, lifecycle: [...stored.lifecycle, { at: at.toISOString(), stage: 'retry-precheck', result: 'BLOCKED', detail: '中断恢复后发现阻断项。' }] });
      audit('DELIVERY_PACKAGE_BLOCKED', id, blocking.map(item => item.code).join(','));
      return { manifest, reused: false };
    }
    const warnings = findings.filter(item => item.severity === 'warning');
    if (warnings.some(item => !stored.exceptions.some(exception => exception.code === item.code && exception.target === item.target))) {
      const manifest = persist({ ...stored, status: 'exception_required', findings, lifecycle: [...stored.lifecycle, { at: at.toISOString(), stage: 'retry-precheck', result: 'EXCEPTION_REQUIRED', detail: '中断恢复后仍需补齐警告例外。' }] });
      return { manifest, reused: false };
    }
    findings = attachWaivers(findings, stored.exceptions);
    const manifest = persist({ ...stored, findings, lifecycle: [...stored.lifecycle, { at: at.toISOString(), stage: 'retry', result: 'RESUMED', detail: '沿用同一快照和幂等键继续定稿。' }] });
    audit('DELIVERY_PACKAGE_RESUMED', id, '中断后重试');
    return finalize(manifest.id);
  }

  function currentView(manifest: DeliveryManifest) {
    const drift = detectDrift(manifest.snapshot, getSource(), clock());
    const currentFindings = evaluateSnapshot(manifest.snapshot, projectOrThrow(manifest.projectId), getSource(), clock());
    return { drift: drift.length ? drift : undefined, currentBlockers: currentFindings.filter(item => item.severity === 'blocking') };
  }

  function getPackage(id: string) {
    const manifest = packages.get(id);
    if (!manifest) throw Object.assign(new Error('交付包记录不存在。'), { status: 404 });
    return { manifest, ...currentView(manifest) };
  }

  function listPackages(projectId?: string) {
    return [...packages.values()].filter(item => !projectId || item.projectId === projectId).sort((a, b) => Date.parse(b.snapshot.at) - Date.parse(a.snapshot.at)).map(manifest => ({ manifest, ...currentView(manifest) }));
  }

  return { previewDelivery, generateDelivery, addExceptions, retryInterrupted, getPackage, listPackages, normalizeScope };
}

export const deliveryService = createDeliveryService();
