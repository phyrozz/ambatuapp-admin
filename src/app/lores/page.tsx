'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Eye, ImagePlus, Languages, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { Allowed } from '../../components/studio-access-provider';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { EmptyState, Notice, Spinner } from '../../components/admin-ui';
import { authConfigured, configureAuth } from '../../lib/auth';
import { LORE_TEXT_LIMIT, type Lore, type LoreTranslation } from '../../lib/lore';

const blank = (): Lore => ({ id: crypto.randomUUID(), title: '', text: '', translations: [], tags: [], imageKeys: [], status: 'Draft', updated: 'Just now' });
async function api(path: string, options?: RequestInit) {
  configureAuth();
  const token = authConfigured() ? (await fetchAuthSession()).tokens?.idToken?.toString() : undefined;
  return fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options?.headers } });
}
export default function LoresAdmin() {
  const [lores, setLores] = useState<Lore[]>([]), [selected, setSelected] = useState<Lore | null>(null), [draft, setDraft] = useState<Lore | null>(null), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false), [cursor, setCursor] = useState<string | null>(null), [moreError, setMoreError] = useState(false);
  const generation = useRef(0), inFlight = useRef(false), listRef = useRef<HTMLElement>(null), sentinelRef = useRef<HTMLDivElement>(null);
  const fetchPage = useCallback(async (next: string | null, requestGeneration: number) => {
    const params = new URLSearchParams({ limit: '30' });
    if (next) params.set('cursor', next);
    const response = await api(`/api/lores?${params}`), data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (requestGeneration !== generation.current) return;
    const page: Lore[] = Array.isArray(data.lores) ? data.lores : [];
    setLores(current => {
      if (!next) return page;
      const known = new Set(current.map(item => item.id));
      return [...current, ...page.filter(item => !known.has(item.id))];
    });
    if (!next) setSelected(page[0] ?? null);
    setCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
  }, []);
  const load = useCallback(async () => {
    const current = ++generation.current;
    inFlight.current = false; setLoading(true); setLoadingMore(false); setCursor(null); setMoreError(false);
    try { await fetchPage(null, current); }
    catch (error) { if (current === generation.current) setNotice(error instanceof Error ? error.message : 'Could not load lore.'); }
    finally { if (current === generation.current) setLoading(false); }
  }, [fetchPage]);
  useEffect(() => {
    const currentGeneration = generation;
    const timer = setTimeout(() => void load(), 0);
    return () => { clearTimeout(timer); currentGeneration.current++; };
  }, [load]);
  const loadMore = useCallback(async () => {
    if (!cursor || loading || inFlight.current) return;
    const current = generation.current;
    inFlight.current = true; setLoadingMore(true); setMoreError(false);
    try { await fetchPage(cursor, current); }
    catch { if (current === generation.current) setMoreError(true); }
    finally { if (current === generation.current) { inFlight.current = false; setLoadingMore(false); } }
  }, [cursor, fetchPage, loading]);
  useEffect(() => {
    const root = listRef.current, target = sentinelRef.current;
    if (!root || !target || !cursor || loading || loadingMore || moreError) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMore(); }, { root, rootMargin: '150px 0px' });
    observer.observe(target); return () => observer.disconnect();
  }, [cursor, loadMore, loading, loadingMore, moreError]);
  async function save(value: Lore) {
    try {
      const exists = lores.some(item => item.id === value.id), response = await api(exists ? `/api/lores/${value.id}` : '/api/lores', { method: exists ? 'PATCH' : 'POST', body: JSON.stringify(value) }), data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setLores(items => exists ? items.map(item => item.id === data.id ? data : item) : [data, ...items]);
      setSelected(data); setDraft(null); setNotice(`${value.title} was saved.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save lore.'); throw error; }
  }
  async function remove(lore: Lore) {
    if (!confirm(`Delete ${lore.title}? Its images will also be removed.`)) return;
    const response = await api(`/api/lores/${lore.id}`, { method: 'DELETE' }), data = await response.json();
    if (!response.ok) { setNotice(data.error); return; }
    const remaining = lores.filter(item => item.id !== lore.id);
    setLores(remaining); setSelected(remaining[0] ?? null); setDraft(null);
  }
  return (
    <AdminShell>
      <PageHeader eyebrow="AMBAVERSE / LORE" title="Lore archive" count={lores.length} description="Create long-form lore and optional translated editions." action={
        <Allowed module="lores" action="add">
          <button className="button primary" onClick={() => { setSelected(null); setDraft(blank()); }}>
            <Plus size={17} />
            Add lore
          </button>
        </Allowed>
      } />
      <Notice>{notice}</Notice>
      {loading ? (
        <div className="section-loader">
          <Spinner label="Loading lore archive" />
        </div>
      ) : (
        <div className="lore-split">
          <aside className="lore-list" ref={listRef}>
            <div className="lore-list-heading">
              <strong>All lore</strong>
              <span>{lores.length}</span>
            </div>
            {lores.map(lore => (
              <button key={lore.id} className={selected?.id === lore.id && !draft ? 'active' : ''} onClick={() => { setSelected(lore); setDraft(null); }}>
                <span className="lore-list-thumb">
                  {lore.imageUrls?.[0] ? <img src={lore.imageUrls[0]} alt="" /> : <ImagePlus size={18} />}
                </span>
                <span>
                  <strong>{lore.title}</strong>
                  <small>{lore.status} · {lore.translations?.length ?? 0} translations</small>
                </span>
              </button>
            ))}
            {cursor && (
              <div ref={sentinelRef}>
                {loadingMore && <Spinner label="Loading lore archive" />}
                {moreError && <button type="button" onClick={() => void loadMore()}>Retry</button>}
              </div>
            )}
          </aside>
          <section className="lore-detail">
            {draft ? (
              <Allowed module="lores" action={lores.some(item => item.id === draft.id) ? 'edit' : 'add'}>
                <LoreForm lore={draft} cancel={() => setDraft(null)} save={save} api={api} />
              </Allowed>
            ) : selected ? (
              <LoreView lore={selected} edit={() => setDraft({ ...selected, translations: [...(selected.translations ?? [])] })} remove={() => void remove(selected)} />
            ) : <EmptyState title="Choose a lore entry" description="Select an item or create a new one." />}
          </section>
        </div>
      )}
    </AdminShell>
  );
}

function LoreView({lore,edit,remove}:{lore:Lore;edit:()=>void;remove:()=>void}){return <div className="lore-view"><div className="detail-actions"><span className={`status ${lore.status.toLowerCase()}`}>{lore.status}</span><Allowed module="lores" action="edit"><button className="button ghost" onClick={edit}><Pencil size={16}/>Edit</button></Allowed><Allowed module="lores" action="delete"><button className="icon-button danger" onClick={remove}><Trash2 size={16}/></button></Allowed></div><p className="eyebrow">LORE ENTRY</p><h2>{lore.title}</h2><div className="tag-row">{lore.tags.map(tag=><span key={tag}>{tag}</span>)}</div>{Boolean(lore.translations?.length)&&<div className="translation-summary"><Languages size={16}/>{lore.translations!.map(item=>item.label).join(', ')}</div>}{lore.imageUrls?.length?<div className="lore-gallery">{lore.imageUrls.map((url,index)=><img key={url} src={url} alt={`${lore.title} image ${index+1}`}/>)}</div>:<div className="lore-gallery-empty"><ImagePlus/><span>No images attached</span></div>}<div className="lore-copy">{lore.text.split(/\n\s*\n/).map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div><footer><Eye size={15}/>Public when published · {lore.upvotes??0} upvotes · {lore.commentCount??0} comments</footer></div>}

function LoreForm({lore,cancel,save,api}:{lore:Lore;cancel:()=>void;save:(value:Lore)=>Promise<void>;api:(path:string,options?:RequestInit)=>Promise<Response>}){
  const[draft,setDraft]=useState({...lore,translations:lore.translations??[]}),[tag,setTag]=useState(''),[busy,setBusy]=useState(false),[uploading,setUploading]=useState(false),[uploadError,setUploadError]=useState('');
  function addTag(){const value=tag.trim();if(value&&!draft.tags.some(item=>item.toLowerCase()===value.toLowerCase()))setDraft(current=>({...current,tags:[...current.tags,value]}));setTag('')}
  function addTranslation(){setDraft(current=>({...current,translations:[...(current.translations??[]),{locale:'',label:'',title:'',text:''}]}))}
  function updateTranslation(index:number,patch:Partial<LoreTranslation>){setDraft(current=>({...current,translations:(current.translations??[]).map((item,i)=>i===index?{...item,...patch}:item)}))}
  async function upload(file?:File){if(!file)return;setUploading(true);setUploadError('');try{const response=await api('/api/character-images/presign',{method:'POST',body:JSON.stringify({fileName:file.name,contentType:file.type,characterId:draft.id,scope:'lores'})}),data=await response.json();if(!response.ok)throw new Error(data.error);const put=await fetch(data.uploadUrl,{method:'PUT',headers:{'content-type':file.type},body:file});if(!put.ok)throw new Error(`S3 upload failed (${put.status})`);setDraft(current=>({...current,imageKeys:[...current.imageKeys,data.key],imageUrls:[...(current.imageUrls??[]),URL.createObjectURL(file)]}))}catch(error){setUploadError(error instanceof Error?error.message:'Image upload failed.')}finally{setUploading(false)}}
  async function submit(event:FormEvent){event.preventDefault();setBusy(true);try{await save(draft)}finally{setBusy(false)}}
  return <form className="lore-form" onSubmit={submit}><div className="detail-actions"><span className="detail-mode"><Pencil size={15}/>{lore.title?'Editing lore':'New lore'}</span><button type="button" className="icon-button" onClick={cancel}><X size={18}/></button></div><label>Original title<input value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})} required/></label><label>Original lore text<textarea value={draft.text} maxLength={LORE_TEXT_LIMIT} onChange={event=>setDraft({...draft,text:event.target.value})} rows={14} required/><small>{draft.text.length.toLocaleString()} / {LORE_TEXT_LIMIT.toLocaleString()} characters</small></label><section className="translation-editor"><div><span><Languages size={18}/><strong>Translated editions</strong></span><button type="button" className="button ghost" onClick={addTranslation}><Plus size={15}/>Add language</button></div>{draft.translations?.map((translation,index)=><article key={index}><header><strong>Translation {index+1}</strong><button type="button" className="icon-button danger" onClick={()=>setDraft({...draft,translations:draft.translations?.filter((_,i)=>i!==index)})}><Trash2 size={15}/></button></header><div className="form-grid"><label>Language name<input value={translation.label} onChange={event=>updateTranslation(index,{label:event.target.value})} placeholder="Filipino" required/></label><label>Language code<input value={translation.locale} onChange={event=>updateTranslation(index,{locale:event.target.value.toLowerCase()})} placeholder="fil" required/></label></div><label>Translated title<input value={translation.title} onChange={event=>updateTranslation(index,{title:event.target.value})} required/></label><label>Translated lore text<textarea value={translation.text} maxLength={LORE_TEXT_LIMIT} onChange={event=>updateTranslation(index,{text:event.target.value})} rows={10} required/><small>{translation.text.length.toLocaleString()} / {LORE_TEXT_LIMIT.toLocaleString()}</small></label></article>)}</section><Allowed module="lores" action="upload"><label className="image-picker"><span><ImagePlus size={24}/></span><div><strong>{uploading?'Uploading…':'Add another image'}</strong><small>JPG, PNG, or WEBP</small></div><input type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>void upload(event.target.files?.[0])}/></label></Allowed>{uploadError&&<Notice>{uploadError}</Notice>}<div className="image-strip">{draft.imageUrls?.map((url,index)=><img src={url} alt={`Lore image ${index+1}`} key={url}/>)}</div><div className="form-grid"><label>Tags<div className="tag-input"><div>{draft.tags.map(item=><span key={item}>{item}<button type="button" onClick={()=>setDraft({...draft,tags:draft.tags.filter(value=>value!==item)})}><X size={11}/></button></span>)}</div><input value={tag} onChange={event=>setTag(event.target.value)} onBlur={addTag} onKeyDown={event=>{if(event.key==='Enter'||event.key===','){event.preventDefault();addTag()}}}/></div></label><label>Status<select value={draft.status} onChange={event=>setDraft({...draft,status:event.target.value as Lore['status']})}><option>Draft</option><option>Published</option></select></label></div><div className="modal-actions"><button className="button ghost" type="button" onClick={cancel}>Cancel</button><button className="button primary" disabled={busy||uploading}>{busy?<Spinner label="Saving"/>:<><Save size={16}/>Save lore</>}</button></div></form>
}
