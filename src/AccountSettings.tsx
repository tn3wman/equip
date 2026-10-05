import { useState } from "react";
import { Download, LogOut, Trash2 } from "lucide-react";
import type { Workspace } from "../shared/types";
import { api } from "./api";

export default function AccountSettings({ workspace }: { workspace: Workspace }) {
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"export" | "logout" | "delete">();
  const [error, setError] = useState("");

  if (workspace.demo) return null;

  const exportAccount = async () => {
    setBusy("export");
    setError("");
    try {
      const response = await fetch("/api/account/export", { credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Could not export this account.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "equip-account-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export this account.");
    } finally {
      setBusy(undefined);
    }
  };

  const logoutAll = async () => {
    setBusy("logout");
    setError("");
    try {
      await api("/account/logout-all", "POST");
      location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
      setBusy(undefined);
    }
  };

  const deleteAccount = async () => {
    setBusy("delete");
    setError("");
    try {
      await api("/account", "DELETE", { email: confirmation });
      location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this account.");
      setBusy(undefined);
    }
  };

  const confirmed = confirmation.trim().toLowerCase() === workspace.email.toLowerCase();
  return (
    <section className="settings-section account-settings">
      <h2>Account data</h2>
      {error && <p className="account-settings-error" role="alert">{error}</p>}
      <div className="settings-row">
        <div>
          <strong>Download your account</strong>
          <p>Export every skill, instruction, saved version, device record, and activity entry as JSON.</p>
        </div>
        <button className="button" disabled={Boolean(busy)} onClick={exportAccount}>
          <Download size={14} /> {busy === "export" ? "Preparing…" : "Download JSON"}
        </button>
      </div>
      <div className="settings-row">
        <div>
          <strong>Sign out everywhere</strong>
          <p>End every browser session for this account. Connected computers keep synchronizing.</p>
        </div>
        <button className="button" disabled={Boolean(busy)} onClick={logoutAll}>
          <LogOut size={14} /> {busy === "logout" ? "Signing out…" : "Sign out everywhere"}
        </button>
      </div>
      <div className="settings-row account-delete-row">
        <div>
          <strong>Delete account</strong>
          <p>Delete the workspace, history, browser sessions, and device access. Files already on your computers stay in place.</p>
        </div>
        {!deleting && (
          <button className="button danger" disabled={Boolean(busy)} onClick={() => setDeleting(true)}>
            <Trash2 size={14} /> Delete account
          </button>
        )}
      </div>
      {deleting && (
        <div className="account-delete-confirmation">
          <p>This cannot be undone. Type <strong>{workspace.email}</strong> to delete the account.</p>
          <label className="field">
            <span>Account email</span>
            <input
              autoFocus
              autoComplete="off"
              value={confirmation}
              onChange={event => setConfirmation(event.target.value)}
            />
          </label>
          <div className="account-delete-actions">
            <button className="button" disabled={busy === "delete"} onClick={() => { setDeleting(false); setConfirmation(""); }}>
              Cancel
            </button>
            <button className="button danger-button" disabled={!confirmed || Boolean(busy)} onClick={deleteAccount}>
              {busy === "delete" ? "Deleting…" : "Delete account permanently"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
