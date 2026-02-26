import path from 'path';

import { Channel, MessageAttachment, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAttachment(a: MessageAttachment): string {
  // Map host localPath to container path: data/media/main/foo.jpg → /workspace/media/foo.jpg
  const containerPath = `/workspace/media/${path.basename(a.localPath)}`;
  const attrs = [`type="${escapeXml(a.type)}"`, `path="${escapeXml(containerPath)}"`];
  if (a.type === 'document') {
    attrs.push(`filename="${escapeXml(a.fileName)}"`);
    if (a.mimeType) attrs.push(`mime="${escapeXml(a.mimeType)}"`);
    if (a.fileSize) attrs.push(`size="${a.fileSize}"`);
  }
  return `<attachment ${attrs.join(' ')} />`;
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    const attachmentLines = (m.attachments || []).map((a) => `\n  ${formatAttachment(a)}`).join('');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}${attachmentLines}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
