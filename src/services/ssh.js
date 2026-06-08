import { Client } from 'ssh2';
import net from 'node:net';

function connectionOptions(device = {}) {
  const options = {
    host: device.host,
    port: device.sshPort || 22,
    username: device.sshUser,
    readyTimeout: 12000,
    keepaliveInterval: 5000
  };

  if (device.sshPrivateKey) options.privateKey = device.sshPrivateKey;
  if (device.sshPassword) options.password = device.sshPassword;
  return options;
}

export function runSshCommand(device, command, timeoutMs = 20000) {
  const cleanCommand = String(command || '').trim();
  if (!cleanCommand) {
    return Promise.reject(new Error('Informe um comando para executar.'));
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer;

    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      if (error) reject(error);
      else resolve(result);
    }

    timer = setTimeout(() => {
      finish(new Error('Tempo limite do comando SSH atingido.'));
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.exec(cleanCommand, (error, stream) => {
          if (error) {
            finish(error);
            return;
          }

          stream
            .on('close', (code, signal) => {
              finish(null, {
                stdout,
                stderr,
                code: code ?? 0,
                signal: signal || ''
              });
            })
            .on('data', (data) => {
              stdout += data.toString();
            });

          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });
        });
      })
      .on('error', (error) => {
        finish(error);
      })
      .connect(connectionOptions(device));
  });
}

function encodeApiLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length >> 8) | 0x80, length & 0xff]);
  if (length < 0x200000) return Buffer.from([(length >> 16) | 0xc0, (length >> 8) & 0xff, length & 0xff]);
  if (length < 0x10000000) {
    return Buffer.from([(length >> 24) | 0xe0, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  }
  return Buffer.from([0xf0, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function decodeApiLength(buffer, offset) {
  const first = buffer[offset];
  if (first < 0x80) return { length: first, offset: offset + 1 };
  if ((first & 0xc0) === 0x80) return { length: ((first & ~0xc0) << 8) + buffer[offset + 1], offset: offset + 2 };
  if ((first & 0xe0) === 0xc0) {
    return { length: ((first & ~0xe0) << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2], offset: offset + 3 };
  }
  if ((first & 0xf0) === 0xe0) {
    return {
      length: ((first & ~0xf0) << 24) + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3],
      offset: offset + 4
    };
  }
  return {
    length: (buffer[offset + 1] << 24) + (buffer[offset + 2] << 16) + (buffer[offset + 3] << 8) + buffer[offset + 4],
    offset: offset + 5
  };
}

function encodeApiWord(value) {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeApiLength(data.length), data]);
}

function encodeApiSentence(words) {
  return Buffer.concat([...words.map(encodeApiWord), Buffer.from([0])]);
}

function parseApiWords(words) {
  const result = {};
  for (const word of words.slice(1)) {
    const match = word.match(/^=([^=]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

class ApiParser {
  buffer = Buffer.alloc(0);
  current = [];
  sentences = [];

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let offset = 0;

    while (offset < this.buffer.length) {
      const start = offset;
      const decoded = decodeApiLength(this.buffer, offset);
      if (decoded.offset > this.buffer.length || decoded.offset + decoded.length > this.buffer.length) {
        offset = start;
        break;
      }

      offset = decoded.offset;
      if (decoded.length === 0) {
        this.sentences.push(this.current);
        this.current = [];
        continue;
      }

      this.current.push(this.buffer.subarray(offset, offset + decoded.length).toString('utf8'));
      offset += decoded.length;
    }

    this.buffer = this.buffer.subarray(offset);
  }
}

function routerOsWordsFromCommand(command) {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !parts[0].startsWith('/')) throw new Error('Comando RouterOS invalido.');

  const pathParts = [];
  const words = [];
  for (const part of parts) {
    if (part.startsWith('=') || part.includes('=')) {
      words.push(part.startsWith('=') ? part : `=${part}`);
    } else {
      pathParts.push(part.replace(/^\/+/, ''));
    }
  }

  return [`/${pathParts.join('/')}`, ...words];
}

export function runRouterOsApiCommand(device, command, timeoutMs = 20000) {
  const words = routerOsWordsFromCommand(command);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: device.host,
      port: device.sshPort || 8728,
      timeout: Math.min(timeoutMs, 12000)
    });
    const parser = new ApiParser();
    let done = false;
    let timer;

    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.end();
      if (error) reject(error);
      else resolve(result);
    }

    timer = setTimeout(() => finish(new Error('Tempo limite da API RouterOS atingido.')), timeoutMs);
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', (error) => finish(error));
    socket.on('timeout', () => finish(new Error('Timeout conectando na API RouterOS.')));
    socket.on('connect', async () => {
      socket.write(encodeApiSentence(['/login', `=name=${device.sshUser}`, `=password=${device.sshPassword}`]));
      await new Promise((resolve) => setTimeout(resolve, 700));
      socket.write(encodeApiSentence(words));

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !done) {
        const commandSentences = parser.sentences.slice(1);
        if (commandSentences.some((sentence) => ['!done', '!empty', '!trap', '!fatal'].includes(sentence[0]))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const loginSentence = parser.sentences.shift();
      if (!loginSentence || loginSentence[0] !== '!done') {
        finish(new Error(`Falha ao autenticar na API RouterOS: ${(loginSentence || []).join(' ')}`));
        return;
      }

      const rows = [];
      for (const sentence of parser.sentences) {
        const type = sentence[0];
        if (type === '!re') rows.push(parseApiWords(sentence));
        if (type === '!done' || type === '!empty') {
          finish(null, {
            stdout: rows.map((row) => JSON.stringify(row)).join('\n') || 'OK',
            stderr: '',
            code: 0,
            signal: ''
          });
          return;
        }
        if (type === '!trap' || type === '!fatal') {
          const details = parseApiWords(sentence);
          finish(new Error(details.message || sentence.join(' ')));
          return;
        }
      }

      finish(new Error('Timeout aguardando resposta da API RouterOS.'));
    });
  });
}

export function runDeviceCommand(device, command, timeoutMs = 20000) {
  if (device.connectionType === 'routeros_api') {
    return runRouterOsApiCommand(device, command, timeoutMs);
  }
  return runSshCommand(device, command, timeoutMs);
}
