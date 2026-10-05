import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Workspace } from "../shared/types.ts";
import type { Store } from "./storage.ts";
import { rateLimitKey } from "./rate-limit.ts";

type AccountRequest = Request & {
  accountId?: string;
  workspace?: Workspace;
};

type AccountRoutesOptions = {
  store: Store;
  auth: RequestHandler;
  loadWorkspace: (accountId: string) => Promise<Workspace | undefined>;
  runAccountLocked: <T>(accountId: string, work: () => Promise<T>) => Promise<T>;
};

function accountId(req: AccountRequest): string {
  if (!req.accountId) throw Object.assign(new Error("authentication_required"), { status: 401 });
  return req.accountId;
}

export function registerAccountRoutes(app: Express, options: AccountRoutesOptions) {
  const route = (handler: (req: AccountRequest, res: Response) => Promise<void>) =>
    async (req: AccountRequest, res: Response, next: NextFunction) => {
      try {
        await handler(req, res);
      } catch (error) {
        next(error);
      }
    };

  app.get("/api/account/export", options.auth, route(async (req, res) => {
    const id = accountId(req);
    const workspace = await options.runAccountLocked(id, () => options.loadWorkspace(id));
    if (!workspace) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    res
      .status(200)
      .type("application/json")
      .attachment("equip-account-export.json")
      .send(JSON.stringify(workspace, null, 2));
  }));

  app.post("/api/account/logout-all", options.auth, route(async (req, res) => {
    const id = accountId(req);
    await options.runAccountLocked(id, () =>
      options.store.run("DELETE FROM sessions WHERE account_id=?", id).then(() => undefined),
    );
    res.clearCookie("equip_session", { path: "/" });
    res.json({ ok: true });
  }));

  app.delete("/api/account", options.auth, route(async (req, res) => {
    const id = accountId(req);
    const confirmation = String(req.body?.email ?? "").trim().toLowerCase();
    if (!confirmation) {
      res.status(400).json({ error: "Enter your account email to confirm deletion." });
      return;
    }
    const deleted = await options.runAccountLocked(id, () =>
      options.store.transaction(async transaction => {
        const account = await transaction.get<{ email: string }>(
          "SELECT email FROM accounts WHERE id=?",
          id,
        );
        if (!account) return false;
        if (account.email.toLowerCase() !== confirmation)
          throw Object.assign(new Error("The confirmation email does not match this account."), { status: 400 });
        await transaction.run("DELETE FROM email_authorizations WHERE LOWER(email)=LOWER(?)", account.email);
        await transaction.run("DELETE FROM auth_rate_limits WHERE key=?", rateLimitKey("email-request-address", account.email.toLowerCase()));
        await transaction.run("DELETE FROM sessions WHERE account_id=?", id);
        await transaction.run("DELETE FROM device_tokens WHERE account_id=?", id);
        await transaction.run("DELETE FROM device_authorizations WHERE account_id=?", id);
        await transaction.run("DELETE FROM skill_bundles WHERE account_id=?", id);
        await transaction.run("DELETE FROM workspace_devices WHERE account_id=?", id);
        const result = await transaction.run("DELETE FROM accounts WHERE id=?", id);
        return result.changes === 1;
      }),
    );
    if (!deleted) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    res.clearCookie("equip_session", { path: "/" });
    res.json({ deleted: true, localFiles: "retained" });
  }));
}
