import net from 'node:net';

export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
}

// A tiny SMTP server that really speaks the protocol (EHLO, MAIL FROM, RCPT TO, DATA, QUIT).
// It lets us test the real nodemailer code without Docker or the internet.
export async function startFakeSmtpServer() {
  const received: ReceivedMail[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');

    let current: ReceivedMail = { from: '', to: [], data: '' };
    let inData = false;
    let buffer = '';
    const reply = (text: string) => socket.write(`${text}\r\n`);

    reply('220 fake ESMTP ready');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: '', to: [], data: '' };
          reply('250 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const command = line.toUpperCase();

        if (command.startsWith('EHLO')) socket.write('250-fake\r\n250 8BITMIME\r\n');
        else if (command.startsWith('MAIL FROM')) {
          current.from = line;
          reply('250 ok');
        } else if (command.startsWith('RCPT TO')) {
          current.to.push(line);
          reply('250 ok');
        } else if (command === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (command === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
