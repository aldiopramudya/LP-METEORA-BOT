import { log } from "./util.mjs";
export class Tg {
  constructor(token, chat) { this.token = token; this.chat = chat; }
  async send(html) {
    if (!this.token || !this.chat) return;
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ chat_id: this.chat, text: html, parse_mode: "HTML", disable_web_page_preview: true }) }).then((x) => x.json()).catch(() => ({ ok: false }));
    if (!r.ok) log(`tg failed: ${r.description}`);
  }
}
