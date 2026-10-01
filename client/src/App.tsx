import React, { useCallback, useEffect, useMemo, useState } from 'react';

type Project = { id: string; title: string; status: string; deliveryDate: string };
type Asset = { id: string; name: string; type: string; version: number; status: string; checksum: string; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[] };
type Summary = {
  planned: number; forecast: number; actual: number; variance: number; utilization: number; committed: number;
  contractExposure: number; assetCount: number; pendingApprovals: number;
  highRiskLines: { subcategory: string; forecast: number; planned: number }[];
  lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { id: string; vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string; critical?: boolean }[] }[];
  assets: Asset[]; approvals: { id: string; title: string; status: string; approver: string }[]; project: Project;
};
type Conflict = { severity: string; assetA: string; assetB: string; reason: string };
type DeliveryCheck = { code: string; severity: string; blocking: boolean; exceptionAllowed: boolean; subjectId: string; subjectName: string; message: string; evidence?: string; resolvedByException?: boolean; exceptionId?: string };
type DeliveryManifest = {
  id: string; deliveryId: string; status: 'generating' | 'blocked' | 'ready' | 'failed'; packageStatus: 'not_created'; snapshotAt: string;
  completedAt?: string; attempts: number; interruptionReason?: string; assets: { id: string; name: string; type: string; version: number; status: string; checksum: string }[];
  scope: { assetIds: string[]; territories: string[]; platforms: string[]; rightsUntil: string }; checks: DeliveryCheck[]; blockers: DeliveryCheck[];
  checksumSummary?: { algorithm: string; assetCount: number; assetChecksums: { assetId: string; version: number; checksum: string }[]; assetFingerprint: string; manifestDigest: string; objectStorageVerified: false; packageObjectKey: null };
};

const money = (n: number) => `¥${(n / 10000).toFixed(0)}万`;
const api = '/api';
const addDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [tab, setTab] = useState<'overview'|'budget'|'rights'|'delivery'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [manifests, setManifests] = useState<DeliveryManifest[]>([]);
  const [activeManifestId, setActiveManifestId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [rightsUntil, setRightsUntil] = useState(addDays(30));
  const [selectedTerritories, setSelectedTerritories] = useState<string[]>(['CN']);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(['StreamBox']);

  const allTerritories = useMemo(() => Array.from(new Set(summary?.assets.flatMap(asset => asset.territories) ?? [])).sort(), [summary]);
  const allPlatforms = useMemo(() => Array.from(new Set(summary?.assets.flatMap(asset => asset.platforms) ?? [])).sort(), [summary]);

  const load = useCallback(async (id = 'PRJ-001') => {
    setLoading(true); setError('');
    try {
      const items = await request<Project[]>('/projects');
      const active = items.find(item => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, c, existingManifests] = await Promise.all([
        request<Summary>(`/projects/${active.id}/summary`),
        request<Conflict[]>(`/projects/${active.id}/rights-conflicts`),
        request<DeliveryManifest[]>(`/projects/${active.id}/delivery-manifests`)
      ]);
      setProjects(items); setSelected(active.id); setSummary(s); setConflicts(c); setManifests(existingManifests);
      setSelectedAssets(s.assets.map(asset => asset.id));
      setActiveManifestId(existingManifests[0]?.id ?? '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const activeManifest = manifests.find(item => item.id === activeManifestId) ?? manifests[0];

  const approve = async (id: string) => {
    try {
      await request(`/approvals/${id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: 'approved', comment: '在控制台完成复核' }) });
      setMessage('审批已通过，审计事件已写入'); await load(selected);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '审批操作失败'); }
  };

  const toggleAsset = (id: string) => setSelectedAssets(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const toggleIn = (setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) => setter(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);

  const generate = async (retryId?: string) => {
    if (!summary) return;
    setGenerating(true); setError(''); setMessage('');
    try {
      const response = retryId
        ? await request<DeliveryManifest>(`/projects/${selected}/delivery-manifests/${retryId}/retry`, { method: 'POST', headers: {'Content-Type':'application/json'} })
        : await request<{ manifest: DeliveryManifest }>(`/projects/${selected}/delivery-manifests`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ idempotencyKey: (crypto.randomUUID ? crypto.randomUUID() : `key-${Date.now()}`), deliveryId: 'DEL-007', requestedBy: '发行部', assetIds: selectedAssets, territories: selectedTerritories, platforms: selectedPlatforms, rightsUntil })
        });
      const manifest = 'manifest' in response ? response.manifest : response;
      setMessage(manifest.status === 'ready' ? '预检通过，manifest 已生成；尚未创建交付对象。' : manifest.status === 'blocked' ? '预检完成但存在阻断项，未生成交付对象。' : '生成中断，可按同一快照重试。');
      await load(selected); setActiveManifestId(manifest.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '生成交付清单失败'); }
    finally { setGenerating(false); }
  };

  const registerException = async (check: DeliveryCheck) => {
    try {
      await request(`/projects/${selected}/delivery-exceptions`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ deliveryId: activeManifest?.deliveryId ?? 'DEL-007', code: check.code, subjectId: check.subjectId, subjectName: check.subjectName, reason: check.message, requestedBy: '发行部', approver: '法务负责人', expiresAt: rightsUntil, assetIds: activeManifest?.scope.assetIds ?? selectedAssets }) });
      setMessage('例外已记录，可重试同一份快照。'); await load(selected);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '记录例外失败'); }
  };

  const variancePct = useMemo(() => summary ? Math.round(summary.variance / summary.planned * 100) : 0, [summary]);
  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在通过 Vite API 代理连接本地制作服务</small></main>;
  if (!summary) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5173 和 API 4104 均已启动。</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  return <main>
    <header><div><div className="eyebrow">STUDIO OPS / RIGHTS & FINANCE CONTROL</div><h1>FrameLedger <span>影视制作预算与资产版权协同</span></h1><p>将预算承诺、供应商付款、资产版本与跨地域版权窗口串成可审计的交付链路。</p></div><div className="header-actions"><select value={selected} onChange={e=>{setSelected(e.target.value); void load(e.target.value)}}>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select><span className="live"><i/> LIVE CONTROL</span></div></header>
    {message && <div className="toast" onClick={()=>setMessage('')}>{message} ×</div>}{error && <div className="toast error-toast" onClick={()=>setError('')}>{error} ×</div>}
    <section className="kpis"><div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad':''}>{variancePct}%</em></span></div><div><small>COMMITTED</small><b>{money(summary.committed)}</b><span>已锁定供应商与合同</span></div><div><small>ASSET REGISTER</small><b>{summary.assetCount}<em> 个</em></b><span>版本与交付状态纳管</span></div><div><small>RISK QUEUE</small><b>{summary.pendingApprovals + conflicts.length}<em> 项</em></b><span>{conflicts.length} 条版权冲突 / {summary.pendingApprovals} 个审批</span></div></section>
    <nav className="tabs"><button className={tab==='overview'?'active':''} onClick={()=>setTab('overview')}>项目驾驶舱</button><button className={tab==='budget'?'active':''} onClick={()=>setTab('budget')}>预算与合同</button><button className={tab==='rights'?'active':''} onClick={()=>setTab('rights')}>资产版权图谱</button><button className={tab==='delivery'?'active':''} onClick={()=>setTab('delivery')}>交付预检</button><span>交付日 {summary.project.deliveryDate}</span></nav>
    {tab==='overview' && <div className="grid"><section className="panel hero"><div className="panel-head"><div><div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div><h2>{summary.project.title}</h2></div><span className="badge amber">{summary.project.status.toUpperCase()}</span></div><div className="progress-label"><span>成本消耗 {Math.round(summary.utilization*100)}%</span><b>{money(summary.actual)} / {money(summary.planned)}</b></div><div className="progress"><i style={{width:`${Math.min(100, summary.utilization*100)}%`}}/></div><div className="split"><div><small>合同暴露额</small><strong>{money(summary.contractExposure)}</strong></div><div><small>高风险预算项</small><strong className="bad">{summary.highRiskLines.length}</strong></div><div><small>版权冲突</small><strong className={conflicts.length ? 'bad':''}>{conflicts.length}</strong></div></div></section><section className="panel"><div className="panel-head"><h3>待审批队列</h3><span>{summary.approvals.filter(a=>a.status==='pending').length} PENDING</span></div>{summary.approvals.map(a=><div className="approval" key={a.id}><span className={`status ${a.status}`}/><div><b>{a.title}</b><small>{a.approver} · {a.id}</small></div>{a.status==='pending'?<button onClick={()=>approve(a.id)}>通过</button>:<em>已完成</em>}</div>)}</section><section className="panel wide"><div className="panel-head"><h3>交付风险雷达</h3><span>基于版本、授权窗口与预算预测</span></div>{conflicts.length ? conflicts.map((c,i)=><div className="risk-row" key={i}><strong className={c.severity}>{c.severity==='critical'?'CRITICAL':'WARNING'}</strong><div><b>{c.assetA}</b><small>↔ {c.assetB} · {c.reason}</small></div></div>):<div className="empty">当前项目未发现版权窗口冲突。</div>}</section></div>}
    {tab==='budget' && <div className="grid"><section className="panel wide"><div className="panel-head"><h3>预算版本 V3 / 成本基线</h3><span>实际 + 承诺 + 预测</span></div><div className="table"><div className="tr th"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>{summary.lines.map(line=><div className="tr" key={line.id}><span><b>{line.category}</b><small>{line.subcategory}</small></span><span>{money(line.planned)}</span><span>{money(line.planned ? line.planned : 0)}</span><span>{money(line.actual)}</span><span className={line.forecast>line.planned?'bad':''}>{money(line.forecast)}</span><span className={`risk ${line.risk}`}>{line.risk}</span></div>)}</div></section><section className="panel"><div className="panel-head"><h3>供应商付款里程碑</h3></div>{summary.contracts.map(c=><div className="contract" key={c.id}><b>{c.vendor}</b><small>{c.scope}</small><div className="contract-bar"><i style={{width:`${Math.round(c.paid/c.committed*100)}%`}}/></div><span>{money(c.paid)} / {money(c.committed)}</span><em>{c.milestones.filter(m=>m.status!=='paid').length} 个待结点</em></div>)}</section></div>}
    {tab==='rights' && <div className="grid"><section className="panel wide"><div className="panel-head"><h3>资产版本登记</h3><span>{summary.assets.length} assets / checksum tracked</span></div><div className="table"><div className="tr th"><span>资产</span><span>版本</span><span>状态</span><span>授权截止</span></div>{summary.assets.map(a=><div className="tr" key={a.id}><span><b>{a.name}</b><small>{a.id} · {a.type}</small></span><span>v{a.version}</span><span className={`pill ${a.status}`}>{a.status}</span><span>{a.availableTo}</span></div>)}</div></section><section className="panel"><div className="panel-head"><h3>授权冲突</h3><span>{conflicts.length} detected</span></div>{conflicts.map((c,i)=><div className="conflict" key={i}><strong>{c.severity}</strong><b>{c.assetA}</b><small>{c.reason}</small></div>)}</section></div>}
    {tab==='delivery' && <div className="grid delivery-grid"><section className="panel wide"><div className="panel-head"><div><div className="eyebrow">DELIVERY PREFLIGHT</div><h3>选择海外节展交付范围</h3></div><span className="badge amber">SNAPSHOT + CHECKSUM</span></div><div className="scope-meta"><label>授权需覆盖至 <input type="date" value={rightsUntil} onChange={e=>setRightsUntil(e.target.value)} /></label><div className="chip-group"><small>地域</small>{allTerritories.map(t=><button type="button" key={t} className={`chip ${selectedTerritories.includes(t)?'selected':''}`} onClick={()=>toggleIn(setSelectedTerritories)(t)}>{t}</button>)}</div><div className="chip-group"><small>平台</small>{allPlatforms.map(p=><button type="button" key={p} className={`chip ${selectedPlatforms.includes(p)?'selected':''}`} onClick={()=>toggleIn(setSelectedPlatforms)(p)}>{p}</button>)}</div><span>对象存储：未接入，仅生成可复核清单</span></div><div className="asset-picker">{summary.assets.map(asset=><label key={asset.id} className={selectedAssets.includes(asset.id)?'selected':''}><input type="checkbox" checked={selectedAssets.includes(asset.id)} onChange={()=>toggleAsset(asset.id)}/><b>{asset.name}</b><small>v{asset.version} · {asset.type} · {asset.checksum.slice(0, 18)}… · 至 {asset.availableTo}</small></label>)}</div><div className="delivery-actions"><button disabled={!selectedAssets.length || !selectedTerritories.length || !selectedPlatforms.length || generating} onClick={()=>void generate()}>{generating ? '正在生成…' : '生成预检 manifest'}</button>{activeManifest && (activeManifest.status==='failed' || activeManifest.status==='generating') && <button onClick={()=>void generate(activeManifest.id)}>按同一快照重试</button>}<em>{selectedAssets.length} 个资产 · {selectedTerritories.length} 地域 · {selectedPlatforms.length} 平台</em></div></section>
      <section className="panel"><div className="panel-head"><h3>历史快照</h3><span>{manifests.length} manifests</span></div>{manifests.length ? manifests.map(manifest=><button key={manifest.id} className={`manifest-history ${activeManifest?.id===manifest.id?'active':''}`} onClick={()=>setActiveManifestId(manifest.id)}><b>{manifest.id} · {manifest.status}</b><small>{manifest.snapshotAt}</small><small>{manifest.checksumSummary?.assetCount ?? 0} assets · attempts {manifest.attempts}</small></button>):<div className="empty">尚无交付快照。</div>}</section>
      {activeManifest && <section className="panel wide manifest-panel"><div className="panel-head"><div><div className="eyebrow">{activeManifest.id} / {activeManifest.deliveryId}</div><h3>状态：{activeManifest.status}</h3></div><span className={`badge ${activeManifest.status}`}>{activeManifest.status}</span></div><div className="snapshot-grid"><div><small>快照时间</small><b>{activeManifest.snapshotAt}</b></div><div><small>包状态</small><b className="bad">{activeManifest.packageStatus}</b></div><div><small>资产指纹</small><b>{activeManifest.checksumSummary?.assetFingerprint.slice(0, 16)}…</b></div><div><small>Manifest digest</small><b>{activeManifest.checksumSummary?.manifestDigest.slice(0, 16)}…</b></div></div><div className="blocker-note">{activeManifest.status === 'ready' ? '预检通过；这里不是下载或上传完成，交付对象尚未创建。' : activeManifest.interruptionReason ? `生成中断：${activeManifest.interruptionReason}` : `存在 ${activeManifest.blockers.length} 个阻断项，必须处理后才能交付。`}</div><div className="check-list">{activeManifest.checks.map((check,index)=><div className={`check-row ${check.severity} ${check.resolvedByException?'waived':''}`} key={`${check.code}-${check.subjectId}-${index}`}><strong>{check.severity}</strong><div><b>{check.subjectName}</b><small>{check.code} · {check.message}</small>{check.exceptionId && <small className="exception-ref">已由例外 {check.exceptionId} 放行</small>}</div>{check.blocking && check.exceptionAllowed && <button onClick={()=>void registerException(check)}>登记例外</button>}</div>)}</div></section>}
    </div>}
    <footer>FrameLedger baseline · JSON 快照持久化 + REST API · ready ≠ uploaded/downloaded</footer>
  </main>;
}
