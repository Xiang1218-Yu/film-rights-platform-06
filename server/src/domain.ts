export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type MilestoneStatus = 'open' | 'invoiced' | 'paid';
export type RightsProofStatus = 'received' | 'missing' | 'expired';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface ContractMilestone { name: string; due: string; amount: number; status: MilestoneStatus; critical?: boolean; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: ContractMilestone[]; }
export interface Asset { id: string; projectId: string; name: string; type: AssetType; version: number; status: 'draft' | 'review' | 'approved' | 'locked'; owner: string; checksum: string; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[]; }
export interface RightsProof { id: string; projectId: string; assetId: string; contractId: string; title: string; status: RightsProofStatus; documentRef: string; issuedAt: string; expiresAt?: string; coversTags: string[]; territories: string[]; platforms: string[]; }
export interface Approval { id: string; projectId: string; entityType: 'budget' | 'asset' | 'delivery'; entityId: string; title: string; requestedBy: string; status: ApprovalStatus; approver: string; createdAt: string; comment?: string; }
export interface AuditEvent { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string; }

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);
const checksum = (value: string) => `sha256:${value.repeat(16).slice(0, 64)}`;

export const projects: Project[] = [
  { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
  { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) }
];
export const budgetLines: BudgetLine[] = [
  { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
  { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
  { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
  { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
  { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' }
];
export const contracts: Contract[] = [
  { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, committed: 4300000, paid: 2300000, milestones: [{ name: '锁剪交付', due: iso(8), amount: 1200000, status: 'invoiced', critical: true }, { name: '母版验收', due: iso(36), amount: 2000000, status: 'open', critical: true }] },
  { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, committed: 880000, paid: 440000, milestones: [{ name: '签署', due: iso(-16), amount: 440000, status: 'paid' }, { name: '交付版权证明', due: iso(4), amount: 440000, status: 'invoiced', critical: true }] },
  { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, committed: 1100000, paid: 600000, milestones: [{ name: '素材包一', due: iso(20), amount: 500000, status: 'open' }] },
  { id: 'CTR-04', projectId: 'PRJ-001', vendor: '潮汐物料授权', scope: '宣发预告、字幕与宣传肖像授权', ceiling: 680000, committed: 420000, paid: 420000, milestones: [{ name: '授权权利与证明交付', due: iso(-12), amount: 420000, status: 'paid', critical: true }] }
];
export const assets: Asset[] = [
  { id: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', version: 7, status: 'review', owner: '后期制片', checksum: checksum('91b7'), territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-2), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'] },
  { id: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', version: 4, status: 'approved', owner: '营销部', checksum: checksum('42ca'), territories: ['CN'], platforms: ['StreamBox', '短视频'], availableFrom: iso(6), availableTo: iso(180), rightsTags: ['演员-宣传许可'] },
  { id: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', version: 2, status: 'locked', owner: '音乐版权', checksum: checksum('113c'), territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-40), availableTo: iso(52), rightsTags: ['音乐-同步许可'] },
  { id: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', version: 3, status: 'review', owner: '视觉总监', checksum: checksum('8a10'), territories: ['全球'], platforms: ['影院'], availableFrom: iso(18), availableTo: iso(365), rightsTags: ['航拍-编辑许可'] },
  { id: 'AST-005', projectId: 'PRJ-001', name: '简体中文字幕 / Festival Cut', type: 'subtitle', version: 3, status: 'approved', owner: '本地化', checksum: checksum('5f0d'), territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox', '短视频'], availableFrom: iso(-5), availableTo: iso(220), rightsTags: ['字幕-翻译授权'] },
  { id: 'AST-006', projectId: 'PRJ-001', name: '短预告 30s / Cut B', type: 'trailer', version: 2, status: 'approved', owner: '营销部', checksum: checksum('6bd2'), territories: ['CN'], platforms: ['StreamBox'], availableFrom: iso(-3), availableTo: iso(180), rightsTags: ['演员-宣传许可'] }
];
export const rightsProofs: RightsProof[] = [
  { id: 'RGT-001', projectId: 'PRJ-001', assetId: 'AST-001', contractId: 'CTR-01', title: '母版交付与供应商权利保证', status: 'received', documentRef: 'CTR-01/RIGHTS-7', issuedAt: iso(-20), coversTags: ['演员-全媒介'], territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'] },
  { id: 'RGT-002', projectId: 'PRJ-001', assetId: 'AST-002', contractId: 'CTR-04', title: '主预告宣传肖像授权', status: 'received', documentRef: 'CTR-04/RIGHTS-2', issuedAt: iso(-18), coversTags: ['演员-宣传许可'], territories: ['CN'], platforms: ['StreamBox', '短视频'] },
  { id: 'RGT-003', projectId: 'PRJ-001', assetId: 'AST-003', contractId: 'CTR-02', title: 'Winter Signal 同步授权证明', status: 'missing', documentRef: '', issuedAt: iso(-30), coversTags: ['音乐-同步许可'], territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'] },
  { id: 'RGT-004', projectId: 'PRJ-001', assetId: 'AST-005', contractId: 'CTR-04', title: '字幕翻译与放映授权', status: 'received', documentRef: 'CTR-04/RIGHTS-5', issuedAt: iso(-11), coversTags: ['字幕-翻译授权'], territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox', '短视频'] },
  { id: 'RGT-005', projectId: 'PRJ-001', assetId: 'AST-006', contractId: 'CTR-04', title: '短预告宣传肖像授权', status: 'received', documentRef: 'CTR-04/RIGHTS-3', issuedAt: iso(-10), coversTags: ['演员-宣传许可'], territories: ['CN'], platforms: ['StreamBox'] }
];
export const approvals: Approval[] = [
  { id: 'APR-01', projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', status: 'pending', approver: '财务负责人', createdAt: iso(-1) },
  { id: 'APR-02', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', title: 'E01 最终母版锁定', requestedBy: '后期制片', status: 'pending', approver: '总制片人', createdAt: iso(-2) },
  { id: 'APR-03', projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: iso(-5), comment: '已补充航拍授权凭证' },
  { id: 'APR-04', projectId: 'PRJ-001', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: iso(-6), comment: '节展范围与交付窗口已复核' },
  { id: 'APR-05', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-002', title: '主预告 90 秒锁定', requestedBy: '营销部', status: 'approved', approver: '法务负责人', createdAt: iso(-4), comment: '可用于节展宣传' },
  { id: 'APR-06', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-005', title: '节展字幕版本锁定', requestedBy: '本地化', status: 'approved', approver: '发行负责人', createdAt: iso(-3) },
  { id: 'APR-07', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-006', title: '短预告 30 秒锁定', requestedBy: '营销部', status: 'approved', approver: '发行负责人', createdAt: iso(-2) }
];
export const auditEvents: AuditEvent[] = [{ id: 'AUD-01', action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', at: new Date(now - 86400000).toISOString(), details: '从 V2 复制并调整后期科目' }];

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const projectAssets = assets.filter(asset => asset.projectId === projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return { project: projects.find(project => project.id === projectId), planned, forecast, actual, variance: forecast - planned, utilization: planned ? actual / planned : 0, committed: lines.reduce((sum, line) => sum + line.committed, 0), contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0), assetCount: projectAssets.length, pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length, highRiskLines: lines.filter(line => line.risk === 'high'), lines, contracts: projectContracts, assets: projectAssets, approvals: projectApprovals };
}

export function rightsConflicts(projectId = projects[0].id) {
  const list = assets.filter(asset => asset.projectId === projectId);
  const conflicts: { severity: 'critical' | 'warning'; assetA: string; assetB: string; reason: string }[] = [];
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const a = list[i], b = list[j];
    const sameTag = a.rightsTags.some(tag => b.rightsTags.includes(tag));
    const sameTerritory = a.territories.includes('全球') || b.territories.includes('全球') || a.territories.some(territory => b.territories.includes(territory));
    const samePlatform = a.platforms.some(platform => b.platforms.includes(platform));
    if (sameTag && sameTerritory && samePlatform && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom) conflicts.push({ severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning', assetA: a.name, assetB: b.name, reason: `同一授权标签在重叠窗口内覆盖相同地域/平台：${a.rightsTags.filter(tag => b.rightsTags.includes(tag)).join('、')}` });
  }
  return conflicts;
}

export function approve(id: string, status: ApprovalStatus, comment = '') {
  const item = approvals.find(approval => approval.id === id); if (!item) return undefined;
  item.status = status; item.comment = comment; auditEvents.unshift({ id: `AUD-${Date.now()}`, action: status.toUpperCase(), entity: item.entityType, entityId: item.entityId, actor: '当前审批人', at: new Date().toISOString(), details: comment || `${item.title} 已${status === 'approved' ? '通过' : '驳回'}` }); return item;
}
export function createApproval(input: Pick<Approval, 'projectId' | 'entityType' | 'entityId' | 'title' | 'requestedBy' | 'approver'>) { const item: Approval = { ...input, id: `APR-${Date.now()}`, status: 'pending', createdAt: new Date().toISOString() }; approvals.unshift(item); return item; }
export function dashboard() { return projects.map(project => projectSummary(project.id)).map(summary => ({ id: summary.project?.id, title: summary.project?.title, status: summary.project?.status, forecast: summary.forecast, variance: summary.variance, pendingApprovals: summary.pendingApprovals, rightsConflicts: rightsConflicts(summary.project?.id).length })); }
