import { useEffect, useState } from "react";
import { Check, GitBranch, History, Loader2, RefreshCw } from "lucide-react";
import type { Instructions, Skill, SkillFile, Version, Workspace } from "../shared/types";
import { pendingChanges } from "../shared/changes";
import { compareSkillFiles, diffLines, reviewedFilesRevision } from "../shared/conflicts";
import { instructionsAsSkill } from "../shared/instructions";
import { api } from "./api";
import { Dialog, Empty, revision, SkillIcon } from "./components";
import { SafetyBadge, SafetyReport } from "./Safety";
import SkillSyncReview from "./SkillSyncReview";
import SkillConflict from "./SkillConflict";

export default function Changes({workspace, refresh, notify, open, instructions}: {
  workspace: Workspace; refresh: () => Promise<void>; notify: (message:string) => void;
  open: (skill:Skill) => void; instructions: () => void;
}) {
  const [filter,setFilter] = useState("all");
  const [update,setUpdate] = useState<Skill>();
  const [conflict,setConflict] = useState<Skill>();
  const [instructionConflict,setInstructionConflict] = useState<ReturnType<typeof pendingChanges>["local"][number]>();
  const [removedConflict,setRemovedConflict] = useState<ReturnType<typeof pendingChanges>["local"][number]>();
  const [recovery,setRecovery]=useState<{title:string;versions:Version[];loading:boolean;error?:string}>();
  const [recoveryVersion,setRecoveryVersion]=useState(0);
  const [recoveryFile,setRecoveryFile]=useState(0);
  const [busy,setBusy] = useState("");
  const [error,setError] = useState("");
  const changes = pendingChanges(workspace);
  const localSkills = [...new Set(changes.local.filter(item => !item.receipt.kind).map(item => item.receipt.skillId))];
  const perform = async (key:string, work:()=>Promise<void>) => {
    setBusy(key); setError("");
    try { await work(); await refresh(); }
    catch(cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  };
  const checkAll = () => perform("check",async () => {
    const results = await Promise.allSettled(workspace.skills.filter(skill => skill.selected && skill.kind === "third-party").map(skill => api(`/skills/${skill.id}/check`,"POST")));
    const failed = results.filter(result => result.status === "rejected").length;
    if (failed) throw new Error(`${failed} sources could not be checked. Successful checks are saved; private sources may need a connected computer.`);
    notify("Upstream checks complete. Selected revisions stay unchanged until approved.");
  });
  const inspectRecovery=async(item:{id:string;title:string;versions:Version[]},instruction:boolean)=>{
    const ids=new Set(item.versions.map(version=>version.id));
    setRecovery({title:item.title,versions:[],loading:true});setRecoveryVersion(0);setRecoveryFile(0);
    try {
      const complete=instruction ? await api<Instructions>(`/instructions/${item.id}`) : await api<Skill>(`/skills/${item.id}`);
      const versions=complete.versions.filter(version=>ids.has(version.id));
      if(!versions.length) throw new Error("These recovered versions are no longer available.");
      setRecovery({title:item.title,versions,loading:false});
    } catch(cause) {setRecovery({title:item.title,versions:[],loading:false,error:(cause as Error).message});}
  };
  const hasChanges = changes.updates.length || localSkills.length || changes.local.some(item => item.receipt.kind) || changes.recovered.length;
  const filteredCount=filter==="all" ? Number(hasChanges) : filter==="updates" ? changes.updates.length : filter==="local" ? localSkills.length+changes.local.filter(item=>item.receipt.kind).length : changes.recovered.length;
  return <div className="page changes-page">
    <div className="page-heading"><div><h1>Changes<span className="heading-dot">.</span></h1><p>Review a new revision, reconcile local work, or recover a saved version.</p></div>
      <button className="button" disabled={Boolean(busy) || workspace.demo} onClick={checkAll}>{busy === "check" ? <Loader2 className="spin" size={16}/> : <RefreshCw size={16}/>} Check upstream</button></div>
    <div className="changes-explainer"><GitBranch size={20}/><p>Equip owns the selected revision. Approvals change the desired state; computers confirm installation separately.</p></div>
    <div className="segmented changes-filters" aria-label="Change filters">{[
      ["all","All changes"],["updates",`Upstream · ${changes.updates.length}`],["local",`Local differences · ${localSkills.length + changes.local.filter(item=>item.receipt.kind).length}`],["recovered",`Recovery history · ${changes.recovered.length}`],
    ].map(([id,label])=><button key={id} aria-pressed={filter===id} className={filter===id ? "active" : ""} onClick={()=>setFilter(id)}>{label}</button>)}</div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!hasChanges && <Empty title="Nothing needs a decision" description="Your selected revisions and recovery history are clear. Computers show pending or offline installations in Computers."/>}
    {!!hasChanges && !filteredCount && <Empty title={`No ${filter} changes`} description="Choose another filter to review the changes that still need attention."/>}
    {(filter==="all" || filter==="updates") && !!changes.updates.length && <section className="changes-section"><h2>Upstream updates</h2><p>Inspect the exact proposed files before replacing your deployed version.</p>{changes.updates.map(skill=><div className="change-row" key={skill.id}><SkillIcon skill={skill}/><div><strong>{skill.title}</strong><p>{skill.source}</p><small><code>{revision(skill.revision)}</code> selected <span aria-hidden="true">→</span> <code>{revision(skill.upstreamRevision!)}</code> available</small></div><button className="button" onClick={()=>setUpdate(skill)}>Review update</button></div>)}</section>}
    {(filter==="all" || filter==="local") && !!changes.local.length && <section className="changes-section"><h2>Local differences</h2><p>Review content changes. Ordinary file permissions on different operating systems do not create conflicts.</p>{localSkills.map(id=>{
      const skill=workspace.skills.find(item=>item.id===id) ?? workspace.retiredSkills?.find(item=>item.id===id);
      if(!skill) return <div className="change-row" key={id}><GitBranch size={20}/><div><strong>Removed skill</strong><p>A local copy still contains edits. Review this computer’s installation result.</p></div><button className="button" onClick={()=>setRemovedConflict(changes.local.find(item=>!item.receipt.kind&&item.receipt.skillId===id))}>Review differences</button></div>;
      const devices = new Set(changes.local.filter(item=>item.receipt.skillId===id).map(item=>item.device.id));
      const active=workspace.skills.some(item=>item.id===id);
      return <div className="change-row" key={id}><SkillIcon skill={skill}/><div><strong>{skill.title}</strong><p>{devices.size} {devices.size===1 ? "computer has" : "computers have"} local edits</p><small>{active ? "Use Equip, publish local everywhere, merge, or save a custom draft." : "This skill was removed from the library. Review the remaining local installation directly."}</small></div><button className="button" onClick={()=>active ? setConflict(skill) : setRemovedConflict(changes.local.find(item=>!item.receipt.kind&&item.receipt.skillId===id))}>Review differences</button></div>;
    })}{changes.local.filter(item=>item.receipt.kind==="instructions").map(item=><div className="change-row" key={`${item.device.id}:${item.receipt.agent}:${item.receipt.profile}:${item.receipt.project}`}><GitBranch size={20}/><div><strong>Global instructions</strong><p>{item.device.name} · {item.receipt.agent} {item.receipt.profile}</p></div><button className="button" onClick={()=>setInstructionConflict(item)}>Review differences</button></div>)}</section>}
    {(filter==="all" || filter==="recovered") && !!changes.recovered.length && <section className="changes-section"><h2>Recovery history</h2><p>These versions are stored in Equip. They do not require backup folders on your computers.</p>{changes.recovered.map(({item,versions})=><div className="change-row" key={item.id}><History size={20}/><div><strong>{item.title || "Global instructions"}</strong><p>{versions.length} saved {versions.length===1 ? "version" : "versions"} · {versions[0].message.split(" at ")[0]}</p></div><div className="change-actions"><button className="button" onClick={()=>void inspectRecovery({id:item.id,title:item.title || "Global instructions",versions},!("name" in item))}>Inspect saved files</button><button className="text-link" disabled={Boolean(busy)} onClick={()=>void perform(item.id,async()=>{for(const version of versions) await api("/changes/reviewed","POST",{key:`recovery:${item.id}:${version.id}`});})}>Mark reviewed</button></div></div>)}</section>}
    {conflict && <SkillSyncReview skill={workspace.skills.find(item=>item.id===conflict.id) || conflict} workspace={workspace} onClose={()=>setConflict(undefined)} onChange={refresh} notify={notify}/>} 
    {removedConflict && <SkillConflict device={removedConflict.device} receipt={removedConflict.receipt} onClose={()=>setRemovedConflict(undefined)} onResolve={async(action,expectedRevision,mergedFiles?:SkillFile[])=>{const {device,receipt}=removedConflict;await api(`/devices/${device.id}/resolve`,"POST",{skillId:receipt.skillId,agent:receipt.agent,profile:receipt.profile,project:receipt.project,action,expectedRevision,expectedLocalRevision:receipt.localFiles ? await reviewedFilesRevision(receipt.localFiles) : undefined,mergedFiles});await refresh();}}/>}
    {instructionConflict && <SkillConflict documentKind="instructions" skill={(()=>{const item=workspace.instructions?.find(item=>item.id===instructionConflict.receipt.skillId);return item ? instructionsAsSkill(item) : undefined;})()} device={workspace.devices.find(item=>item.id===instructionConflict.device.id) || instructionConflict.device} receipt={instructionConflict.receipt} onClose={()=>setInstructionConflict(undefined)} onResolve={async(action,expectedRevision,mergedFiles?:SkillFile[])=>{
      const {device,receipt}=instructionConflict;
      await api(`/devices/${device.id}/instructions/resolve`,"POST",{instructionId:receipt.skillId,agent:receipt.agent,profile:receipt.profile,project:receipt.project,action,expectedRevision,expectedLocalRevision:receipt.localFiles ? await reviewedFilesRevision(receipt.localFiles) : undefined,mergedFiles});
      await refresh();
    }}/>} 
    {recovery && (()=>{const version=recovery.versions[recoveryVersion];const file=version?.files[recoveryFile];return <Dialog title={`${recovery.title} recovery`} onClose={()=>setRecovery(undefined)} wide><div className="dialog-body recovery-viewer">{recovery.loading ? <p role="status"><Loader2 className="spin" size={18}/> Loading saved files…</p> : recovery.error ? <p className="notice error" role="alert">{recovery.error}</p> : <><label>Saved version<select value={recoveryVersion} onChange={event=>{setRecoveryVersion(Number(event.target.value));setRecoveryFile(0);}}>{recovery.versions.map((item,index)=><option value={index} key={item.id}>{item.message} · {revision(item.revision)}</option>)}</select></label><div className="recovery-files"><nav aria-label="Recovered files">{version?.files.map((item,index)=><button className={index===recoveryFile ? "active" : ""} onClick={()=>setRecoveryFile(index)} key={item.path}>{item.path}</button>)}</nav><section><strong>{file?.path}</strong>{file?.encoding==="base64" ? <><p>Binary file · preview unavailable.</p><a className="button small" href={`data:application/octet-stream;base64,${file.content}`} download={file.path.split("/").pop()}>Download binary file</a></> : <pre>{file?.content}</pre>}</section></div></>}<div className="dialog-actions"><button className="button" onClick={()=>setRecovery(undefined)}>Close</button></div></div></Dialog>;})()}
    {update && <UpdateReview skill={update} onClose={()=>setUpdate(undefined)} onApply={async()=>{await refresh();setUpdate(undefined);notify("Revision selected. Computers will confirm installation.");}}/>}
  </div>;
}

function UpdateReview({skill,onClose,onApply}:{skill:Skill;onClose:()=>void;onApply:()=>Promise<void>}) {
  const [complete,setComplete]=useState<Skill>();
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [ack,setAck]=useState(false);
  const [reports,setReports]=useState(false);
  const [path,setPath]=useState("");
  const [applying,setApplying]=useState(false);
  // Load once for this review. If a newer proposal appears, approval is rejected.
  useEffect(()=>{let cancelled=false; void (async()=>{
    try {
      let current=await api<Skill>(`/skills/${skill.id}`);
      if(!current.proposal) {await api(`/skills/${skill.id}/check`,"POST");current=await api<Skill>(`/skills/${skill.id}`);}
      const safety=await api(`/skills/audits?source=${encodeURIComponent(current.source)}&name=${encodeURIComponent(current.name)}`);
      if(!cancelled) setComplete({...current,safety});
    } catch(cause){if(!cancelled) setError((cause as Error).message);}finally{if(!cancelled) setLoading(false);}
  })();return ()=>{cancelled=true;};},[skill.id]);
  const comparisons=compareSkillFiles(complete?.files ?? [],complete?.proposal?.files ?? []);
  const selected=comparisons.find(item=>item.path===path) || comparisons[0];
  const needsAck=complete?.safety?.status==="warn" || complete?.safety?.status==="fail";
  const apply=async()=>{
    if(!complete?.proposal) return;
    setApplying(true);setError("");
    try{await api(`/skills/${skill.id}/update`,"POST",{expectedRevision:complete.revision,expectedUpstreamRevision:complete.proposal.revision,auditAcknowledged:ack});await onApply();}
    catch(cause){setError((cause as Error).message);}finally{setApplying(false);}
  };
  return <Dialog title={`Review ${skill.title} update`} onClose={onClose} wide><div className="dialog-body">
    {loading ? <p role="status"><Loader2 className="spin" size={18}/> Loading exact revisions and reports…</p> : complete?.proposal ? <>
      <p>Selected <code>{revision(complete.revision)}</code> · proposed <code>{revision(complete.proposal.revision)}</code> · {comparisons.length} changed files</p>
      <SafetyBadge safety={complete.safety} onReview={()=>setReports(!reports)}/>{reports && <SafetyReport safety={complete.safety} loading={false}/>}
      <div className="conflict-workbench"><nav className="conflict-files" aria-label="Updated files">{comparisons.map(item=><button key={item.path} className={selected?.path===item.path ? "active" : ""} onClick={()=>setPath(item.path)}>{item.path}<small>{item.status}</small></button>)}</nav><section className="conflict-diff" aria-label="Deployed and proposed difference"><div className="conflict-pane-title">{selected?.path} · selected / proposed</div>{selected?.binary ? <p className="binary-diff">Binary content differs. The exact file bytes are included in this revision.</p> : <div className="diff-code">{diffLines(selected?.localText ?? "",selected?.equipText ?? "").slice(0,1500).map((line,index)=><div className={`diff-line ${line.kind}`} key={index}><span>{line.localLine}</span><span>{line.equipLine}</span><code>{line.kind==="add" ? "+" : line.kind==="remove" ? "−" : " "}{line.text}</code></div>)}</div>}</section></div>
      {needsAck && <label className="audit-acknowledgment"><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/>I reviewed the upstream findings and want to install this revision.</label>}
      <p className="field-hint">Upstream reports do not certify the pinned revision. Rollback stays available in skill history.</p>
    </> : <p>The selected revision is current. Close this review and refresh Changes.</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="button" onClick={onClose}>Close</button><button className="button primary" disabled={loading || applying || !complete?.proposal || (!!needsAck && !ack)} onClick={apply}>{applying ? "Selecting revision…" : "Approve exact revision"}</button></div>
  </div></Dialog>;
}
