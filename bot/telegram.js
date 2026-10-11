const API = 'https://api.telegram.org/bot';

class TelegramBot {
  constructor(token) {
    this.token = token;
    this.offset = 0;
    this.base = API + token;
  }

  async raw(method, body = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const e = new Error(`Telegram ${method}: ${data.description || 'unknown error'}`);
      e.code = data.error_code;
      throw e;
    }
    return data.result;
  }

  getMe() {
    return this.raw('getMe');
  }

  getUpdates(opts = {}) {
    return this.raw('getUpdates', {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ['message'],
      ...opts,
    });
  }

  sendMessage(chatId, text, opts = {}) {
    return this.raw('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...opts });
  }

  editMessageText(chatId, messageId, text, opts = {}) {
    return this.raw('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...opts });
  }

  sendDocument(chatId, document, opts = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([document.buffer], { type: 'text/plain' }), document.name);
    if (opts.caption) form.append('caption', opts.caption);
    if (opts.parse_mode) form.append('parse_mode', opts.parse_mode);
    return this.rawMulti(form);
  }

  async rawMulti(form) {
    const res = await fetch(`${this.base}/sendDocument`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(`Telegram sendDocument: ${data.description || 'unknown error'}`);
    }
    return data.result;
  }

  async downloadFile(fileId) {
    const file = await this.raw('getFile', { file_id: fileId });
    const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const name = (file.file_path || '').split('/').pop() || 'file.txt';
    return { name, buffer: buf };
  }

  async acknowledge(updateId) {
    if (updateId >= this.offset) this.offset = updateId + 1;
  }
}

module.exports = { TelegramBot };
