import { useCallback, useEffect, useMemo, useState } from 'react';

type Project = { id: string; title: string; status: string; deliveryDate: string };
type Asset = {
  id: string; name: string; type: string; version: number; status: string; owner: string; checksum: string;
  territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[];
};
type Summary = {
  planned: number; forecast: number; actual: number; variance: number; utilization: number; committed: number;
  contractExposure: number; assetCount: number; pendingApprovals: number;
  highRiskLines: { subcategory: string; forecast: number; planned: number }[];
  lines: { id: string; category: string; subcategory: string; planned: number; committed: number; forecast: number; actual: number; risk: string }[];
  contracts: { id: string; vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: string }[] }[];
  assets: Asset[]; approvals: { id: string; title: string; status: string; approver: string }[]; project: Project;
};
type Conflict = { severity: 'critical' | 'warning'; assetA: string; assetB: string; reason: string };
type Scope = { name: string; assetIds: string[]; territories: string[]; platforms: string[]; deliveryFrom: string; deliveryTo: string; requiredAssetTypes: string[] };
type Finding = { code: string; severity: 'blocking' | 'warning'; category: string; target: string; message: string; exceptionAllowed: boolean; waiverId?: string; detectedAt: string };
type Manifest = {
  id: string; projectId: string; idempotencyKey: string; status: 'blocked' | 'exception_required' | 'interrupted' | 'ready' | 'generated';
  scope: Scope; finalizedAt?: string; findings: Finding[]; exceptions: { id: string; code: string; target: string; reason: string; actor: string; at: string }[];
  storageDescriptor: { kind: string; note: string }; lifecycle: { at: string; stage: string; result: string; detail?: string }[];
  snapshot: { at: string; budgetVersionId: string; assets: Asset[]; checksumSummary: { assetCount: number; assetsDigest: string; truncatedChecksumCount: number } };
  digest: string;
};
type PackageView = { manifest: Manifest; reused?: boolean; drift?: Finding[]; currentBlockers?: Finding[] };
type Preview = { snapshotAt: string; scope: Scope; findings: Finding[]; blocking: Finding[]; requiresExceptions: boolean };

const money = (n: number) => `¥${(n / 10_000).toFixed(0)}万`;
const api = '/api';
const today = () => new Date().toISOString().slice(0, 10);
const allAssetTypes = ['master', 'trailer', 'audio', 'subtitle', 'poster'];
const statusLabel: Record<Manifest['status'], string> = {
  blocked: 'BLOCKED · 已阻断',
  exception_required: 'EXCEPTION REQUIRED · 需记录例外',
  interrupted: 'INTERRUPTED · 可重试',
  ready: 'READY',
  generated: 'GENERATED · MANIFEST 已生成',
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

const scopeFor = (projectId: string, assets: Asset[], deliveryDate: string): Scope => ({
  name: `${projectId} 海外节展交付包`,
  assetIds: assets.filter(asset => ['master', 'trailer', 'subtitle'].includes(asset.type)).map(asset => asset.id),
  territories: ['CN'],
  platforms: ['StreamBox'],
  deliveryFrom: today(),
  deliveryTo: deliveryDate,
  requiredAssetTypes: ['master', 'trailer', 'subtitle'],
});

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [tab, setTab] = useState<'overview' | 'budget' | 'rights' | 'delivery'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<Scope | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [packageView, setPackageView] = useState<PackageView | null>(null);
  const [history, setHistory] = useState<PackageView[]>([]);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [failBefore, setFailBefore] = useState(false);
  const [failAfter, setFailAfter] = useState(false);
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionActor, setExceptionActor] = useState('法务负责人');

  const load = useCallback(async (id = 'PRJ-001') => {
    setLoading(true); setError('');
    try {
      const items = await request<Project[]>('/projects');
      const active = items.find(item => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, c, packageList] = await Promise.all([
        request<Summary>(`/projects/${active.id}/summary`),
        request<Conflict[]>(`/projects/${active.id}/rights-conflicts`),
        request<{ packages: PackageView[] }>(`/projects/${active.id}/delivery/packages`),
      ]);
      setProjects(items); setSelected(active.id); setSummary(s); setConflicts(c);
      setScope(scopeFor(active.id, s.assets, active.deliveryDate));
      setHistory(packageList.packages); setPackageView(packageList.packages[0] ?? null); setPreview(null);
      setIdemKey(crypto.randomUUID());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const approve = async (id: string) => {
    try {
      await request(`/approvals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved', comment: '在控制台完成复核' }) });
      setMessage('审批已通过，审计事件已写入'); await load(selected);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '审批操作失败'); }
  };

  const variancePct = useMemo(() => summary ? Math.round(summary.variance / summary.planned * 100) : 0, [summary]);
  const selectedAssets = useMemo(() => summary?.assets.filter(asset => scope?.assetIds.includes(asset.id)) ?? [], [summary, scope]);

  const patchScope = (patch: Partial<Scope>) => { setPreview(null); setScope(current => current ? { ...current, ...patch } : current); };
  const toggleIn = (key: 'assetIds' | 'requiredAssetTypes' | 'territories' | 'platforms', value: string) => {
    if (!scope) return;
    const values = scope[key];
    patchScope({ [key]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] } as Partial<Scope>);
  };
  const setCsv = (key: 'territories' | 'platforms', value: string) => patchScope({ [key]: value.split(/[,，\s]+/).filter(Boolean) } as Partial<Scope>);

  const runPreview = async () => {
    if (!scope) return;
    setBusy(true); setError('');
    try {
      const result = await request<Preview>(`/projects/${selected}/delivery/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) });
      setPreview(result); setPackageView(null);
      setMessage(result.blocking.length ? `预检发现 ${result.blocking.length} 个阻断项` : '预检未发现阻断项');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '预检失败'); } finally { setBusy(false); }
  };

  const generate = async () => {
    if (!scope) return;
    setBusy(true); setError('');
    try {
      const result = await request<PackageView>(`/projects/${selected}/delivery/packages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, idempotencyKey: idemKey, failBeforePrecheck: failBefore, failAfterPrecheck: failAfter }),
      });
      setPackageView(result); setPreview(null); setFailBefore(false); setFailAfter(false);
      setMessage(result.reused ? '重复点击已由幂等键去重，返回同一份 manifest' : `预检结果：${result.manifest.status}`);
      const refreshed = await request<{ packages: PackageView[] }>(`/projects/${selected}/delivery/packages`);
      setHistory(refreshed.packages);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '生成失败'); } finally { setBusy(false); }
  };

  const recordExceptions = async () => {
    if (!packageView || !exceptionReason.trim()) return;
    setBusy(true); setError('');
    try {
      const exceptions = packageView.manifest.findings.filter(item => item.severity === 'warning' && !item.waiverId).map(item => ({ code: item.code, target: item.target, reason: exceptionReason, actor: exceptionActor }));
      const result = await request<PackageView>(`/delivery/packages/${packageView.manifest.id}/exceptions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exceptions }) });
      setPackageView(result); setExceptionReason(''); setMessage('例外已写入 manifest，且只对该快照有效');
      const refreshed = await request<{ packages: PackageView[] }>(`/projects/${selected}/delivery/packages`); setHistory(refreshed.packages);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '记录例外失败'); } finally { setBusy(false); }
  };

  const retry = async () => {
    if (!packageView) return;
    setBusy(true); setError('');
    try {
      const result = await request<PackageView>(`/delivery/packages/${packageView.manifest.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setPackageView(result); setMessage('已沿用原快照和幂等键完成中断重试');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '重试失败'); } finally { setBusy(false); }
  };

  const openPackage = async (id: string) => {
    try { setPackageView(await request<PackageView>(`/delivery/packages/${id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取交付包失败'); }
  };

  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在通过 Vite API 代理连接本地制作服务</small></main>;
  if (!summary || !scope) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  const findings = packageView?.manifest.findings ?? preview?.findings ?? [];
  const blockers = findings.filter(item => item.severity === 'blocking');
  const warnings = findings.filter(item => item.severity === 'warning');

  return <main>
    <header>
      <div>
        <div className="eyebrow">STUDIO OPS / RIGHTS & FINANCE CONTROL</div>
        <h1>FrameLedger <span>影视制作预算与资产版权协同</span></h1>
        <p>将预算承诺、供应商付款、资产版本与跨地域版权窗口串成可审计的交付链路。</p>
      </div>
      <div className="header-actions">
        <select value={selected} onChange={e => { setSelected(e.target.value); void load(e.target.value); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <span className="live"><i /> LIVE CONTROL</span>
      </div>
    </header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}
    {error && <div className="toast error-toast" onClick={() => setError('')}>{error} ×</div>}

    <section className="kpis">
      <div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em></span></div>
      <div><small>COMMITTED</small><b>{money(summary.committed)}</b><span>已锁定供应商与合同</span></div>
      <div><small>ASSET REGISTER</small><b>{summary.assetCount}<em> 个</em></b><span>版本与交付状态纳管</span></div>
      <div><small>RISK QUEUE</small><b>{summary.pendingApprovals + conflicts.length}<em> 项</em></b><span>{conflicts.length} 条版权冲突 / {summary.pendingApprovals} 个审批</span></div>
    </section>

    <nav className="tabs">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>项目驾驶舱</button>
      <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>预算与合同</button>
      <button className={tab === 'rights' ? 'active' : ''} onClick={() => setTab('rights')}>资产版权图谱</button>
      <button className={tab === 'delivery' ? 'active' : ''} onClick={() => setTab('delivery')}>交付包预检</button>
      <span>交付日 {summary.project.deliveryDate}</span>
    </nav>

    {tab === 'overview' && <div className="grid">
      <section className="panel hero"><div className="panel-head"><div><div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div><h2>{summary.project.title}</h2></div><span className="badge amber">{summary.project.status.toUpperCase()}</span></div><div className="progress-label"><span>成本消耗 {Math.round(summary.utilization * 100)}%</span><b>{money(summary.actual)} / {money(summary.planned)}</b></div><div className="progress"><i style={{ width: `${Math.min(100, summary.utilization * 100)}%` }} /></div><div className="split"><div><small>合同暴露额</small><strong>{money(summary.contractExposure)}</strong></div><div><small>高风险预算项</small><strong className="bad">{summary.highRiskLines.length}</strong></div><div><small>版权冲突</small><strong className={conflicts.length ? 'bad' : ''}>{conflicts.length}</strong></div></div></section>
      <section className="panel"><div className="panel-head"><h3>待审批队列</h3><span>{summary.approvals.filter(a => a.status === 'pending').length} PENDING</span></div>{summary.approvals.map(a => <div className="approval" key={a.id}><span className={`status ${a.status}`} /><div><b>{a.title}</b><small>{a.approver} · {a.id}</small></div>{a.status === 'pending' ? <button onClick={() => approve(a.id)}>通过</button> : <em>已完成</em>}</div>)}</section>
      <section className="panel wide"><div className="panel-head"><h3>交付风险雷达</h3><span>基于版本、授权窗口与预算预测</span></div>{conflicts.length ? conflicts.map((c, i) => <div className="risk-row" key={i}><strong className={c.severity}>{c.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</strong><div><b>{c.assetA}</b><small>↔ {c.assetB} · {c.reason}</small></div></div>) : <div className="empty">当前项目未发现版权窗口冲突。</div>}</section>
    </div>}

    {tab === 'budget' && <div className="grid">
      <section className="panel wide"><div className="panel-head"><h3>预算版本 / 成本基线</h3><span>实际 + 承诺 + 预测</span></div><div className="table"><div className="tr th"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>{summary.lines.map(line => <div className="tr" key={line.id}><span><b>{line.category}</b><small>{line.subcategory}</small></span><span>{money(line.planned)}</span><span>{money(line.committed)}</span><span>{money(line.actual)}</span><span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span><span className={`risk ${line.risk}`}>{line.risk}</span></div>)}</div></section>
      <section className="panel"><div className="panel-head"><h3>供应商付款里程碑</h3></div>{summary.contracts.map(c => <div className="contract" key={c.id}><b>{c.vendor}</b><small>{c.scope}</small><div className="contract-bar"><i style={{ width: `${Math.round(c.paid / c.committed * 100)}%` }} /></div><span>{money(c.paid)} / {money(c.committed)}</span><em>{c.milestones.filter(m => m.status !== 'paid').length} 个待结点</em></div>)}</section>
    </div>}

    {tab === 'rights' && <div className="grid">
      <section className="panel wide"><div className="panel-head"><h3>资产版本登记</h3><span>{summary.assets.length} assets / checksum tracked</span></div><div className="table"><div className="tr th asset-table"><span>资产</span><span>版本</span><span>状态</span><span>授权窗口</span><span>地域/平台</span></div>{summary.assets.map(a => <div className="tr" key={a.id}><span><b>{a.name}</b><small>{a.id} · {a.type} · {a.checksum}</small></span><span>v{a.version}</span><span className={`pill ${a.status}`}>{a.status}</span><span>{a.availableFrom} → {a.availableTo}</span><span>{a.territories.join('、')} / {a.platforms.join('、')}</span></div>)}</div></section>
      <section className="panel"><div className="panel-head"><h3>授权冲突</h3><span>{conflicts.length} detected</span></div>{conflicts.map((c, i) => <div className="conflict" key={i}><strong>{c.severity}</strong><b>{c.assetA}</b><small>{c.reason}</small></div>)}</section>
    </div>}

    {tab === 'delivery' && <div className="delivery-layout">
      <section className="panel scope-panel">
        <div className="panel-head"><div><div className="eyebrow">DELIVERY SCOPE</div><h3>选择节展交付范围</h3></div><span className="pill locked">SNAPSHOTED</span></div>
        <div className="form-grid">
          <label>交付包名称<input value={scope.name} onChange={e => patchScope({ name: e.target.value })} /></label>
          <label>地域（逗号分隔）<input value={scope.territories.join(', ')} onChange={e => setCsv('territories', e.target.value)} /></label>
          <label>平台（逗号分隔）<input value={scope.platforms.join(', ')} onChange={e => setCsv('platforms', e.target.value)} /></label>
          <label>交付开始<input type="date" value={scope.deliveryFrom} onChange={e => patchScope({ deliveryFrom: e.target.value })} /></label>
          <label>交付截止<input type="date" value={scope.deliveryTo} onChange={e => patchScope({ deliveryTo: e.target.value })} /></label>
        </div>
        <div className="checkbox-block"><b>必需资产类型（缺失即 fail-closed）</b><div className="chips">{allAssetTypes.map(type => <button key={type} className={scope.requiredAssetTypes.includes(type) ? 'chip selected' : 'chip'} onClick={() => toggleIn('requiredAssetTypes', type)}>{type}</button>)}</div></div>
        <div className="checkbox-block"><b>纳入本次范围的资产</b>{summary.assets.map(asset => <label className="asset-check" key={asset.id}><input type="checkbox" checked={scope.assetIds.includes(asset.id)} onChange={() => toggleIn('assetIds', asset.id)} /><span><b>{asset.name}</b><small>v{asset.version} · {asset.type} · {asset.status} · {asset.checksum}</small></span></label>)}</div>
        <div className="delivery-actions">
          <button onClick={runPreview} disabled={busy}>只执行预检</button>
          <button className="primary" onClick={generate} disabled={busy}>{busy ? '处理中…' : '生成交付 manifest'}</button>
          <button onClick={() => setIdemKey(crypto.randomUUID())} disabled={busy}>新快照/新幂等键</button>
        </div>
        <div className="simulate"><label><input type="checkbox" checked={failBefore} onChange={e => { setFailBefore(e.target.checked); if (e.target.checked) setFailAfter(false); }} /> 模拟预检前中断</label><label><input type="checkbox" checked={failAfter} onChange={e => { setFailAfter(e.target.checked); if (e.target.checked) setFailBefore(false); }} /> 模拟预检后、定稿前中断</label><small>幂等键：{idemKey}</small></div>
      </section>

      <section className="panel result-panel">
        <div className="panel-head"><div><div className="eyebrow">TRACEABLE PRECHECK</div><h3>预检结果与交付清单</h3></div>{packageView && <span className={`manifest-status ${packageView.manifest.status}`}>{statusLabel[packageView.manifest.status]}</span>}</div>
        {!packageView && !preview && <div className="empty">选择范围后先执行预检。阻断项不会被包装成“生成成功”。</div>}
        {preview && <div className="snapshot-meta"><b>预检快照：{preview.snapshotAt}</b><span>{preview.blocking.length} blocking / {preview.requiresExceptions ? '存在可记录例外的 warning' : '无 warning'}</span></div>}
        {packageView && <ManifestHeader view={packageView} />}
        {!!blockers.length && <FindingList title="必须 fail-closed 的阻断原因" findings={blockers} tone="blocking" />}
        {!!warnings.length && <FindingList title="可由有记录例外继续的事项" findings={warnings} tone="warning" />}
        {packageView?.drift?.length && <FindingList title="重新打开后发现当前数据已偏离快照" findings={packageView.drift} tone="blocking" />}
        {packageView?.currentBlockers?.length && <FindingList title="当前业务数据仍存在的阻断" findings={packageView.currentBlockers} tone="blocking" />}
        {packageView?.manifest.status === 'exception_required' && <div className="exception-box"><b>记录例外后继续</b><textarea value={exceptionReason} onChange={e => setExceptionReason(e.target.value)} placeholder="说明业务原因、节展要求、替代凭证位置；例外只绑定这份快照。" /><input value={exceptionActor} onChange={e => setExceptionActor(e.target.value)} /><button className="primary" disabled={busy || !exceptionReason.trim()} onClick={recordExceptions}>写入例外并继续生成</button></div>}
        {packageView?.manifest.status === 'interrupted' && <div className="exception-box"><b>生成中断</b><p>重试会沿用同一快照时间、资产版本、checksum 和幂等键；定稿前若资产换版或授权窗口跨界，会再次 fail-closed。</p><button className="primary" disabled={busy} onClick={retry}>使用同一份快照重试</button></div>}
      </section>

      <section className="panel wide">
        <div className="panel-head"><h3>快照资产与校验摘要</h3><span>{selectedAssets.length} selected in form / manifest 以冻结快照为准</span></div>
        <div className="snapshot-assets">
          {(packageView?.manifest.snapshot.assets ?? selectedAssets).map(asset => <div key={asset.id}><b>{asset.name}</b><small>v{asset.version} · {asset.status}</small><code>{asset.checksum}</code><span>{asset.availableFrom} → {asset.availableTo}</span></div>)}
        </div>
        {packageView && <div className="manifest-json"><b>{packageView.manifest.id}</b><code>{packageView.manifest.digest}</code><small>{packageView.manifest.storageDescriptor.note}</small><ol>{packageView.manifest.lifecycle.map((event, i) => <li key={i}><time>{event.at}</time>{event.stage} · {event.result}{event.detail ? ` — ${event.detail}` : ''}</li>)}</ol></div>}
      </section>

      <section className="panel wide history-panel">
        <div className="panel-head"><h3>项目内历史交付快照</h3><span>重新打开项目时读取的是不可变 manifest；当前漂移另行提示</span></div>
        {history.length ? history.map(item => <button className="history-row" key={item.manifest.id} onClick={() => void openPackage(item.manifest.id)}><span>{new Date(item.manifest.snapshot.at).toLocaleString()}</span><b>{item.manifest.id}</b><em className={item.manifest.status}>{statusLabel[item.manifest.status]}</em><code>{item.manifest.digest.slice(0, 24)}…</code></button>) : <div className="empty">尚无交付包记录。</div>}
      </section>
    </div>}
    <footer>FrameLedger baseline · 内存仓储 + REST API · manifest 仅证明预检与清单摘要，不声称对象存储上传或素材下载完成</footer>
  </main>;
}

function ManifestHeader({ view }: { view: PackageView }) {
  const m = view.manifest;
  return <div className="snapshot-meta"><b>{m.id}{view.reused ? ' · 幂等复用' : ''}</b><span>snapshot {m.snapshot.at}</span><span>{m.snapshot.checksumSummary.assetCount} assets · {m.snapshot.checksumSummary.assetsDigest.slice(0, 22)}…</span><span>{m.exceptions.length} exceptions</span></div>;
}

function FindingList({ title, findings, tone }: { title: string; findings: Finding[]; tone: 'blocking' | 'warning' }) {
  return <div className={`finding-list ${tone}`}><h4>{title}</h4>{findings.map((item, index) => <div key={`${item.code}-${item.target}-${index}`} className="finding"><strong>{item.severity === 'blocking' ? 'BLOCK' : 'WARN'}</strong><div><b>{item.code} · {item.category}</b><small>{item.message}</small><em>{item.target}{item.waiverId ? ` · waiver ${item.waiverId}` : item.exceptionAllowed ? ' · 可记录例外' : ' · 不允许例外'}</em></div></div>)}</div>;
}
