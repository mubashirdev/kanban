// Native WebAuthn: private keys and Face ID stay with the device authenticator.
const decode = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const encode = (value) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const optionsFromJSON = (options) => ({ ...options, challenge: decode(options.challenge), ...(options.user ? { user: { ...options.user, id: decode(options.user.id) } } : {}), ...(options.allowCredentials ? { allowCredentials: options.allowCredentials.map((c) => ({ ...c, id: decode(c.id) })) } : {}), ...(options.excludeCredentials ? { excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: decode(c.id) })) } : {}) });
const credentialJSON = (credential) => {
  const response = credential.response;
  return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment, clientExtensionResults: credential.getClientExtensionResults(), response: { clientDataJSON: encode(response.clientDataJSON), ...(response.attestationObject ? { attestationObject: encode(response.attestationObject), transports: response.getTransports?.() ?? [] } : { authenticatorData: encode(response.authenticatorData), signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null }) } };
};
async function request(path, body = {}) {
  const response = await fetch(`/auth/passkey/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Please try again.");
  return data;
}
for (const button of document.querySelectorAll("[data-passkey]")) {
  if (!window.PublicKeyCredential || !window.isSecureContext) { button.hidden = true; continue; }
  button.addEventListener("click", async () => {
    const message = document.getElementById("passkey-status");
    button.disabled = true; message.textContent = "Waiting for your device…";
    const register = button.dataset.passkey === "register", kind = register ? "register" : "authenticate";
    try {
      const options = optionsFromJSON(await request(`${kind}/options`));
      const credential = await navigator.credentials[register ? "create" : "get"]({ publicKey: options });
      if (!credential) throw new Error("No passkey was selected.");
      await request(`${kind}/verify`, credentialJSON(credential));
      location.assign("/");
    } catch (error) {
      message.textContent = error.name === "NotAllowedError" ? "Passkey request cancelled. You can try again or use your password." : error.message;
      button.disabled = false;
    }
  });
}
