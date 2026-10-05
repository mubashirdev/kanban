import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse, type WebAuthnCredential } from "@simplewebauthn/server";

const CHALLENGE_COOKIE = "__Host-esa-challenge";
type Key = Omit<WebAuthnCredential, "publicKey"> & { publicKey: string };
interface State { owner: string; rpID: string; userID: string; keys: Key[] }
interface Challenge { value: string; kind: "register" | "authenticate"; until: number; session: string }
const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

export class PublicPasskeys {
  private state: State;
  private challenges = new Map<string, Challenge>();
  private rpID: string;
  constructor(private origin: string, username: string, private path: string) {
    this.rpID = new URL(origin).hostname;
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { owner: username, rpID: this.rpID, userID: randomBytes(32).toString("base64url"), keys: [] };
    if (this.state.owner !== username || this.state.rpID !== this.rpID || !Array.isArray(this.state.keys)) throw new Error("Passkey storage does not match the configured account and domain");
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); renameSync(tmp, this.path);
  }
  private issue(value: string, kind: Challenge["kind"], session: string) {
    for (const [id, item] of this.challenges) if (item.until < Date.now()) this.challenges.delete(id);
    if (this.challenges.size >= 64) this.challenges.delete(this.challenges.keys().next().value!);
    const id = randomBytes(32).toString("base64url");
    this.challenges.set(id, { value, kind, session, until: Date.now() + 300_000 });
    return `${CHALLENGE_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`;
  }
  private consume(req: Request, kind: Challenge["kind"], session: string) {
    const id = req.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${CHALLENGE_COOKIE}=`))?.slice(CHALLENGE_COOKIE.length + 1) ?? "";
    const pending = this.challenges.get(id); this.challenges.delete(id);
    return pending && pending.kind === kind && pending.session === session && pending.until > Date.now() ? pending.value : null;
  }
  stripCookie(headers: Headers) {
    const values = (headers.get("cookie") ?? "").split(";").filter((v) => v.trim() && !v.trim().startsWith(`${CHALLENGE_COOKIE}=`)).join(";");
    if (values) headers.set("cookie", values); else headers.delete("cookie");
  }
  async handle(req: Request, action: string, session: string, sessionCookie: () => string): Promise<Response> {
    const register = action.startsWith("register/");
    if (register && !session) return reply({ error: "Sign in with your password before adding a passkey." }, 401);
    if (action === "register/options") {
      if (this.state.keys.length >= 10) return reply({ error: "This account already has ten passkeys." }, 409);
      const options = await generateRegistrationOptions({ rpName: "Esa Kanban", rpID: this.rpID, userName: this.state.owner, userID: new Uint8Array(Buffer.from(this.state.userID, "base64url")), attestationType: "none", supportedAlgorithmIDs: [-7, -257], authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" }, excludeCredentials: this.state.keys.map(({ id, transports }) => ({ id, transports })) });
      return reply(options, 200, { "set-cookie": this.issue(options.challenge, "register", session) });
    }
    if (action === "authenticate/options") {
      if (!this.state.keys.length) return reply({ error: "Sign in with your password once to set up Face ID / a passkey." }, 409);
      const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: "required", allowCredentials: this.state.keys.map(({ id, transports }) => ({ id, transports })) });
      return reply(options, 200, { "set-cookie": this.issue(options.challenge, "authenticate", "") });
    }
    if (!["register/verify", "authenticate/verify"].includes(action)) return reply({ error: "Not found" }, 404);
    const challenge = this.consume(req, register ? "register" : "authenticate", register ? session : "");
    if (!challenge) return reply({ error: "This sign-in request expired. Please try again." }, 400);
    try {
      if (!req.headers.get("content-type")?.startsWith("application/json")) return reply({ error: "Expected a passkey response" }, 415);
      const reader = req.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (!reader) return reply({ error: "Missing passkey response" }, 400);
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) { await reader.cancel(); return reply({ error: "Passkey response too large" }, 413); } chunks.push(value); }
      const response = JSON.parse(Buffer.concat(chunks).toString());
      if (register) {
        if (this.state.keys.length >= 10) return reply({ error: "This account already has ten passkeys." }, 409);
        const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true });
        if (!result.verified || !result.registrationInfo || this.state.keys.some((k) => k.id === result.registrationInfo!.credential.id)) throw new Error("Invalid credential");
        const key = result.registrationInfo.credential;
        this.state.keys.push({ ...key, publicKey: Buffer.from(key.publicKey).toString("base64url") }); this.save();
        return reply({ ok: true, next: "/" });
      }
      const key = this.state.keys.find((k) => k.id === response.id);
      if (!key) throw new Error("Unknown credential");
      const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, credential: { ...key, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")) }, requireUserVerification: true });
      if (!result.verified || (key.counter > 0 && result.authenticationInfo.newCounter <= key.counter)) throw new Error("Invalid assertion");
      key.counter = Math.max(key.counter, result.authenticationInfo.newCounter); this.save();
      return reply({ ok: true, next: "/" }, 200, { "set-cookie": sessionCookie() });
    } catch { return reply({ error: "Could not verify that passkey. Please try again or use your password." }, 400); }
  }
}
