import { AlertTriangle, Check, CircleHelp, Loader2, ShieldAlert } from "lucide-react";
import type { SkillSafety } from "../shared/types";

export function SafetyBadge({ safety, loading = false, onReview, controls }: { safety?: SkillSafety; loading?: boolean; onReview?: () => void; controls?: string }) {
  if (loading) return <span className="safety-badge pending" role="status"><Loader2 className="spin" size={11} /> Checking</span>;
  const status = safety?.status || "unscanned";
  const labels = { pass: "Reports pass", warn: "Review findings", fail: "Failed audit", unscanned: "Unscanned", unavailable: "Scan unavailable" };
  const Icon = status === "pass" ? Check : status === "warn" || status === "fail" ? AlertTriangle : CircleHelp;
  const content = <><Icon size={11} />{labels[status]}</>;
  return onReview
    ? <button type="button" className={`safety-badge ${status}`} onClick={onReview} aria-controls={controls} aria-label={`Review security reports: ${labels[status]}`}>{content}</button>
    : <span className={`safety-badge ${status}`}>{content}</span>;
}

export function SafetyReport({ safety, loading }: { safety?: SkillSafety; loading: boolean }) {
  if (loading) return <div className="safety-loading" role="status"><Loader2 className="spin" size={16} /> Checking current upstream reports…</div>;
  if (!safety || safety.status === "unscanned") return <div className="safety-empty"><CircleHelp size={20} /><div><strong>No audit report found</strong><p>skills.sh has no published audit reports for this skill. Review its instructions and bundled files before installing.</p></div></div>;
  if (safety.status === "unavailable") return <div className="safety-empty"><ShieldAlert size={20} /><div><strong>Audit service unavailable</strong><p>{safety.error || "Reports could not be retrieved. Try again before installing."}</p></div></div>;
  return <div className="safety-report">
    <div className="safety-scope"><SafetyBadge safety={safety} /><p>These reports describe the upstream skill. They do not attest to the revision selected in Equip.</p></div>
    {[...safety.audits].sort((a, b) => ({ fail: 0, warn: 1, unknown: 2, pass: 3 })[a.status] - ({ fail: 0, warn: 1, unknown: 2, pass: 3 })[b.status]).map((audit) => <article className={`audit-card ${audit.status}`} key={`${audit.provider}:${audit.slug}`}>
      <div className="audit-heading"><strong>{audit.provider}</strong><div><span>{({ pass: "Pass", warn: "Review", fail: "Fail", unknown: "Unknown" } as const)[audit.status]}</span>{audit.riskLevel && <small>{audit.riskLevel}</small>}</div></div>
      <p>{audit.summary}</p>
      {audit.categories?.length ? <div className="audit-categories">{audit.categories.map((category) => <span key={category}>{category}</span>)}</div> : null}
      <div className="audit-meta">{audit.auditedAt ? <time dateTime={audit.auditedAt}>Audited {new Date(audit.auditedAt).toLocaleDateString()}</time> : <span>Date unavailable</span>}<a href={audit.url} target="_blank" rel="noreferrer">Read {audit.provider} findings</a></div>
    </article>)}
  </div>;
}
