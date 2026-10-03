import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { Store } from './storage.ts';
import type { Workspace } from '../shared/types.ts';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const generic = { ok: true };
export type SendSignIn = (input: { email: string; url: string }) => Promise<void>;
export async function sendSignInEmail({ email, url }: {email: string; url: string}) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.EQUIP_RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EQUIP_EMAIL_FROM || 'Equip <onboarding@resend.dev>', to: [email],
      subject: 'Your Equip sign-in link',
      text: `Sign in to Equip:\n\n${url}\n\nThis link expires in 15 minutes and works once. If you did not request it, you can ignore this email.`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Email delivery unavailable. Please try again shortly.');
}

export async function registerEmailAuth(app: Express, options: {
  store: Store;
  registrationEmail?: string;
  publicOrigin: (req: Request) => string;
  createSession: (res: Response, accountId: string | null, demo?: boolean) => Promise<void>;
  emptyWorkspace: (name: string, email: string) => Workspace;
  send?: SendSignIn;
  enabled?: boolean;
}) {
  const enabled = options.enabled ?? !!(options.send || process.env.EQUIP_RESEND_API_KEY);
  app.get('/api/auth/config', (_req, res) => res.json({emailSignIn: enabled}));
  if (!enabled) return;
  const {store} = options;
  await store.run('CREATE TABLE IF NOT EXISTS email_authorizations (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, expires_at BIGINT NOT NULL)');
  if (store.dialect === 'postgres') await store.run('ALTER TABLE email_authorizations ENABLE ROW LEVEL SECURITY');
  const attempts = new Map<string, {count: number; until: number}>();
  const emailCooldown = new Map<string, number>();
  const allow = (key: string, limit: number) => {
    const now = Date.now();
    if (attempts.size > 2000) for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
    const previous = attempts.get(key);
    const item = previous && previous.until > now ? previous : {count:0,until:now+10*60_000};
    item.count++; attempts.set(key,item);
    return item.count <= limit;
  };
  app.post('/api/auth/email', async (req, res, next) => {
    try {
      if (!allow(`request:${req.ip}`,10)) return res.status(429).json({error:'Too many sign-in requests. Try again in a few minutes.'});
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Enter a valid email address.'});
      if (options.registrationEmail && options.registrationEmail !== email) return res.json(generic);
      const now = Date.now();
      for (const [key, until] of emailCooldown) if (until <= now) emailCooldown.delete(key);
      if ((emailCooldown.get(hash(email)) ?? 0) > now) return res.json(generic);
      emailCooldown.set(hash(email),now+60_000);
      const token = crypto.randomBytes(32).toString('base64url');
      const name = String(req.body?.name ?? '').trim().slice(0,120) || email.split('@')[0];
      const url = new URL('/signin', options.publicOrigin(req));
      url.searchParams.set('token', token);
      const returnTo = String(req.body?.returnTo ?? '');
      // Only the device approval code is carried through authentication.
      if (returnTo.startsWith('/connect?')) {
        const code = new URL(returnTo,'https://equip.invalid').searchParams.get('code');
        if (code && /^[a-z0-9-]{1,32}$/i.test(code)) url.searchParams.set('code',code);
      }
      await store.run('DELETE FROM email_authorizations WHERE expires_at<=?',now);
      await store.run('INSERT INTO email_authorizations(token_hash,email,name,expires_at) VALUES(?,?,?,?)',hash(token),email,name,now+15*60_000);
      try { await (options.send ?? sendSignInEmail)({email,url:url.toString()}); }
      catch {
        await store.run('DELETE FROM email_authorizations WHERE token_hash=?',hash(token));
        emailCooldown.delete(hash(email));
        return res.status(502).json({error:'Could not send the sign-in email. Please try again shortly.'});
      }
      res.json(generic);
    } catch (error) { next(error); }
  });
  app.post('/api/auth/email/consume', async (req,res,next) => {
    try {
      if (!allow(`consume:${req.ip}`,60)) return res.status(429).json({error:'Too many attempts. Try again in a few minutes.'});
      const token = String(req.body?.token ?? '');
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(400).json({error:'This sign-in link is invalid. Request a fresh link.'});
      const account = await store.transaction(async transaction => {
        const authorization = await transaction.get<{email:string;name:string}>('DELETE FROM email_authorizations WHERE token_hash=? AND expires_at>? RETURNING email,name',hash(token),Date.now());
        if (!authorization) return undefined;
        let account = await transaction.get<{id:string;workspace:string}>('SELECT id,workspace FROM accounts WHERE LOWER(email)=LOWER(?)',authorization.email);
        if (!account) {
          const workspace = options.emptyWorkspace(authorization.name,authorization.email);
          const id = `account_${crypto.randomBytes(12).toString('hex')}`;
          await transaction.run('INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',id,authorization.name,authorization.email,'',JSON.stringify(workspace),new Date().toISOString());
          account = await transaction.get('SELECT id,workspace FROM accounts WHERE LOWER(email)=LOWER(?)',authorization.email);
        }
        return account;
      });
      if (!account) return res.status(410).json({error:'This sign-in link has expired or was already used. Request a fresh link.'});
      await options.createSession(res,account.id);
      res.json(JSON.parse(account.workspace));
    } catch (error) { next(error); }
  });
}
