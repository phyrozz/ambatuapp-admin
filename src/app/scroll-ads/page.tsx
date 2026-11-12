"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { fetchAuthSession } from "aws-amplify/auth";
import {
  ImagePlus,
  Images,
  Link2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { AdminShell, PageHeader } from "../../components/admin-shell";
import { Allowed } from "../../components/studio-access-provider";
import { authConfigured, configureAuth } from "../../lib/auth";

type Ad = {
  id: string;
  title: string;
  imageUrl: string;
  destinationUrl: string;
  active: boolean;
};
const empty = { title: "", destinationUrl: "", active: false };
async function api(path: string, options: RequestInit = {}) {
  configureAuth();
  const token = authConfigured()
    ? (await fetchAuthSession()).tokens?.idToken?.toString()
    : undefined;
  const response = await fetch(path, {
    ...options,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
export default function ScrollAdsPage() {
  const [ads, setAds] = useState<Ad[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Ad | "new" | null>(null);
  const [form, setForm] = useState(empty);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const sentinel = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const load = useCallback(async () => {
    if (pending.current || !more) return;
    pending.current = true;
    setLoading(true);
    try {
      const data = await api(
        `/api/scroll-ads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setAds((items) => [
        ...items,
        ...data.ads.filter(
          (ad: Ad) => !items.some((item) => item.id === ad.id),
        ),
      ]);
      setCursor(data.nextCursor);
      setMore(!!data.nextCursor);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load ads.");
      setMore(false);
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }, [cursor, more]);
  useEffect(() => {
    if (!sentinel.current || !more) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void load();
      },
      { rootMargin: "400px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [load, more]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  function chooseFile(next: File | null) {
    setFile(next);
    setPreview(next ? URL.createObjectURL(next) : '');
  }
  function edit(ad: Ad | "new") {
    setEditing(ad);
    chooseFile(null);
    setForm(
      ad === "new"
        ? empty
        : {
            title: ad.title,
            destinationUrl: ad.destinationUrl,
            active: ad.active,
          },
    );
    setError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    if (editing === "new" && !file) {
      setError("Choose a banner image to upload.");
      return;
    }
    if (
      file &&
      (!["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 3 * 1024 * 1024 ||
        !file.size)
    ) {
      setError("Choose a PNG, JPG, or WebP image no larger than 3 MB.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body = new FormData();
      body.set("title", form.title);
      body.set("destinationUrl", form.destinationUrl);
      body.set("active", String(form.active));
      if (file) body.set("image", file);
      const result: Ad = await api(
        editing === "new"
          ? "/api/scroll-ads"
          : `/api/scroll-ads/${encodeURIComponent(editing.id)}`,
        { method: editing === "new" ? "POST" : "PATCH", body },
      );
      setAds((items) =>
        editing === "new"
          ? [result, ...items]
          : items.map((item) => (item.id === result.id ? result : item)),
      );
      setEditing(null);
      chooseFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save ad.");
    } finally {
      setSaving(false);
    }
  }
  async function remove(ad: Ad) {
    if (!window.confirm(`Delete "${ad.title}"?`)) return;
    setSaving(true);
    try {
      await api(`/api/scroll-ads/${encodeURIComponent(ad.id)}`, {
        method: "DELETE",
      });
      setAds((items) => items.filter((item) => item.id !== ad.id));
      if (editing !== "new" && editing?.id === ad.id) {
        setEditing(null);
        chooseFile(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete ad.");
    } finally {
      setSaving(false);
    }
  }
  const image =
    preview || (editing && editing !== "new" ? editing.imageUrl : "");
  return (
    <AdminShell>
      <PageHeader
        eyebrow="AMBATUSCROLL / ADVERTISING"
        title="Scroll ads"
        description="Manage the banners that appear between clips."
        action={
          <Allowed module="scroll-ads" action="add">
            <button className="button primary" onClick={() => edit("new")}>
              <Plus size={17} />
              Add banner
            </button>
          </Allowed>
        }
      />
      {error && (
        <p className="scroll-ads-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <form
          className="scroll-ad-editor"
          onSubmit={(event) => void save(event)}
        >
          <div className="scroll-ad-editor-heading">
            <div>
              <h2>{editing === "new" ? "Create a banner" : "Edit banner"}</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close editor"
              disabled={saving}
              onClick={() => {
                setEditing(null);
                chooseFile(null);
              }}
            >
              <X size={19} />
            </button>
          </div>
          <div className="scroll-ad-editor-grid">
            <div className="scroll-ad-fields">
              <label>
                Banner title
                <input
                  required
                  maxLength={120}
                  value={form.title}
                  placeholder="e.g. Explore our latest collection"
                  onChange={(event) =>
                    setForm({ ...form, title: event.target.value })
                  }
                />
              </label>
              <label>
                Destination URL
                <input
                  required
                  type="url"
                  value={form.destinationUrl}
                  placeholder="https://example.com"
                  onChange={(event) =>
                    setForm({ ...form, destinationUrl: event.target.value })
                  }
                />
                <small>
                  Visitors will open this link when they select the banner.
                </small>
              </label>
              <label className="scroll-ad-status">
                <span>
                  <strong>Active banner</strong>
                  <small>
                    {form.active
                      ? "Eligible to appear in AmbatuScroll"
                      : "Saved as a draft and hidden from visitors"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(event) =>
                    setForm({ ...form, active: event.target.checked })
                  }
                />
              </label>
            </div>
            <div className="scroll-ad-creative">
              <div className="scroll-ad-creative-title">
                <strong>Banner image</strong>
                <span>PNG, JPG or WebP - up to 3 MB</span>
              </div>
              <div className={`scroll-ad-preview${image ? " has-image" : ""}`}>
                {image ? (
                  <img src={image} alt="Banner preview" />
                ) : (
                  <div>
                    <ImagePlus size={30} />
                    <span>Choose an image to preview it</span>
                  </div>
                )}
              </div>
              <Allowed module="scroll-ads" action="upload">
                <label className="scroll-ad-upload button ghost">
                  <ImagePlus size={17} />
                  {file
                    ? "Change image"
                    : image
                      ? "Replace image"
                      : "Choose image"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) =>
                      chooseFile(event.target.files?.[0] ?? null)
                    }
                    disabled={saving}
                  />
                </label>
              </Allowed>
              {file && (
                <small className="scroll-ad-filename">{file.name}</small>
              )}
            </div>
          </div>
          <div className="scroll-ad-editor-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setEditing(null);
                chooseFile(null);
              }}
              disabled={saving}
            >
              Cancel
            </button>
            <button className="button primary" disabled={saving}>
              {saving ? "Saving..." : "Save banner"}
            </button>
          </div>
        </form>
      )}
      <section className="scroll-ads-library">
        <div className="scroll-ads-library-heading">
          <div>
            <h2>Banner library</h2>
          </div>
          <span>{ads.length} loaded</span>
        </div>
        <div className="scroll-ads-admin-list">
          {ads.map((ad) => (
            <article className="scroll-ads-admin-card" key={ad.id}>
              <img src={ad.imageUrl} alt="" />
              <div className="scroll-ads-card-content">
                <span
                  className={`scroll-ad-badge${ad.active ? " is-active" : ""}`}
                >
                  {ad.active ? "Active" : "Draft"}
                </span>
                <h3>{ad.title}</h3>
                <a
                  href={ad.destinationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Link2 size={14} />
                  {ad.destinationUrl}
                </a>
              </div>
              <div className="scroll-ads-card-actions">
                <Allowed module="scroll-ads" action="edit">
                  <button className="button ghost" onClick={() => edit(ad)}>
                    <Pencil size={15} />
                    Edit
                  </button>
                </Allowed>
                <Allowed module="scroll-ads" action="delete">
                  <button
                    className="icon-button"
                    aria-label={`Delete ${ad.title}`}
                    disabled={saving}
                    onClick={() => void remove(ad)}
                  >
                    <Trash2 size={17} />
                  </button>
                </Allowed>
              </div>
            </article>
          ))}
          {!loading && !more && !ads.length && !error && (
            <div className="scroll-ads-empty">
              <Images size={30} />
              <strong>No banners yet</strong>
            </div>
          )}
          <div ref={sentinel} aria-live="polite">
            {loading && "Loading banners..."}
          </div>
          {error && !more && (
            <button
              className="button ghost"
              onClick={() => {
                setError("");
                setMore(true);
              }}
            >
              Retry
            </button>
          )}
        </div>
      </section>
    </AdminShell>
  );
}
