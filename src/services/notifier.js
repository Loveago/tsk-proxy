import axios from 'axios';
import { config, logger } from '../config/index.js';

export class NotifierService {
  constructor() {
    this.client = axios.create({ timeout: 5000 });
  }

  /**
   * Dispatches failure alerts to Discord and/or Telegram if configured.
   *
   * @param {object} alert
   * @param {string} alert.type - e.g. 'MAX_RETRIES_EXCEEDED', 'UNROUTABLE_EVENT', 'CALLBACK_VERIFICATION_FAILED'
   * @param {string} [alert.event]
   * @param {string} [alert.reference]
   * @param {string} [alert.siteKey]
   * @param {string} [alert.targetUrl]
   * @param {number} [alert.attempts]
   * @param {string} [alert.error]
   * @param {string} [alert.correlationId]
   */
  async notifyFailure(alert) {
    const promises = [];

    if (config.notifications.discordWebhookUrl) {
      promises.push(this.sendDiscordAlert(alert));
    }

    if (config.notifications.telegram.botToken && config.notifications.telegram.chatId) {
      promises.push(this.sendTelegramAlert(alert));
    }

    if (promises.length === 0) {
      logger.debug('No alert webhooks configured (Discord/Telegram skipped)');
      return;
    }

    try {
      await Promise.allSettled(promises);
    } catch (err) {
      logger.error({ err: err.message }, 'Unexpected error while dispatching notification alerts');
    }
  }

  /**
   * Sends alert to Discord webhook
   */
  async sendDiscordAlert(alert) {
    try {
      const isCritical = alert.type === 'MAX_RETRIES_EXCEEDED';
      const color = isCritical ? 15158332 : 16750848; // Red or Orange

      const fields = [
        { name: 'Event Type', value: alert.event || 'N/A', inline: true },
        { name: 'Site Key', value: alert.siteKey || 'Unknown / Unroutable', inline: true },
        { name: 'Reference', value: alert.reference || 'N/A', inline: true },
      ];

      if (alert.targetUrl) {
        fields.push({ name: 'Target URL', value: alert.targetUrl, inline: false });
      }

      if (typeof alert.attempts === 'number') {
        fields.push({ name: 'Total Attempts', value: String(alert.attempts), inline: true });
      }

      if (alert.correlationId) {
        fields.push({ name: 'Correlation ID', value: alert.correlationId, inline: true });
      }

      if (alert.error) {
        fields.push({
          name: 'Error Details',
          value: `\`\`\`${String(alert.error).slice(0, 900)}\`\`\``,
          inline: false,
        });
      }

      const payload = {
        username: 'Paystack Proxy Alert',
        embeds: [
          {
            title: `⚠️ Alert: ${alert.type.replace(/_/g, ' ')}`,
            description: `A webhook delivery or proxy operation failure occurred.`,
            color,
            fields,
            timestamp: new Date().toISOString(),
          },
        ],
      };

      await this.client.post(config.notifications.discordWebhookUrl, payload);
      logger.info({ alertType: alert.type, correlationId: alert.correlationId }, 'Discord alert sent successfully');
    } catch (err) {
      logger.error(
        {
          err: err.message,
          alertType: alert.type,
          correlationId: alert.correlationId,
        },
        'Failed to deliver alert to Discord webhook'
      );
    }
  }

  /**
   * Sends alert to Telegram channel or chat
   */
  async sendTelegramAlert(alert) {
    try {
      const token = config.notifications.telegram.botToken;
      const chatId = config.notifications.telegram.chatId;
      const url = `https://api.telegram.org/bot${token}/sendMessage`;

      const lines = [
        `⚠️ *Paystack Proxy Alert: ${alert.type.replace(/_/g, ' ')}*`,
        `*Event:* \`${alert.event || 'N/A'}\``,
        `*Site:* \`${alert.siteKey || 'Unknown'}\``,
        `*Reference:* \`${alert.reference || 'N/A'}\``,
      ];

      if (alert.targetUrl) {
        lines.push(`*Target URL:* ${alert.targetUrl}`);
      }

      if (typeof alert.attempts === 'number') {
        lines.push(`*Attempts:* ${alert.attempts}`);
      }

      if (alert.correlationId) {
        lines.push(`*Correlation ID:* \`${alert.correlationId}\``);
      }

      if (alert.error) {
        const sanitizedError = String(alert.error).replace(/[`*]/g, "'").slice(0, 500);
        lines.push(`*Error:* \`${sanitizedError}\``);
      }

      lines.push(`*Timestamp:* ${new Date().toISOString()}`);

      const payload = {
        chat_id: chatId,
        text: lines.join('\n'),
        parse_mode: 'Markdown',
      };

      await this.client.post(url, payload);
      logger.info({ alertType: alert.type, correlationId: alert.correlationId }, 'Telegram alert sent successfully');
    } catch (err) {
      logger.error(
        {
          err: err.message,
          alertType: alert.type,
          correlationId: alert.correlationId,
        },
        'Failed to deliver alert to Telegram'
      );
    }
  }
}

export const notifier = new NotifierService();
export default notifier;
