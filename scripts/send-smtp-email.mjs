import { connect as connectNet } from "node:net";
import { connect as connectTls } from "node:tls";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8"));
const { host, port, sender, password, recipients, subject, html } = payload;
if (![host, sender, password, subject, html].every((value) => typeof value === "string" && value.length > 0)
  || !Array.isArray(recipients) || recipients.length === 0) {
  throw new Error("SMTP 발송 데이터가 올바르지 않습니다.");
}

function makeReplyReader(socket) {
  let buffer = "";
  let lines = [];
  const queued = [];
  const waiters = [];
  const onData = (chunk) => {
    buffer += chunk.toString("ascii");
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary).replace(/\r$/, "");
      buffer = buffer.slice(boundary + 1);
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        const response = lines;
        lines = [];
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(response);
        else queued.push(response);
      }
    }
  };
  const onError = (error) => {
    while (waiters.length) waiters.shift().reject(error);
  };
  socket.on("data", onData);
  socket.on("error", onError);
  return {
    read() {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    detach() {
      socket.off("data", onData);
      socket.off("error", onError);
    },
  };
}

async function expectReply(reader, command, allowedCodes) {
  const replyPromise = reader.read();
  if (command) command.socket.write(`${command.text}\r\n`);
  const lines = await replyPromise;
  const code = Number(lines.at(-1)?.slice(0, 3));
  if (!allowedCodes.includes(code)) throw new Error(`SMTP 응답 오류 (${code}): ${lines.at(-1) ?? "응답 없음"}`);
  return lines;
}

function encodedHeader(value) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

async function send() {
  const socket = connectNet({ host, port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
    socket.setTimeout(30000, () => socket.destroy(new Error("SMTP 연결 시간이 초과되었습니다.")));
  });
  let reader = makeReplyReader(socket);
  await expectReply(reader, null, [220]);
  await expectReply(reader, { socket, text: "EHLO localhost" }, [250]);
  await expectReply(reader, { socket, text: "STARTTLS" }, [220]);
  reader.detach();

  const secure = connectTls({ socket, servername: host, minVersion: "TLSv1.2" });
  await new Promise((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
    secure.setTimeout(30000, () => secure.destroy(new Error("TLS 연결 시간이 초과되었습니다.")));
  });
  reader = makeReplyReader(secure);
  await expectReply(reader, { socket: secure, text: "EHLO localhost" }, [250]);
  await expectReply(reader, { socket: secure, text: "AUTH LOGIN" }, [334]);
  await expectReply(reader, { socket: secure, text: Buffer.from(sender, "utf8").toString("base64") }, [334]);
  await expectReply(reader, { socket: secure, text: Buffer.from(password, "utf8").toString("base64") }, [235]);
  await expectReply(reader, { socket: secure, text: `MAIL FROM:<${sender}>` }, [250]);
  for (const recipient of recipients) {
    await expectReply(reader, { socket: secure, text: `RCPT TO:<${recipient}>` }, [250, 251]);
  }
  await expectReply(reader, { socket: secure, text: "DATA" }, [354]);

  const htmlBase64 = Buffer.from(html, "utf8").toString("base64").match(/.{1,76}/g).join("\r\n");
  const fromDisplay = encodedHeader("PR Monitoring");
  const headers = [
    `From: ${fromDisplay} <${sender}>`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodedHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${host}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    htmlBase64,
    ".",
  ].join("\r\n");
  await expectReply(reader, { socket: secure, text: headers }, [250]);
  await expectReply(reader, { socket: secure, text: "QUIT" }, [221]);
  reader.detach();
  secure.end();
}

try {
  await send();
  process.stdout.write("SMTP 전송 완료\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
