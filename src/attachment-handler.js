import { createVoiceTranscriber, formatVoiceTranscriberStatus } from './voice-transcriber.js';

function isAudioAttachment(type) {
  return type === 'voice' || type === 'audio';
}

function buildBasePrompt(message, filePath) {
  const lines = [`The user sent a Telegram ${message.type || 'file'} attachment.`, `Local file path: ${filePath}`];

  if (message.fileName) {
    lines.push(`Original filename: ${message.fileName}`);
  }
  if (message.mimeType) {
    lines.push(`MIME type: ${message.mimeType}`);
  }
  if (Number.isFinite(message.fileSizeBytes) && message.fileSizeBytes > 0) {
    lines.push(`File size bytes: ${message.fileSizeBytes}`);
  }
  if (Number.isFinite(message.durationSec) && message.durationSec > 0) {
    lines.push(`Duration seconds: ${message.durationSec}`);
  }

  return lines;
}

export async function createAttachmentHandler(options = {}) {
  const telegram = options.telegram;
  const downloadDir = options.downloadDir;

  if (!telegram) {
    throw new Error('Attachment handler requires a Telegram API instance.');
  }
  if (!downloadDir) {
    throw new Error('Attachment handler requires a download directory.');
  }

  const voiceTranscriber = await createVoiceTranscriber();

  return {
    voiceTranscriber,
    getStatusText() {
      return formatVoiceTranscriberStatus(voiceTranscriber);
    },
    isAudioAttachment,
    async createPrompt(message) {
      const fileId = String(message?.fileId || '').trim();
      if (!fileId) {
        throw new Error('Attachment is missing Telegram file ID.');
      }

      const downloadedPath = await telegram.downloadFile(fileId, downloadDir);
      const lines = buildBasePrompt(message, downloadedPath);
      const userText = String(message.caption || message.text || '').trim();

      if (isAudioAttachment(message.type) && voiceTranscriber.available) {
        try {
          const transcript = await voiceTranscriber.transcribeTelegramVoice(telegram, fileId);
          lines.push(`Transcription: ${transcript}`);
        } catch (error) {
          const messageText = error?.message ? String(error.message) : String(error);
          lines.push(`Transcription failed: ${messageText}`);
        }
      }

      lines.push('');
      if (userText) {
        lines.push(`User message: ${userText}`);
      } else {
        lines.push('User message: (none)');
      }
      lines.push('Please inspect the file and respond to the user.');

      return {
        downloadedPath,
        prompt: lines.join('\n'),
        transcriberStatus: formatVoiceTranscriberStatus(voiceTranscriber),
      };
    },
  };
}
